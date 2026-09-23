import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { isQuotaError } from '../../lib/retry';
import { MODELS as FALLBACK_MODELS } from './models';
import { runDiscovery, discoveryStore, openAIModelExtractor } from '../../lib/discovery';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError, logPipelineRateLimit,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';
import { getInferenceSessionId } from '../../lib/inference-session';

/* ============================================================================
 * OpenCode Inference API provider — SEPARATE from OpenCode Zen.
 * ----------------------------------------------------------------------------
 * Base URL:  https://opencode.ai/inference/openai/v1
 * Endpoint:  POST /chat/completions (OpenAI Chat Completions protocol)
 * Auth:      free models are called WITHOUT an Authorization header.
 *
 * ISOLATION CONTRACT (hard requirements):
 *  - This provider NEVER touches the Zen KeyManager, Zen keys, or any other
 *    provider's credentials. It has NO KeyManager at all.
 *  - No Authorization header is ever sent.
 *  - No cross-provider fallback exists: provider-locked routing in
 *    services/provider.ts guarantees inference requests only ever reach this
 *    provider, and Zen requests never reach it.
 *
 * SESSION IDENTITY:
 *  - The free tier requires the OpenCode client session header
 *    `x-opencode-session` (audited: binary v1.18.30 + 9router reference). The
 *    value is taken ONLY from the current request context
 *    (lib/inference-session.ts) — never generated, never derived from a key,
 *    never logged.
 * ========================================================================== */

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'opencode-inference',
  providerName: 'OpenCode Inference',
};

const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const MODELS_ENDPOINT = '/models';
const PROTOCOL = 'openai';

/* Static OpenCode client identity sent upstream alongside the session id.
 * These mirror the audited OpenCode client / 9router reference and carry no
 * credential of any kind. */
const OPENCODE_CLIENT_HEADERS: Record<string, string> = {
  'User-Agent': 'opencode',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
};

let cachedModels: any[] | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL = 300_000;

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function wrapError(error: any): any {
  if (error && error.status) return error;
  const status = getStatus(error) || 500;
  let errorBody: any = error?.response?.data;
  if (typeof errorBody === 'string') {
    try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
  }
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'OpenCode Inference API error';
  const err: any = new Error(`OpenCode Inference API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class InferenceProvider implements Provider {
  private client: AxiosInstance;
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getProviderInfo(): ProviderInfo {
    return PROVIDER_INFO;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /* Free-Inference requests carry NO Authorization header. They send only the
   * content type, the static OpenCode client identity, and — when the current
   * request supplied one — the SAME `x-opencode-session` value. No credential,
   * no placeholder, no Zen key, and no key-derived session.
   *
   * The session id is an explicit allowlist of ONE header: the provider never
   * forwards arbitrary incoming headers. */
  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...OPENCODE_CLIENT_HEADERS,
    };
    const sessionId = getInferenceSessionId();
    if (sessionId) {
      headers['x-opencode-session'] = sessionId;
    }
    return {
      ...headers,
      ...extra,
    };
  }

  private logSelection(endpoint: string, model: string): void {
    console.log(`[INFERENCE] Base URL: ${this.baseUrl}`);
    console.log(`[INFERENCE] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[INFERENCE] Backend model: ${model}`);
    console.log('[INFERENCE] Auth: none (free tier — no Authorization header)');
  }

  // --- OpenAI-compatible endpoint: POST /chat/completions ---

  async chatCompletion(payload: any): Promise<any> {
    const result = await this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload);
    logPipelineParsed('opencode-inference', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('opencode-inference', payload.model, text, location);
    logPipelineFinal('opencode-inference', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload);
    const parsed = parseResponseBody(raw);
    logPipelineParsed('opencode-inference', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('opencode-inference', payload.model, text, location);
    logPipelineFinal('opencode-inference', payload.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    this.logSelection(OPENAI_CHAT_ENDPOINT, model);
    const start = Date.now();
    try {
      const stream = await this.makeStreamRequest(
        OPENAI_CHAT_ENDPOINT,
        { ...payload, stream: true },
      );
      const latency = Date.now() - start;
      console.log(`[INFERENCE] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('opencode-inference', model, '[streaming] stream established', latency);
      /* No credential rotation — keyIndex -1 mirrors the Zen public/no-key path. */
      return { stream, keyIndex: -1, tag: 'opencode-inference' };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        logPipelineRateLimit('opencode-inference', model, 0, status);
      }
      console.log(`[INFERENCE] Failed  Model=${model}  Status=${status}  Error=${error.message ?? 'unknown'}`);
      logPipelineError({ provider: 'opencode-inference', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- Model discovery: GET /v1/models (no Authorization) ---

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL) {
      return { object: 'list', source: 'cache', data: cachedModels };
    }

    const { outcome, models } = await runDiscovery({
      provider: 'opencode-inference',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders() });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('opencode-inference'),
    });

    const fallback = (): any[] =>
      FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'opencode-inference' }));

    if (outcome.status === 'healthy') {
      cachedModels = models.length > 0 ? models : fallback();
      lastModelFetch = now;
      return { object: 'list', source: 'api', data: cachedModels };
    }
    const cached = discoveryStore.getLastGoodModels('opencode-inference');
    const data = models.length > 0 ? models : (cached.length > 0 ? cached : fallback());
    return { object: 'list', source: models.length > 0 ? 'cache' : (cached.length > 0 ? 'cache' : 'fallback'), data };
  }

  /* Health = GET /models without Authorization. Never performs inference and
   * never touches another provider's credentials. */
  async healthCheck(): Promise<any> {
    const start = Date.now();
    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      return {
        provider: 'opencode-inference',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency: Date.now() - start,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      return {
        provider: 'opencode-inference',
        baseUrl: this.baseUrl,
        ok: false,
        status: getStatus(error) || 500,
        latency: Date.now() - start,
        models: 0,
        error: error?.message ?? String(error),
      };
    }
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('OpenCode Inference provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    this.logSelection(url, model);
    logPipelineRequest({ provider: 'opencode-inference', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: '(no auth)' });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'opencode-inference', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'opencode-inference', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: '(no auth)' });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'opencode-inference', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'opencode-inference', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: '(no auth)' });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'opencode-inference', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}
