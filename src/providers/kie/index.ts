// Kie.ai provider — one provider, three routes (Gemini / Claude / Codex).
//
// Runtime dispatch is provider-encapsulated but fully generic underneath:
//   payload.model -> provider-routes.resolveRoute (scoped to 'kie.ai only)
//   route.protocol -> protocol-registry adapter (never a provider-name branch)
//   url = baseUrl + route.path (built by buildRouteUrl, SSRF-validated)
//
// The gateway core (services/provider.ts) keeps treating this instance as an
// ordinary single Provider: it receives OpenAI Chat payloads and returns
// OpenAI Chat completions / chat SSE. All translation happens here.

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isQuotaError } from '../../lib/retry';
import { logRequest, logSuccessLatency, logRateLimited, logRetry } from '../../lib/logger';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';
import { getComboContext } from '../../lib/combo-context';
import {
  resolveRoute,
  getRoute,
  routeMatchesModel,
  buildRouteUrl,
  registerProviderRoutes,
  RouteConfig,
  RouteResolutionError,
} from '../../lib/provider-routes';
import { KIE_PROVIDER_ID, KIE_ROUTES } from '../../lib/kie-routes';
import { buildOpenAIChatRequest } from '../../lib/adapters/openai-chat';
import {
  buildResponsesRequest,
  parseResponsesResponse,
  normalizeResponsesError,
  createResponsesToOpenAIStream,
  chatCompletionToOpenAIStream,
} from '../../lib/adapters/openai-responses';
import {
  openaiToAnthropic,
  anthropicToOpenAI,
  createAnthropicToOpenAIStream,
  normalizeAnthropicError,
} from '../../lib/adapters/anthropic-messages';
import {
  buildGeminiRequest,
  parseGeminiResponse,
  normalizeGeminiError,
  createGeminiToOpenAIStream,
} from '../../lib/adapters/gemini';
import { runDiscovery, discoveryStore, openAIModelExtractor } from '../../lib/discovery';
import { KIE_STATIC_MODELS, KIE_CODEX_MODELS_ENDPOINT } from './models';

const PROVIDER_INFO: ProviderInfo = {
  providerId: KIE_PROVIDER_ID,
  providerName: 'Kie.ai',
};

const ANTHROPIC_VERSION = '2023-06-01';
const MODELS_CACHE_TTL_MS = 300_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/* Same-key retry policy for transient Kie.ai failures (measured 2026-09-13:
 * HTTP 500 is intermittent ~15-20%; an immediate retry can 500 again, while a
 * retry after ~1.5s succeeds consistently; normal latency ~3.7s/request).
 *  - KIE_MAX_ATTEMPTS counts TOTAL attempts per request (1 initial + retries).
 *  - Fixed 1500ms delay between attempts (no jitter, no exponential backoff).
 *  - Retry ONLY transient errors; every 4xx fails fast on the first attempt.
 *  - All attempts of one request reuse the SAME key (no mid-retry rotation).
 *  - This is the ONLY retry loop for this provider: non-streaming calls and
 *    stream establishment share it, so attempts never multiply across layers.
 *    The kie-codex buffered stream fallback below is a distinct non-streaming
 *    request (shape change, existing behavior), not a retry of the same call —
 *    each request shape is still capped at KIE_MAX_ATTEMPTS by this one loop. */
export const KIE_MAX_ATTEMPTS = 3;
export const KIE_RETRY_DELAY_MS = 1500;

let cachedModels: any[] | null = null;
let lastModelFetch = 0;

/** Clears the in-memory model cache (used by tests). */
export function __resetKieModelCache(): void {
  cachedModels = null;
  lastModelFetch = 0;
}

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createKieKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'Kie.ai');
}

/** True when retrying the SAME key can plausibly fix the failure.
 *  Retryable: HTTP 500/502/503, HTTP 504 (timeout-class), transport timeouts
 *  and network/connection errors without an HTTP status.
 *  NEVER retryable: every 4xx (400/401/403/404/409/422/...) — client,
 *  validation, model and authentication errors fail fast. Quota/rate-limit
 *  (429 or quota text) is handled by the cooldown path before this is asked. */
