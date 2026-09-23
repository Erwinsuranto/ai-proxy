import { registry } from '../providers/registry';

export type Strategy = 'round_robin' | 'priority' | 'random' | 'fastest' | 'least_latency';

export interface BackendConfig {
  provider: string;
  model: string;
}

export interface VirtualRouteConfig {
  virtualModel: string;
  strategy: Strategy;
  backends: BackendConfig[];
}

interface BackendHealth {
  healthy: boolean;
  disabledUntil: number | null;
  successCount: number;
  failureCount: number;
  lastLatency: number | null;
  averageLatency: number;
  totalLatency: number;
  lastError: string | null;
}

/* Shared recovery cooldown (default 180s), aligned with key-manager +
 * provider-cooldown so virtual backends recover on the same window. */
const COOLDOWN_MS = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();

export class NoAvailableBackendError extends Error {
  constructor(virtualModel: string) {
    super(`No available backends for virtual model "${virtualModel}"`);
    this.name = 'NoAvailableBackendError';
  }
}

export class AllBackendsFailedError extends Error {
  constructor(virtualModel: string) {
    super(`All backends failed for virtual model "${virtualModel}"`);
    this.name = 'AllBackendsFailedError';
  }
}

export class VirtualRouter {
  private routes: Map<string, VirtualRouteConfig> = new Map();
  private health: Map<string, BackendHealth[]> = new Map();
  private counters: Map<string, number> = new Map();

  addRoute(config: VirtualRouteConfig): void {
    this.routes.set(config.virtualModel, config);
    this.health.set(
      config.virtualModel,
      config.backends.map(() => ({
        healthy: true,
        disabledUntil: null,
        successCount: 0,
        failureCount: 0,
        lastLatency: null,
        averageLatency: 0,
        totalLatency: 0,
        lastError: null,
      })),
    );
    this.counters.set(config.virtualModel, 0);
  }

  addRoutes(configs: VirtualRouteConfig[]): void {
    for (const c of configs) {
      this.addRoute(c);
    }
  }

  getRoute(model: string): VirtualRouteConfig | null {
    return this.routes.get(model) ?? null;
  }

  getAllVirtualModels(): string[] {
    return Array.from(this.routes.keys());
  }

  getBackendOrder(virtualModel: string): number[] {
    const config = this.routes.get(virtualModel);
    if (!config) return [];

    const healthArr = this.health.get(virtualModel)!;
    const now = Date.now();

    const available = healthArr
      .map((h, i) => ({ health: h, index: i }))
      .filter((entry) => {
        if (entry.health.disabledUntil !== null && now < entry.health.disabledUntil) return false;
        return true;
      });

    if (available.length === 0) {
      return config.backends.map((_, i) => i);
    }

    switch (config.strategy) {
      case 'priority': {
        return available.map((a) => a.index);
      }
      case 'round_robin': {
        const counter = this.counters.get(virtualModel) ?? 0;
        this.counters.set(virtualModel, (counter + 1) % config.backends.length);
        const result: number[] = [];
        for (let offset = 0; offset < available.length; offset++) {
          const idx = available[(counter + offset) % available.length].index;
          result.push(idx);
        }
        return result;
      }
      case 'random': {
        const shuffled = [...available].sort(() => Math.random() - 0.5);
        return shuffled.map((a) => a.index);
      }
      case 'fastest':
      case 'least_latency': {
        const sorted = [...available].sort((a, b) => (a.health.averageLatency || 0) - (b.health.averageLatency || 0));
        return sorted.map((a) => a.index);
      }
      default:
        return available.map((a) => a.index);
    }
  }

  markSuccess(virtualModel: string, backendIdx: number, latencyMs: number): void {
    const h = this.health.get(virtualModel);
    if (!h || !h[backendIdx]) return;
    h[backendIdx].successCount++;
    h[backendIdx].lastLatency = latencyMs;
    h[backendIdx].totalLatency += latencyMs;
    h[backendIdx].averageLatency = Math.round(h[backendIdx].totalLatency / h[backendIdx].successCount);
    h[backendIdx].lastError = null;
    h[backendIdx].disabledUntil = null;
  }

  markFailure(virtualModel: string, backendIdx: number, error: any): void {
    const h = this.health.get(virtualModel);
    if (!h || !h[backendIdx]) return;
    h[backendIdx].failureCount++;
    h[backendIdx].lastError = error?.message ?? String(error);

    const status = error?.status ?? error?.response?.status ?? 0;
    if (status === 429 || status === 503 || status >= 500) {
      h[backendIdx].disabledUntil = Date.now() + COOLDOWN_MS;
    }
  }

  getBackendHealth(virtualModel: string): BackendHealth[] | null {
    return this.health.get(virtualModel) ?? null;
  }

  getRouteConfig(virtualModel: string): VirtualRouteConfig | null {
    return this.routes.get(virtualModel) ?? null;
  }

  getStrategies(): string {
    const lines: string[] = [];
    for (const [model, config] of this.routes) {
      const healthArr = this.health.get(model);
      const backendStatus = config.backends.map((b, i) => {
        const h = healthArr?.[i];
        const status = h?.disabledUntil && Date.now() < h.disabledUntil ? 'COOLDOWN' : 'ACTIVE';
        return `    [${status}] ${b.provider} → upstream=${b.model} (ok=${h?.successCount ?? 0} fail=${h?.failureCount ?? 0} avg=${h?.averageLatency ?? 0}ms)`;
      });
      lines.push(`  ${model} (strategy=${config.strategy})`);
      lines.push(...backendStatus);
    }
    return lines.join('\n');
  }
}

export function createVirtualRouter(configs: VirtualRouteConfig[]): VirtualRouter {
  const router = new VirtualRouter();
  router.addRoutes(configs);
  return router;
}
