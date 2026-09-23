// Shared upstream discovery validation + WAF/CAPTCHA detection.
//
// Goal: NEVER treat an HTTP 200 as a successful discovery when the body is not
// a valid provider JSON payload. This module is provider-agnostic and is used
// by every provider's listModels()/discovery path (including any future
// provider) so the behaviour is uniform and never hardcoded to one vendor.
//
// It classifies each discovery attempt into a ProviderStatus, records per
// provider state (for health/debug endpoints), keeps the last-known-good model
// list so a failed refresh never wipes the registry, and applies exponential
// backoff when an upstream is blocked by a WAF/CAPTCHA.

export type ProviderStatus =
  | 'healthy'
  | 'degraded'
  | 'blocked_by_waf'
  | 'authentication_failed'
  | 'rate_limited'
  | 'timeout'
  | 'empty_model_list'
  | 'invalid_response'
  | 'invalid_json'
  | 'upstream_error';

/** Keywords that indicate an interstitial WAF / bot-challenge / CAPTCHA page. */
export const WAF_KEYWORDS: string[] = [
  'aliyun',
  'aliyun_waf',
  'aliyuncaptcha',
  'captcha',
  'slider',
  'verify',
  'cloudflare',
  'cf-chl',
  'access denied',
];

export interface DiscoveryOutcome {
  status: ProviderStatus;
  reason: string;
  httpStatus: number | null;
  contentType: string | null;
  responseBytes: number;
  responseTime: number;
  blockedByWAF: boolean;
  /** Parsed model list when status === 'healthy', otherwise []. */
  models: any[];
}

export interface ProviderDiscoveryState {
  provider: string;
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
  /** Number of models currently cached (last-known-good). */
  cachedModels: number;
}

interface InternalState extends ProviderDiscoveryState {
  lastGoodModels: any[];
  consecutiveWafFailures: number;
  nextAllowedDiscovery: number; // epoch ms; backoff gate for WAF-blocked upstreams
}

const WAF_BACKOFF_BASE_MS = 30_000;
const WAF_BACKOFF_MAX_MS = 15 * 60_000; // cap at 15 minutes

class DiscoveryStore {
  private states = new Map<string, InternalState>();

  private ensure(provider: string): InternalState {
    let s = this.states.get(provider);
    if (!s) {
      s = {
        provider,
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
        lastGoodModels: [],
        consecutiveWafFailures: 0,
        nextAllowedDiscovery: 0,
      };
      this.states.set(provider, s);
    }
    return s;
  }

  /** Record the result of a discovery attempt and update the last-good cache. */
  record(provider: string, outcome: DiscoveryOutcome): void {
    const s = this.ensure(provider);
    const now = Date.now();
    s.status = outcome.status;
    s.reason = outcome.reason;
    s.httpStatus = outcome.httpStatus;
    s.contentType = outcome.contentType;
    s.blockedByWAF = outcome.blockedByWAF;
    s.responseBytes = outcome.responseBytes;
    s.responseTime = outcome.responseTime;
    s.lastDiscovery = new Date(now).toISOString();

    if (outcome.status === 'healthy') {
      s.lastSuccess = new Date(now).toISOString();
      s.modelsDiscovered = outcome.models.length;
      s.lastGoodModels = outcome.models;
      s.cachedModels = outcome.models.length;
      s.consecutiveWafFailures = 0;
      s.nextAllowedDiscovery = 0;
    } else {
      // Preserve the previous cache; never wipe the registry on failure.
      s.cachedModels = s.lastGoodModels.length;
      if (outcome.blockedByWAF) {
        s.consecutiveWafFailures += 1;
        const backoff = Math.min(
          WAF_BACKOFF_MAX_MS,
          WAF_BACKOFF_BASE_MS * Math.pow(2, s.consecutiveWafFailures - 1),
        );
        s.nextAllowedDiscovery = now + backoff;
      }
    }
  }

  getLastGoodModels(provider: string): any[] {
    return this.ensure(provider).lastGoodModels;
  }

  hasCache(provider: string): boolean {
    return this.ensure(provider).lastGoodModels.length > 0;
  }

  /**
   * True when a WAF-blocked provider is still inside its backoff window and the
   * caller should skip hitting the upstream (avoid spamming the CAPTCHA).
   */
  shouldSkipForBackoff(provider: string): boolean {
    const s = this.ensure(provider);
    if (s.nextAllowedDiscovery === 0) return false;
    return Date.now() < s.nextAllowedDiscovery;
  }

  getBackoffRemainingMs(provider: string): number {
    const s = this.ensure(provider);
    return Math.max(0, s.nextAllowedDiscovery - Date.now());
  }

  getState(provider: string): ProviderDiscoveryState | undefined {
    const s = this.states.get(provider);
    if (!s) return undefined;
    const { lastGoodModels, consecutiveWafFailures, nextAllowedDiscovery, ...pub } = s;
    return pub;
  }

