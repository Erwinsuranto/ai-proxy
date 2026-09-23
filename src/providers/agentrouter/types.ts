// AgentRouter shared types & constants. Kept local to this provider so the
// implementation is fully self-contained — no AgentRouter-specific types leak
// into the rest of the codebase.

export type Protocol = 'openai' | 'anthropic';

/** A model entry in the static catalog (config/env or built-in default). */
export interface CatalogEntry {
  id: string;
  protocol?: Protocol;
}

/** Upstream endpoints (relative paths resolved against a base URL). */
export const OPENAI_CHAT_ENDPOINT = '/chat/completions';
export const ANTHROPIC_MESSAGES_ENDPOINT = '/messages';
export const MODELS_ENDPOINT = '/models';

export const PROVIDER_ID = 'agentrouter';
export const PROVIDER_NAME = 'AgentRouter';
export const COOLDOWN_DURATION_MS = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();
export const MODEL_CACHE_TTL_MS = 300_000;

/** Health / discovery status vocabulary for AgentRouter. */
export type ProviderStatus =
  | 'healthy'
  | 'degraded'
  | 'blocked_by_waf'
  | 'authentication_failed'
  | 'timeout'
  | 'rate_limited'
  | 'empty_catalog'
  | 'invalid_response'
  | 'invalid_json'
  | 'upstream_error';

export interface DiscoveryState {
  status: ProviderStatus;
  reason: string;
  httpStatus: number | null;
  contentType: string | null;
  blockedByWAF: boolean;
  responseBytes: number;
  responseTime: number;
  lastDiscovery: string | null;
  lastSuccess: string | null;
  modelsDiscovered: number;
  cachedModels: number;
  source: 'api' | 'cache' | 'static';
}