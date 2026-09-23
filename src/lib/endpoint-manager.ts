export interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
}

export interface EndpointInfo {
  baseUrl: string;
  apiKey: string;
  index: number;
  maskedBaseUrl: string;
  maskedKey: string;
  tag: string;
}

interface EndpointStats {
  requestCount: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  lastUsed: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  disabledUntil: number | null;
  averageLatency: number;
  totalLatency: number;
  lastLatency: number | null;
}

/* Shared recovery cooldown (default 180s), aligned with key-manager +
 * provider-cooldown so Databricks endpoints recover on the same window. */
const COOLDOWN_DURATION = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

function maskBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split('.');
    if (parts.length >= 2) {
      return parts[0] + '...';
    }
    return parsed.hostname.slice(0, 8) + '...';
  } catch {
    return url.length > 8 ? url.slice(0, 8) + '...' : url;
  }
}

function createStats(): EndpointStats {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    retryCount: 0,
    lastUsed: null,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    disabledUntil: null,
    averageLatency: 0,
    totalLatency: 0,
    lastLatency: null,
  };
}

export class AllEndpointsCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllEndpointsCooldownError';
  }
}

export class EndpointManager {
  private configs: EndpointConfig[];
  private stats: EndpointStats[];
  private currentIndex: number = 0;
  private lock: Promise<void> = Promise.resolve();
  private providerName: string;

  constructor(configs: EndpointConfig[], providerName: string) {
    if (configs.length === 0) {
      throw new Error(`At least one endpoint is required for ${providerName}`);
    }
    this.configs = configs;
    this.stats = configs.map(() => createStats());
    this.providerName = providerName;

    const total = configs.length;
    console.log('===========================================');
    console.log(`=== ${providerName} Endpoints Loaded ===`);
    console.log(`Total endpoints: ${total}`);
    for (let i = 0; i < total; i++) {
      const info = this.getEndpointInfo(i);
      console.log(`  Endpoint #${i + 1}: ${info.maskedBaseUrl} key=${info.maskedKey}`);
    }
    if (total === 1) {
      console.warn('+++++++++++++++++++++++++++++++++++++++++++++++++++');
      console.warn(`WARNING: Only 1 ${providerName} endpoint loaded.`);
      console.warn('+++++++++++++++++++++++++++++++++++++++++++++++++++');
    }
    console.log('===========================================');
  }

  get endpointCount(): number {
    return this.configs.length;
  }

  getEndpointInfo(index: number): EndpointInfo {
    const cfg = this.configs[index];
    return {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      index,
      maskedBaseUrl: maskBaseUrl(cfg.baseUrl),
      maskedKey: maskKey(cfg.apiKey),
      tag: `Using ${this.providerName} Endpoint #${index + 1}`,
    };
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prevLock = this.lock;
    this.lock = nextLock;
    await prevLock;
    try {
      return fn();
    } finally {
      release!();
    }
  }

  async getNextEndpoint(): Promise<EndpointInfo> {
    return this.withLock(() => {
      const startIdx = this.currentIndex;
      const total = this.configs.length;

      for (let offset = 0; offset < total; offset++) {
        const idx = (startIdx + offset) % total;
        if (this.isAvailable(idx)) {
          this.currentIndex = (idx + 1) % total;
          this.stats[idx].requestCount++;
          this.stats[idx].lastUsed = Date.now();
          return this.getEndpointInfo(idx);
        }
      }
      throw new AllEndpointsCooldownError(`All ${this.providerName} endpoints are currently in cooldown`);
    });
  }

  markSuccess(index: number, latencyMs: number): void {
    this.stats[index].successCount++;
    this.stats[index].lastSuccess = Date.now();
    this.stats[index].lastLatency = latencyMs;
    this.stats[index].totalLatency += latencyMs;
    this.stats[index].averageLatency = Math.round(
      this.stats[index].totalLatency / this.stats[index].successCount,
    );
  }

  markFailure(index: number, error: string): void {
    this.stats[index].failureCount++;
    this.stats[index].lastFailure = Date.now();
    this.stats[index].lastError = error;
  }

  markRetry(index: number): void {
    this.stats[index].retryCount++;
  }

  markCooldown(index: number): void {
    this.stats[index].disabledUntil = Date.now() + COOLDOWN_DURATION;
  }

  refreshCooldowns(): void {
    const now = Date.now();
    for (let i = 0; i < this.configs.length; i++) {
      const du = this.stats[i].disabledUntil;
      if (du !== null && du <= now) {
        this.stats[i].disabledUntil = null;
      }
    }
  }

  health(): { totalEndpoints: number; activeEndpoints: number; cooldownEndpoints: number; requests: number; currentEndpoint: number } {
    const now = Date.now();
    let active = 0;
    let cooldown = 0;
    let requests = 0;

    for (let i = 0; i < this.configs.length; i++) {
      requests += this.stats[i].requestCount;
      const du = this.stats[i].disabledUntil;
      if (du !== null && du > now) {
        cooldown++;
      } else {
        active++;
      }
    }

    return {
      totalEndpoints: this.configs.length,
      activeEndpoints: active,
      cooldownEndpoints: cooldown,
      requests,
      currentEndpoint: this.currentIndex,
    };
  }

  async getEndpointPreferenceOrder(candidates: number[]): Promise<number[]> {
    return this.withLock(() => {
      const available = candidates.filter(idx => this.isAvailable(idx));
      available.sort((a, b) => (this.stats[a].averageLatency || 0) - (this.stats[b].averageLatency || 0));
      return available;
    });
  }

  isEndpointAvailable(index: number): boolean {
    return this.isAvailable(index);
  }

  getStats(): {
    id: number;
    baseUrl: string;
    active: boolean;
    cooldown: boolean;
    requests: number;
    success: number;
    failed: number;
    retry: number;
    averageLatency: number;
    lastLatency: number | null;
    lastError: string | null;
    lastUsed: number | null;
  }[] {
    return this.configs.map((cfg, i) => {
      const s = this.stats[i];
      const now = Date.now();
      return {
        id: i + 1,
        baseUrl: maskBaseUrl(cfg.baseUrl),
        active: s.disabledUntil === null || s.disabledUntil <= now,
        cooldown: s.disabledUntil !== null && s.disabledUntil > now,
        requests: s.requestCount,
        success: s.successCount,
        failed: s.failureCount,
        retry: s.retryCount,
        averageLatency: s.averageLatency,
        lastLatency: s.lastLatency,
        lastError: s.lastError,
        lastUsed: s.lastUsed,
      };
    });
  }

  private isAvailable(index: number): boolean {
    const du = this.stats[index].disabledUntil;
    if (du === null) return true;
    return Date.now() >= du;
  }
}