  getAllStates(): ProviderDiscoveryState[] {
    return Array.from(this.states.values())
      .map(({ lastGoodModels, consecutiveWafFailures, nextAllowedDiscovery, ...pub }) => pub)
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  reset(): void {
    this.states.clear();
  }
}

export const discoveryStore = new DiscoveryStore();

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

/** Detect whether a (raw) response body / content-type looks like a WAF page. */
export function detectWAF(contentType: string | null, rawText: string): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const lower = rawText.toLowerCase();
  const looksHtml = lower.trimStart().startsWith('<') || lower.includes('<!doctype') || lower.includes('<html');
  const keywordHit = WAF_KEYWORDS.some((k) => lower.includes(k));
  // Only treat keyword hits as WAF when the body is clearly not JSON (HTML-ish),
  // so a legitimate JSON payload that happens to contain a word is not flagged.
  return keywordHit && (looksHtml || ct === '' || ct.includes('text/plain'));
}

function statusFromError(error: any): { status: ProviderStatus; httpStatus: number | null; reason: string } {
  const httpStatus = error?.status ?? error?.response?.status ?? null;
  const code = error?.code ?? '';
  const msg = String(error?.message ?? 'unknown error');

  if (code === 'ECONNABORTED' || /timeout/i.test(msg) || code === 'ETIMEDOUT') {
    return { status: 'timeout', httpStatus, reason: `request timed out: ${msg}` };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'authentication_failed', httpStatus, reason: `auth failed (HTTP ${httpStatus})` };
  }
  if (httpStatus === 429) {
    return { status: 'rate_limited', httpStatus, reason: `rate limited (HTTP ${httpStatus})` };
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { status: 'upstream_error', httpStatus, reason: `upstream error (HTTP ${httpStatus})` };
  }
  return { status: 'upstream_error', httpStatus, reason: `request failed: ${msg}` };
}

export interface ClassifyInput {
  provider: string;
  url: string;
  elapsedMs: number;
  /** The axios-style response, when the request completed (any status). */
  response?: { status: number; headers?: Record<string, any>; data: any };
  /** The thrown error, when the request failed at transport level. */
  error?: any;
  /**
   * Provider-specific structural validator. Receives already-parsed JSON and
   * must return the model array if the structure is valid, or null if not.
   */
  extract: (data: any) => any[] | null;
}

/**
 * Classify a discovery attempt into a ProviderStatus + extracted models.
 * This is pure (no side effects); use recordDiscovery() to also persist state.
 */
export function classifyDiscovery(input: ClassifyInput): DiscoveryOutcome {
  const { elapsedMs } = input;

  if (input.error && !input.response) {
    const { status, httpStatus, reason } = statusFromError(input.error);
    const body = input.error?.response?.data;
    const rawText = body === undefined || body === null
      ? ''
      : (typeof body === 'string' ? body : safeStringify(body));
    const contentType = extractContentType(input.error?.response?.headers);
    // Even error responses can carry a WAF page (some WAFs use 4xx/5xx).
    const blockedByWAF = rawText ? detectWAF(contentType, rawText) : false;
    if (blockedByWAF) {
      return {
        status: 'blocked_by_waf',
        reason: 'upstream returned a WAF/CAPTCHA challenge page',
        httpStatus,
        contentType,
        responseBytes: byteLength(rawText),
        responseTime: elapsedMs,
        blockedByWAF: true,
        models: [],
      };
    }
    return {
      status,
      reason,
      httpStatus,
      contentType,
      responseBytes: byteLength(rawText),
      responseTime: elapsedMs,
      blockedByWAF: false,
      models: [],
    };
  }

  const response = input.response!;
  const httpStatus = response.status;
  const contentType = extractContentType(response.headers);
  const data = response.data;
  const rawText = typeof data === 'string' ? data : safeStringify(data);
  const responseBytes = byteLength(rawText);

  const base = { httpStatus, contentType, responseBytes, responseTime: elapsedMs };

  // 1. WAF / CAPTCHA / HTML interstitial — highest priority. A 200 with an HTML
  //    body is NOT an empty model list, it is a blocked upstream.
  if (detectWAF(contentType, rawText)) {
    return { ...base, status: 'blocked_by_waf', reason: 'HTML/CAPTCHA body detected (WAF challenge)', blockedByWAF: true, models: [] };
  }

  // 2. Non-2xx status that still returned a parseable-ish body.
  if (httpStatus < 200 || httpStatus >= 300) {
    const { status, reason } = statusFromError({ status: httpStatus, response });
    return { ...base, status, reason, blockedByWAF: false, models: [] };
  }

  // 3. Body arrived as a raw string but is not HTML -> must be valid JSON.
  let parsed: any = data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return { ...base, status: 'invalid_response', reason: 'empty response body', blockedByWAF: false, models: [] };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ...base, status: 'invalid_json', reason: 'response body is not valid JSON', blockedByWAF: false, models: [] };
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ...base, status: 'invalid_response', reason: 'JSON body is not an object/array', blockedByWAF: false, models: [] };
  }

  // 4. Provider-specific structural validation.
  const models = input.extract(parsed);
  if (models === null) {
    return { ...base, status: 'invalid_response', reason: 'JSON did not match expected provider schema', blockedByWAF: false, models: [] };
  }
  if (models.length === 0) {
    return { ...base, status: 'empty_model_list', reason: 'valid JSON but zero models returned', blockedByWAF: false, models: [] };
  }

  return { ...base, status: 'healthy', reason: `discovered ${models.length} models`, blockedByWAF: false, models };
}

