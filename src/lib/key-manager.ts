import { KeyStats, createStats, recordRequest, getPublicStats } from './stats';
import { getComboContext } from './combo-context';

/* Shared recovery cooldown (default 180s). All cooldown mechanisms read the
 * same value so no path can retry a provider faster than the window. */
const COOLDOWN_DURATION = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

export interface KeyInfo {
  key: string;
  index: number;
  masked: string;
  tag: string;
}

export class KeyManager {
  private keyList: string[];
  private keyStats: KeyStats[];
  /** Admin-managed enable/disable flags (independent from 429 cooldowns). */
  private disabledFlags: boolean[];
  /** Raw values added at runtime via addKey() (UI-managed, removable). */
  private managedKeys: Set<string> = new Set();
  private currentIndex: number = 0;
  private lock: Promise<void> = Promise.resolve();
  private providerName: string;

  constructor(keys: string[], providerName: string) {
    if (keys.length === 0) {
      throw new Error(`At least one API key is required for ${providerName}`);
    }
    this.keyList = keys;
    this.keyStats = keys.map(() => createStats());
    this.disabledFlags = keys.map(() => false);
    this.providerName = providerName;

    const total = keys.length;
    console.log('===========================================');
    console.log(`=== ${providerName} API Keys Loaded ===`);
    console.log(`Total keys: ${total}`);
    for (let i = 0; i < total; i++) {
      const info = this.getKey(i);
      console.log(`${info.tag}: ${info.masked}`);
    }
    if (total === 1) {
      console.warn('+++++++++++++++++++++++++++++++++++++++++++++++++++');
      console.warn(`WARNING:`);
      console.warn(`Only 1 ${providerName} API key loaded.`);
      console.warn('Round-robin disabled.');
      console.warn('Check environment variable loading.');
      console.warn('+++++++++++++++++++++++++++++++++++++++++++++++++++');
    }
    console.log('===========================================');
  }

  get keyCount(): number {
    return this.keyList.length;
  }

  /* ---------------- Dynamic key management (Admin UI integration) ---------
   * These mutations keep the SAME KeyManager instance referenced by provider
   * instances, so added/removed keys take effect for new requests immediately
   * without re-initializing providers or dropping in-flight requests. */

  /** Adds a key to the rotation and marks it UI-managed. Returns its new index. */
  addKey(key: string): number {
    if (this.keyList.includes(key)) return this.keyList.indexOf(key);
    this.keyList.push(key);
    this.keyStats.push(createStats());
    this.disabledFlags.push(false);
    this.managedKeys.add(key);
    console.log(`[KeyManager] ${this.providerName} key added: ${this.getKey(this.keyList.length - 1).masked} (total=${this.keyList.length})`);
    return this.keyList.length - 1;
  }

  /** True when the raw key was added via addKey() (UI-managed) rather than
   *  seeded from environment config. */
  isManagedKey(key: string): boolean {
    return this.managedKeys.has(key);
  }

  /** Removes a key from the rotation (by raw value). Returns false when the
   *  key is unknown or is the last remaining key. */
  removeKeyByValue(key: string): boolean {
    const idx = this.keyList.indexOf(key);
    if (idx === -1) return false;
    if (this.keyList.length <= 1) {
      console.warn(`[KeyManager] ${this.providerName}: refusing to remove the last remaining key`);
      return false;
    }
    this.keyList.splice(idx, 1);
    this.keyStats.splice(idx, 1);
    this.disabledFlags.splice(idx, 1);
    this.managedKeys.delete(key);
    if (idx < this.currentIndex) {
      this.currentIndex = Math.max(0, this.currentIndex - 1);
    }
    if (this.currentIndex >= this.keyList.length) this.currentIndex = 0;
    console.log(`[KeyManager] ${this.providerName} key removed: ${maskKey(key)} (total=${this.keyList.length})`);
    return true;
  }

  /** True when the exact raw key is currently in the rotation. */
  hasRawKey(key: string): boolean {
    return this.keyList.includes(key);
  }

  private setDisabledFlagByValue(key: string, disabled: boolean): boolean {
    const idx = this.keyList.indexOf(key);
    if (idx === -1) return false;
    this.disabledFlags[idx] = disabled;
    return true;
  }

  /** Disables a key: it stays stored but is skipped by new requests.
   *  Returns false when the key is unknown. */
  disableKeyByValue(key: string): boolean {
    return this.setDisabledFlagByValue(key, true);
  }