export function isTransientKieError(error: any): boolean {
  const status = getStatus(error);
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (status !== 0) return false;
  const code = String((error as any)?.code ?? '').toUpperCase();
  if (
    code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
    code === 'EPIPE' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH'
  ) return true;
  const msg = String(error?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') || msg.includes('timed out') ||
    msg.includes('network error') || msg.includes('socket hang up') ||
    msg.includes('econn') || msg.includes('enotfound') || msg.includes('eai_again') ||
    msg.includes('epipe') || msg.includes('enetunreach') || msg.includes('ehostunreach')
  );
}

/* Plain global setTimeout so tests can drive the delay deterministically with
 * fake timers. Always called with KIE_RETRY_DELAY_MS. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All Kie.ai keys are currently in cooldown. Please wait before retrying.');
  err.status = 429;
  err.type = 'rate_limit_error';
  return err;
}

function wrapError(error: any): any {
  if (error && error.status) return error;
  const status = getStatus(error) || 500;
  let errorBody: any = error?.response?.data;
  if (typeof errorBody === 'string') {
    try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
  }
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'Kie.ai error';
  const err: any = new Error(`Kie.ai API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

interface UpstreamCall {
  url: string;
  body: any;
  headers: Record<string, string>;
  protocol: string;
  routeId: string;
}

export class KieProvider implements Provider {
  private client: AxiosInstance;
  private keyManager: KeyManager;
  private baseUrl: string;
  private timeout: number;

  constructor(keyManager: KeyManager, baseUrl: string, timeout: number) {
    this.keyManager = keyManager;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout,
      headers: { 'Content-Type': 'application/json' },
    });
    // Route declarations are data (kie-routes.ts); registration here only
    // makes them visible to the generic resolver. Idempotent on re-init.
    registerProviderRoutes(KIE_ROUTES);
  }

  getProviderInfo(): ProviderInfo {
    return PROVIDER_INFO;
  }

  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Resolve the route for a backend model within THIS provider only.
   * An explicit combo routeId pin wins over model matching and is never
   * rewritten to another route; a pinned route that is missing/disabled or
   * does not serve the model fails clearly instead of falling back.
   */
  resolveRouteFor(model: string): { route: RouteConfig; backendModel: string } {
    const combo = getComboContext();
    if (combo && combo.providerId === KIE_PROVIDER_ID && combo.routeId) {
      const pinned = getRoute(KIE_PROVIDER_ID, combo.routeId);
      if (!pinned) {
        const err: any = new Error(`Combo route "${combo.routeId}" is not registered for provider "${KIE_PROVIDER_ID}"`);
        err.status = 400;
        err.clientSafe = true;
        throw err;
      }
      if (!pinned.enabled) {
        const err: any = new Error(`Combo route "${pinned.id}" is disabled`);
        err.status = 400;
        err.clientSafe = true;
        throw err;
      }
      if (!routeMatchesModel(pinned, model)) {
        const err: any = new Error(`Combo route "${pinned.id}" does not serve model "${model}"`);
        err.status = 400;
        err.clientSafe = true;
        throw err;
      }
      return { route: pinned, backendModel: model };
    }
    return resolveRoute(KIE_PROVIDER_ID, model);
  }

  /** Build the upstream call from route protocol (generic adapter dispatch). */
  buildUpstreamCall(chatPayload: any, backendModel: string): UpstreamCall {
    const { route } = this.resolveRouteFor(backendModel);
    const url = buildRouteUrl(this.baseUrl, route.path, backendModel);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    switch (route.protocol) {
      case 'gemini': {
        const { body } = buildGeminiRequest(chatPayload, backendModel);
        return { url, body, headers, protocol: route.protocol, routeId: route.id };
      }
      case 'anthropic-messages': {
        const body = openaiToAnthropic({ ...chatPayload, model: backendModel });
        headers['anthropic-version'] = ANTHROPIC_VERSION;
        return { url, body, headers, protocol: route.protocol, routeId: route.id };
      }
      case 'openai-responses': {
        const body = buildResponsesRequest(chatPayload, backendModel);
        /* kie-codex ONLY: the route answers HTTP 500 to ANY `tool_choice`
         * value (string "auto" and {"type":"function",...} both verified),
         * while the same request without the field succeeds. Omitting it
         * keeps the upstream default (auto) so tool use still works. */
        if (route.id === 'kie-codex') delete body.tool_choice;
        return { url, body, headers, protocol: route.protocol, routeId: route.id };
      }
      case 'openai-chat':
      default: {
        const body = buildOpenAIChatRequest({ ...chatPayload, model: backendModel });
        return { url, body, headers, protocol: 'openai-chat', routeId: route.id };
      }
    }
  }

  private buildHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
    return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(extra ?? {}) };
  }

  private normalizeUpstreamError(protocol: string, error: any): { status: number; quota: boolean } {
    switch (protocol) {
      case 'gemini':
        return normalizeGeminiError(error);
      case 'anthropic-messages':
        return normalizeAnthropicError(error);
      case 'openai-responses':
        return normalizeResponsesError(error);
      default:
        return { status: getStatus(error) || 500, quota: isQuotaError(error) };
    }
  }

  private async executeWithKey<T>(
    model: string,
    protocol: string,
    routeId: string,
    url: string,
    requestFn: (key: string) => Promise<T>,
  ): Promise<{ result: T; keyIndex: number; tag: string }> {
    // ONE key per logical request: rotation stays with KeyManager (next
    // request), retries below always reuse keyInfo.key.
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) throw createAllKeysCooldownError();
      throw e;
    }

    logRequest(keyInfo.tag, model);
    console.log(`[KIE] Base URL: ${this.baseUrl}`);
    console.log(`[KIE] Route: ${routeId} (protocol=${protocol})`);
    console.log(`[KIE] Endpoint: POST ${url}`);
    console.log(`[KIE] Backend model: ${model}`);
    console.log(`[KIE] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);

    const start = Date.now();
    let lastError: any = null;
    for (let attempt = 1; attempt <= KIE_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await requestFn(keyInfo.key);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[KIE][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        return { result, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        lastError = error;
        const status = getStatus(error);
        const normalized = this.normalizeUpstreamError(protocol, error);
        // Quota/rate-limit: cooldown + fail fast (never retried on same key).
        if (isQuotaError(error) || normalized.quota) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, 60);
          console.log(`[KIE][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=60s`);
          throw wrapError(error);
        }
        // Transient with budget left: same-key retry after a fixed delay.
        // Key stats are marked ONCE for the final outcome below, never per
        // attempt, so one flaky request never counts as several failures.
        if (attempt < KIE_MAX_ATTEMPTS && isTransientKieError(error)) {
          this.keyManager.markRetry(keyInfo.index);
          logRetry(keyInfo.tag, `${status}`);
          console.log(`[KIE][KEY#${keyInfo.index + 1}] Status=${status}  Transient  Retry=${attempt + 1}/${KIE_MAX_ATTEMPTS}  Delay=${KIE_RETRY_DELAY_MS}ms  Model=${model}`);
          await sleep(KIE_RETRY_DELAY_MS);
          continue;
        }
        // Non-transient (all 4xx, validation, auth) or budget exhausted.
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[KIE][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        throw wrapError(error);
      }
    }
    // Unreachable: the loop always returns or throws. Kept for type safety;
    // surfaces the final upstream error unchanged when reached.
    throw wrapError(lastError);
  }

  private parseUpstreamResponse(protocol: string, raw: any, backendModel: string): any {
    const { body } = parseResponseBody(raw);
    const source = body ?? raw;
    switch (protocol) {
      case 'gemini':
        return parseGeminiResponse(source, backendModel);
      case 'anthropic-messages':
        return anthropicToOpenAI(source, backendModel);
      case 'openai-responses':
        return parseResponsesResponse(source, backendModel);
      default:
        return source;
    }
  }

  async chatCompletion(payload: any): Promise<any> {
    const backendModel = payload?.model;
    if (!backendModel) {
      const err: any = new Error('model is required');
      err.status = 400;
      throw err;
    }
    let call: UpstreamCall;
    try {
      call = this.buildUpstreamCall(payload, backendModel);
    } catch (e: any) {
      if (e instanceof RouteResolutionError) {
        const err: any = new Error(e.message);
        err.status = 400;
        err.clientSafe = true;
        throw err;
      }
      throw e;
    }
    const raw = (await this.executeWithKey(backendModel, call.protocol, call.routeId, call.url, (key) =>
      this.client.post(call.url, call.body, {
        headers: this.buildHeaders(key, call.protocol === 'anthropic-messages'
          ? { 'anthropic-version': ANTHROPIC_VERSION }
          : undefined),
      }).then((r) => r.data),
    )).result;
    const parsed = this.parseUpstreamResponse(call.protocol, raw, backendModel);
    const { text, location } = findTextInResponse(parsed);
    console.log(`[KIE] Extracted text via ${location} for model ${backendModel}`);
    return parsed;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    return JSON.stringify(await this.chatCompletion(payload));
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const backendModel = payload?.model;
    if (!backendModel) {
      const err: any = new Error('model is required');
      err.status = 400;
      throw err;
    }
    let call: UpstreamCall;
    try {
      call = this.buildUpstreamCall({ ...payload, stream: true }, backendModel);
    } catch (e: any) {
      if (e instanceof RouteResolutionError) {
        const err: any = new Error(e.message);
        err.status = 400;
        err.clientSafe = true;
        throw err;
      }
      throw e;
    }

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) throw createAllKeysCooldownError();
      throw e;
    }

    logRequest(keyInfo.tag, backendModel);
    console.log(`[KIE] Stream route: ${call.routeId} (protocol=${call.protocol}) POST ${call.url}`);

    /* Stream establishment shares the provider retry policy (same key, max 3
     * TOTAL attempts, fixed 1500ms delay — same constants and classifier as
     * executeWithKey above, so there is exactly one retry policy, not two).
     * axios resolves once response HEADERS arrive, so any error caught here
     * happened BEFORE a single byte reached the client and is safe to retry.
     * Failures AFTER this point surface as stream 'error' events to the
     * consumer and are never retried (no duplicate streams). */
    const start = Date.now();
    let lastError: any = null;
    for (let attempt = 1; attempt <= KIE_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.post(call.url, call.body, {
          headers: this.buildHeaders(keyInfo.key, call.protocol === 'anthropic-messages'
            ? { 'anthropic-version': ANTHROPIC_VERSION }
            : undefined),
          responseType: 'stream',
          timeout: 0,
        } as AxiosRequestConfig);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);

        let stream = response.data;
        if (call.protocol === 'gemini') {
          stream = response.data.pipe(createGeminiToOpenAIStream(backendModel));
        } else if (call.protocol === 'anthropic-messages') {
          stream = response.data.pipe(createAnthropicToOpenAIStream(backendModel));
        } else if (call.protocol === 'openai-responses') {
          stream = response.data.pipe(createResponsesToOpenAIStream(backendModel));
        }
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        lastError = error;
        const status = getStatus(error);
        const normalized = this.normalizeUpstreamError(call.protocol, error);
        // Quota/rate-limit: cooldown + stop retrying this key (a transient
        // retry would only burn quota). Falls through to the shared tail so
        // the kie-codex 5xx gate below applies exactly as before.
        if (isQuotaError(error) || normalized.quota) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, 60);
          break;
        }
        // Transient with budget left: same-key retry after a fixed delay.
        if (attempt < KIE_MAX_ATTEMPTS && isTransientKieError(error)) {
          this.keyManager.markRetry(keyInfo.index);
          logRetry(keyInfo.tag, `${status}`);
          console.log(`[KIE][KEY#${keyInfo.index + 1}] Stream Status=${status}  Transient  Retry=${attempt + 1}/${KIE_MAX_ATTEMPTS}  Delay=${KIE_RETRY_DELAY_MS}ms`);
          await sleep(KIE_RETRY_DELAY_MS);
          continue;
        }
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[KIE][KEY#${keyInfo.index + 1}] Stream failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        break;
      }
    }
    /* Shared tail for a failed establishment (unchanged gate): kie-codex ONLY
     * replays a buffered non-streaming completion as SSE when the route
     * answers 5xx. Auth/quota 4xx never fall back and stay visible. The
     * fallback is a distinct non-streaming request through chatCompletion
     * (own KIE_MAX_ATTEMPTS budget via the shared loop), not a retry layer. */
    const status = getStatus(lastError);
    if (call.routeId === 'kie-codex' && status >= 500) {
      try {
        const completed = await this.chatCompletion({ ...payload, stream: false });
        console.log(`[KIE][KEY#${keyInfo.index + 1}] Stream unsupported (status=${status}) — replaying buffered completion as SSE`);
        return { stream: chatCompletionToOpenAIStream(completed, backendModel), keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (fallbackError: any) {
        console.log(`[KIE][KEY#${keyInfo.index + 1}] Buffered fallback failed: ${fallbackError?.message ?? 'unknown'}`);
        throw wrapError(fallbackError);
      }
    }
    throw wrapError(lastError);
  }

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODELS_CACHE_TTL_MS) {
      return { object: 'list', source: 'cache', data: cachedModels };
    }

    const staticData = KIE_STATIC_MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: Math.floor(now / 1000),
      owned_by: KIE_PROVIDER_ID,
      protocol: m.protocol,
      endpoint: m.endpoint,
      routeId: m.routeId,
    }));

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      const cached = discoveryStore.getLastGoodModels(KIE_PROVIDER_ID);
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : staticData,
      };
    }

    logRequest(keyInfo.tag, 'models');
    const { outcome, models } = await runDiscovery({
      provider: KIE_PROVIDER_ID,
      url: `${this.baseUrl}${KIE_CODEX_MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(KIE_CODEX_MODELS_ENDPOINT, {
          headers: this.buildHeaders(keyInfo.key),
        });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor(KIE_PROVIDER_ID),
      onHealthy: (latency) => {
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
      },
      onFailure: (o) => {
        if (o.status === 'rate_limited') {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, 60);
        } else {
          this.keyManager.markFailure(keyInfo.index, o.reason);
        }
      },
    });

    const mergeStatic = (discovered: any[]): any[] => {
      const seen = new Set(discovered.map((m: any) => String(typeof m === 'string' ? m : m.id).toLowerCase()));
      const out = discovered.map((m: any) => {
        const id = typeof m === 'string' ? m : m.id;
        return {
          ...(typeof m === 'object' ? m : {}),
          id,
          object: 'model',
          created: Math.floor(now / 1000),
          owned_by: KIE_PROVIDER_ID,
          protocol: 'openai-responses',
          endpoint: '/codex/v1/responses',
          routeId: 'kie-codex',
        };
      });
      for (const s of staticData) {
        if (!seen.has(s.id.toLowerCase())) out.push(s);
      }
      return out;
    };

    if (outcome.status === 'healthy') {
      cachedModels = mergeStatic(models);
      lastModelFetch = now;
      return { object: 'list', source: 'api', data: cachedModels };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: mergeStatic(models) };
    }
    return { object: 'list', source: 'fallback', data: staticData };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: KIE_PROVIDER_ID,
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        error: 'All Kie.ai keys are currently in cooldown',
        routes: [],
      };
    }

    // Codex exposes a cheap list endpoint — probe it live. Gemini/Claude
    // routes have no discovery endpoint, so they report config validity
    // (route registered + enabled + key available) without spending credit.
    const routes: any[] = [];
    for (const route of KIE_ROUTES) {
      if (route.id !== 'kie-codex') {
        routes.push({
          id: route.id,
          protocol: route.protocol,
          path: route.path,
          checked: 'config',
          ok: route.enabled,
          detail: route.enabled
            ? 'route registered and enabled; no upstream discovery endpoint'
            : 'route disabled',
        });
      }
    }
    try {
      const response = await this.client.get(KIE_CODEX_MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(HEALTH_PROBE_TIMEOUT_MS, this.timeout || HEALTH_PROBE_TIMEOUT_MS),
      });
      const latency = Date.now() - start;
      routes.unshift({
        id: 'kie-codex',
        protocol: 'openai-responses',
        path: '/codex/v1/responses',
        checked: 'live',
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      });
      return { provider: KIE_PROVIDER_ID, baseUrl: this.baseUrl, ok: true, status: 200, latency, routes };
    } catch (error: any) {
      const latency = Date.now() - start;
      routes.unshift({
        id: 'kie-codex',
        protocol: 'openai-responses',
        path: '/codex/v1/responses',
        checked: 'live',
        ok: false,
        status: getStatus(error) || 500,
        latency,
        error: error?.message ?? String(error),
      });
      return {
        provider: KIE_PROVIDER_ID,
        baseUrl: this.baseUrl,
        ok: false,
        status: getStatus(error) || 500,
        latency,
        error: error?.message ?? String(error),
        routes,
      };
    }
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('Kie.ai provider does not support embeddings.');
    err.status = 400;
    throw err;
  }
}
