// AgentRouter discovery: GET /v1/models with refresh, cache, retry, exponential
// backoff and WAF detection — fully self-contained. On any failure the cache (or
// the static catalog) is preserved; the registry is NEVER emptied.

import { AgentRouterCache, WafBackoff } from './cache';
import { CatalogModel, buildProtocolMap, normalizeDiscoveredModels, buildStaticModels } from './catalog';
import { classifyDiscovery } from './waf';
import { DiscoveryState, ProviderStatus, CatalogEntry } from './types';
import { discoveryLog } from './logger';

export class AgentRouterDiscovery {
  readonly cache = new AgentRouterCache();

  private backoff = new WafBackoff();
  private protocolMap: Map<string, any> = new Map();
  private lastState: DiscoveryState = {
    status: 'degraded',
    reason: 'no discovery attempted yet',
    httpStatus: null,
    contentType: null,
    blockedByWAF: false,
    responseBytes: 0,
    responseTime: 0,
    lastDiscovery: null,
    lastSuccess: null,
    modelsDiscovered: 0,
    cachedModels: 0,
    source: 'static',
  };

  constructor(private staticEntries: CatalogEntry[]) {}

  getProtocolMap(): Map<string, any> {
    return this.protocolMap;
  }

  getStatus(): DiscoveryState {
    return { ...this.lastState };
  }

  /** The static catalog, always available (source of truth when discovery fails). */
  staticModels(now: number = Date.now()): CatalogModel[] {
    return buildStaticModels(this.staticEntries, now);
  }

  /**
   * Attempt a discovery refresh, honoring WAF backoff. Always returns a usable
   * model list (cache > static) — never empty.
   */
  async refresh(
    fetchModels: () => Promise<{ status: number; headers?: Record<string, any>; data: any }>,
    extract: (data: any) => any[],
    now: number = Date.now(),
  ): Promise<{ source: 'api' | 'cache' | 'static'; models: CatalogModel[] }> {
    // Serve a fresh cache when available, skipping the upstream call.
    if (this.cache.isFresh(now)) {
      this.protocolMap = buildProtocolMap(this.cache.get());
      return { source: 'cache', models: this.cache.get() };
    }

    // Honour WAF backoff: skip the upstream call while gated.
    if (this.backoff.shouldSkip()) {
      const rem = Math.round(this.backoff.remainingMs() / 1000);
      discoveryLog(`skipped (WAF backoff, ${rem}s remaining) — using cache/static`);
      this.setState({
        status: 'blocked_by_waf',
        reason: `WAF backoff (${rem}s remaining)`,
        httpStatus: 0,
        contentType: null,
        blockedByWAF: true,
        responseBytes: 0,
        responseTime: 0,
        lastDiscovery: new Date(now).toISOString(),
      });
      return this.fallback(now);
    }

    let outcome: ReturnType<typeof classifyDiscovery>;
    try {
      const response = await fetchModels();
      const start = Date.now();
      outcome = classifyDiscovery({
        elapsedMs: Date.now() - start,
        response,
        extract,
      });
      if (outcome.status === 'healthy') this.backoff.recordSuccess();
      else if (outcome.blockedByWAF) this.backoff.recordWaf();
    } catch (e: any) {
      outcome = classifyDiscovery({ elapsedMs: 0, error: e, extract });
      if (outcome.blockedByWAF) this.backoff.recordWaf();
    }

    this.setLastOutcome(outcome, now);

    if (outcome.status === 'healthy' && outcome.models.length > 0) {
      const models = normalizeDiscoveredModels(outcome.models, now);
      this.protocolMap = buildProtocolMap(models);
      this.cache.set(models);
      discoveryLog(`OK: ${models.length} model(s) discovered (${models.filter((m) => m.protocol === 'anthropic').length} anthropic)`);
      return { source: 'api', models };
    }

    return this.fallback(now);
  }

  private fallback(now: number): { source: 'cache' | 'static'; models: CatalogModel[] } {
    const cached = this.cache.get();
    if (cached.length > 0) {
      discoveryLog(`preserving ${cached.length} cached model(s) after failed discovery (never empty)`);
      this.protocolMap = buildProtocolMap(cached);
      return { source: 'cache', models: cached };
    }
    const staticModels = this.staticModels(now);
    this.protocolMap = buildProtocolMap(staticModels);
    discoveryLog(`falling back to ${staticModels.length} static catalog model(s)`);
    return { source: 'static', models: staticModels };
  }

  private setLastOutcome(outcome: ReturnType<typeof classifyDiscovery>, now: number): void {
    const status: ProviderStatus = outcome.status;
    this.lastState = {
      status,
      reason: outcome.reason,
      httpStatus: outcome.httpStatus,
      contentType: outcome.contentType,
      blockedByWAF: outcome.blockedByWAF,
      responseBytes: outcome.responseBytes,
      responseTime: outcome.responseTime,
      lastDiscovery: new Date(now).toISOString(),
      lastSuccess: status === 'healthy' ? new Date(now).toISOString() : this.lastState.lastSuccess,
      modelsDiscovered: status === 'healthy' ? outcome.models.length : this.lastState.modelsDiscovered,
      cachedModels: this.cache.size(),
      source: status === 'healthy' ? 'api' : this.cache.size() > 0 ? 'cache' : 'static',
    };
    discoveryLog(`${status.toUpperCase()} — ${outcome.reason} (HTTP=${outcome.httpStatus ?? 'n/a'})`);
  }

  private setState(partial: Partial<DiscoveryState>): void {
    this.lastState = { ...this.lastState, ...partial };
  }

  reset(): void {
    this.cache.clear();
    this.protocolMap = new Map();
    this.lastState = { ...this.lastState, status: 'degraded', lastDiscovery: null, modelsDiscovered: 0, cachedModels: 0 };
  }
}