function extractContentType(headers: any): string | null {
  if (!headers) return null;
  const ct = headers['content-type'] ?? headers['Content-Type'];
  return typeof ct === 'string' ? ct : null;
}

function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Standard OpenAI-style model-list extractor: accepts `{ data: [...] }` or a
 * bare array, returns normalized model objects, or null if the schema does not
 * match (so it is flagged invalid_response rather than an empty list).
 */
export function openAIModelExtractor(ownedByDefault: string): (data: any) => any[] | null {
  return (data: any) => {
    const list = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : null;
    if (list === null) return null;
    const now = Math.floor(Date.now() / 1000);
    return list
      .map((m: any) => ({
        id: typeof m === 'string' ? m : m?.id,
        object: 'model',
        created: (typeof m !== 'string' && m?.created) || now,
        owned_by: (typeof m !== 'string' && m?.owned_by) || ownedByDefault,
      }))
      .filter((m: any) => !!m.id);
  };
}

/**
 * Human-readable one-line discovery log covering everything an operator needs:
 * provider, URL, HTTP status, content-type, response size, result, reason,
 * elapsed time. HTML bodies are reported as "WAF DETECTED", never "0 models".
 */
export function logDiscovery(provider: string, url: string, outcome: DiscoveryOutcome): void {
  const resultLabel = outcome.blockedByWAF ? 'WAF DETECTED' : outcome.status.toUpperCase();
  console.log(
    `[DISCOVERY] Provider=${provider}  URL=${url}  HTTP=${outcome.httpStatus ?? 'n/a'}  ` +
    `ContentType=${outcome.contentType ?? 'n/a'}  Size=${outcome.responseBytes}B  ` +
    `Result=${resultLabel}  Reason=${outcome.reason}  Elapsed=${outcome.responseTime}ms`,
  );
}

/**
 * End-to-end discovery helper used by providers. It:
 *   - honours WAF backoff (skips the upstream call while blocked),
 *   - runs the request, classifies + records the outcome, logs it,
 *   - preserves the last-known-good model list on any failure.
 *
 * Returns the models to use (fresh when healthy, else last-good cache) plus the
 * outcome so the caller can decide how to shape its return payload.
 */
export async function runDiscovery(opts: {
  provider: string;
  url: string;
  request: () => Promise<{ status: number; headers?: Record<string, any>; data: any }>;
  extract: (data: any) => any[] | null;
  onHealthy?: (latencyMs: number) => void;
  onFailure?: (outcome: DiscoveryOutcome, error?: any) => void;
}): Promise<{ outcome: DiscoveryOutcome; models: any[]; fromCache: boolean; skipped: boolean }> {
  const { provider, url } = opts;

  if (discoveryStore.shouldSkipForBackoff(provider)) {
    const remaining = Math.round(discoveryStore.getBackoffRemainingMs(provider) / 1000);
    console.log(`[DISCOVERY] Provider=${provider}  SKIPPED (WAF backoff, ${remaining}s remaining) — using cached models`);
    const cached = discoveryStore.getLastGoodModels(provider);
    const existing = discoveryStore.getState(provider)!;
    return {
      outcome: {
        status: existing.status,
        reason: existing.reason,
        httpStatus: existing.httpStatus,
        contentType: existing.contentType,
        responseBytes: existing.responseBytes,
        responseTime: existing.responseTime,
        blockedByWAF: existing.blockedByWAF,
        models: [],
      },
      models: cached,
      fromCache: true,
      skipped: true,
    };
  }

  const start = Date.now();
  let outcome: DiscoveryOutcome;
  let error: any;
  try {
    const response = await opts.request();
    outcome = classifyDiscovery({ provider, url, elapsedMs: Date.now() - start, response, extract: opts.extract });
  } catch (e: any) {
    error = e;
    outcome = classifyDiscovery({ provider, url, elapsedMs: Date.now() - start, error: e, extract: opts.extract });
  }

  discoveryStore.record(provider, outcome);
  logDiscovery(provider, url, outcome);

  if (outcome.status === 'healthy') {
    opts.onHealthy?.(outcome.responseTime);
    return { outcome, models: outcome.models, fromCache: false, skipped: false };
  }

  opts.onFailure?.(outcome, error);
  const cached = discoveryStore.getLastGoodModels(provider);
  if (cached.length > 0) {
    console.log(`[DISCOVERY] Provider=${provider}  status=${outcome.status} — preserving ${cached.length} cached model(s)`);
  }
  return { outcome, models: cached, fromCache: cached.length > 0, skipped: false };
}
