// AgentRouter model cache. If discovery fails, the last-known-good list is
// preserved and the registry is NEVER emptied. Falls back to the static catalog
// when there is no prior cache.

import { CatalogModel } from './catalog';
import { MODEL_CACHE_TTL_MS } from './types';
import { cacheLog } from './logger';

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
}

export class AgentRouterCache {
  private entry: CacheEntry | null = null;

  /** The last-known-good models, or [] when never populated. */
  get(): CatalogModel[] {
    return this.entry ? this.entry.models : [];
  }

  set(models: CatalogModel[]): void {
    this.entry = { models, fetchedAt: Date.now() };
    cacheLog(`stored ${models.length} model(s)`);
  }

  /** Present AND still within the TTL window. */
  isFresh(now: number = Date.now()): boolean {
    return !!this.entry && now - this.entry.fetchedAt < MODEL_CACHE_TTL_MS;
  }

  clear(): void {
    this.entry = null;
  }

  size(): number {
    return this.entry ? this.entry.models.length : 0;
  }

  get source(): 'cache' | 'none' {
    return this.entry ? 'cache' : 'none';
  }
}

/** Simple per-vendor WAF backoff gate (exponential, local to AgentRouter). */
export class WafBackoff {
  private nextAllowedAt = 0;
  private consecutive = 0;

  constructor(private baseMs = 30_000, private maxMs = 15 * 60_000) {}

  recordWaf(): void {
    this.consecutive += 1;
    const delay = Math.min(this.baseMs * Math.pow(2, this.consecutive - 1), this.maxMs);
    this.nextAllowedAt = Date.now() + delay;
    cacheLog(`WAF backoff scheduled: ${Math.round(delay / 1000)}s`);
  }

  recordSuccess(): void {
    this.consecutive = 0;
    this.nextAllowedAt = 0;
  }

  shouldSkip(): boolean {
    return this.nextAllowedAt > 0 && Date.now() < this.nextAllowedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.nextAllowedAt - Date.now());
  }
}