  /** Re-enables a previously disabled key. Returns false when unknown. */
  enableKeyByValue(key: string): boolean {
    return this.setDisabledFlagByValue(key, false);
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

  getKey(index: number): { key: string; masked: string; tag: string } {
    const key = this.keyList[index];
    return {
      key,
      masked: maskKey(key),
      tag: `Using ${this.providerName} Key #${index + 1}`,
    };
  }

  async getNextKey(): Promise<KeyInfo> {
    return this.withLock(() => {
      const startIdx = this.currentIndex;
      const total = this.keyList.length;

      /* COMBO credential pin: when the request carries an active combo that
       * names a specific provider API key, start rotation from THAT credential.
       * The raw value must be present in THIS provider's own pool (combos can
       * never reference another provider's key — enforced at resolution time;
       * a miss here falls through to normal rotation, never to foreign keys).
       * If the pinned key is cooling down / admin-disabled, rotation continues
       * with the provider's OTHER keys — same-provider multi-key only. */
      const pinnedIdx = this.comboPinnedIndex();
      if (pinnedIdx >= 0 && this.isKeyAvailable(pinnedIdx)) {
        this.currentIndex = (pinnedIdx + 1) % total;
        const keyInfo = this.getKey(pinnedIdx);
        recordRequest(this.keyStats[pinnedIdx]);
        console.log(`[KeyManager] ${this.providerName}: combo pinning credential → Key#${pinnedIdx + 1}`);
        return { ...keyInfo, index: pinnedIdx };
      }

      for (let offset = 0; offset < total; offset++) {
        const idx = (startIdx + offset) % total;
        if (this.isKeyAvailable(idx)) {
          this.currentIndex = (idx + 1) % total;
          const keyInfo = this.getKey(idx);
          recordRequest(this.keyStats[idx]);
          return { ...keyInfo, index: idx };
        }
      }
      throw new AllKeysCooldownError(`All API keys for the requested model are currently in cooldown. Please retry later.`);
    });
  }

  async getFirstActiveKey(): Promise<KeyInfo> {
    return this.withLock(() => {
      /* COMBO credential pin (see getNextKey): same-provider credential only;
       * unavailable pinned keys fall through to the normal first-active pick. */
      const pinnedIdx = this.comboPinnedIndex();
      if (pinnedIdx >= 0 && this.isKeyAvailable(pinnedIdx)) {
        const keyInfo = this.getKey(pinnedIdx);
        recordRequest(this.keyStats[pinnedIdx]);
        console.log(`[KeyManager] ${this.providerName}: combo pinning credential → Key#${pinnedIdx + 1}`);
        return { ...keyInfo, index: pinnedIdx };
      }
      for (let i = 0; i < this.keyList.length; i++) {
        if (this.isKeyAvailable(i)) {
          const keyInfo = this.getKey(i);
          recordRequest(this.keyStats[i]);
          return { ...keyInfo, index: i };
        }
      }
      throw new AllKeysCooldownError(`All API keys for the requested model are currently in cooldown. Please retry later.`);
    });
  }

  /** Index of the combo-pinned raw credential inside THIS provider's pool,
   *  or -1 when the request has no combo pin (or the key is not ours — a
   *  cross-provider reference can never match by construction). */
  private comboPinnedIndex(): number {
    const combo = getComboContext();
    if (!combo?.providerRawKey) return -1;
    return this.keyList.indexOf(combo.providerRawKey);
  }

  markSuccess(index: number, latencyMs: number): void {
    this.keyStats[index].successCount++;
    this.keyStats[index].lastSuccess = Date.now();
    this.keyStats[index].totalLatency += latencyMs;
    this.keyStats[index].averageLatency = Math.round(
      this.keyStats[index].totalLatency / this.keyStats[index].successCount,
    );
  }

  markFailure(index: number, error: string): void {
    this.keyStats[index].failureCount++;
    this.keyStats[index].lastFailure = Date.now();
    this.keyStats[index].lastError = error;
  }

  markRetry(index: number): void {
    this.keyStats[index].retryCount++;
  }

  markCooldown(index: number): void {
    this.keyStats[index].disabledUntil = Date.now() + COOLDOWN_DURATION;
    const tag = this.getKey(index).tag;
    console.log(`[COOLDOWN] ${tag}  Reason=429  Duration=${COOLDOWN_DURATION / 1000}s`);
  }

  resetCooldowns(): void {
    for (let i = 0; i < this.keyList.length; i++) {
      this.keyStats[i].disabledUntil = null;
    }
  }

  getCurrentKeyIndex(): number {
    return this.currentIndex;
  }

  refreshCooldowns(): void {
    const now = Date.now();
    for (let i = 0; i < this.keyList.length; i++) {
      const du = this.keyStats[i].disabledUntil;
      if (du !== null && du <= now) {
        this.keyStats[i].disabledUntil = null;
      }
    }
  }

  availableKeys(): number[] {
    return this.keyList
      .map((_, i) => i)
      .filter((i) => this.isKeyAvailable(i));
  }

  health(): { totalKeys: number; activeKeys: number; cooldownKeys: number; disabledKeys: number; requests: number; currentKey: number } {
    const now = Date.now();
    let activeKeys = 0;
    let cooldownKeys = 0;
    let disabledKeys = 0;
    let requests = 0;

    for (let i = 0; i < this.keyList.length; i++) {
      requests += this.keyStats[i].requestCount;
      if (this.disabledFlags[i]) {
        disabledKeys++;
        continue;
      }
      const du = this.keyStats[i].disabledUntil;
      if (du !== null && du > now) {
        cooldownKeys++;
      } else {
        activeKeys++;
      }
    }

    return { totalKeys: this.keyList.length, activeKeys, cooldownKeys, disabledKeys, requests, currentKey: this.currentIndex };
  }

  getStats(): { id: number; active: boolean; cooldown: boolean; requests: number; success: number; failed: number; retry: number; averageLatency: number }[] {
    return this.keyList.map((_, i) => getPublicStats(i, this.keyStats[i]));
  }

  private isKeyAvailable(index: number): boolean {
    if (this.disabledFlags[index]) return false;
    const disabledUntil = this.keyStats[index].disabledUntil;
    if (disabledUntil === null) return true;
    return Date.now() >= disabledUntil;
  }
}

export class AllKeysCooldownError extends Error {
  /** Safe to forward to clients: message is provider-agnostic (this gateway
   *  owns the wording — no providerName, no upstream detail). */
  clientSafe = true;

  constructor(message: string) {
    super(message);
    this.name = 'AllKeysCooldownError';
  }
}
