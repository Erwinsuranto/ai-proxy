import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isQuotaError } from '../../lib/retry';
import { logRequest, logSuccessLatency, logRateLimited } from '../../lib/logger';
import { MODELS as FALLBACK_MODELS } from './models';
import { runDiscovery, discoveryStore, openAIModelExtractor } from '../../lib/discovery';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError, logPipelineRateLimit, maskApiKey,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';

const COOLDOWN_DURATION_MS = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();
const PROTOCOL = 'openai';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'llm7',
  providerName: 'LLM7',
};

// Upstream endpoints (relative to baseUrl, e.g. https://api.llm7.io/v1).
const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const MODELS_ENDPOINT = '/models';

let cachedModels: any[] | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL = 300_000;

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createLlm7KeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'LLM7');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All LLM7 API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'LLM7 API error';
  const err: any = new Error(`LLM7 API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class Llm7Provider implements Provider {
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

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private logSelection(endpoint: string, model: string, keyInfo: KeyInfo): void {
    console.log(`[LLM7] Base URL: ${this.baseUrl}`);
    console.log(`[LLM7] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[LLM7] Backend model: ${model}`);
    console.log(`[LLM7] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
  }

  // LLM7 rejects reasoning_effort="max" with HTTP 400 (only low/high accepted).
  // Clamp it so clients that request max reasoning (e.g. opencode) still work.
  private sanitizePayload(payload: any): any {
    const clean = { ...payload };
    if (clean.reasoning_effort === 'max') {
      clean.reasoning_effort = 'high';
    }
    return clean;
  }

  private async executeWithKey<T>(
    endpoint: string,
    model: string,
    requestFn: (key: string) => Promise<T>,
  ): Promise<T> {
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) {
        throw createAllKeysCooldownError();
      }
      throw e;
    }

    logRequest(keyInfo.tag, model);
    this.logSelection(endpoint, model, keyInfo);

    const start = Date.now();
    try {
      const result = await requestFn(keyInfo.key);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[LLM7][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('llm7', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[LLM7][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[LLM7][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'llm7', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- OpenAI-compatible endpoint: POST /v1/chat/completions ---

  async chatCompletion(payload: any): Promise<any> {
    const clean = this.sanitizePayload(payload);
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, clean.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, clean, key),
    );
    logPipelineParsed('llm7', clean.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('llm7', clean.model, text, location);
    logPipelineFinal('llm7', clean.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const clean = this.sanitizePayload(payload);
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, clean.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, clean, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('llm7', clean.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('llm7', clean.model, text, location);
    logPipelineFinal('llm7', clean.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const clean = this.sanitizePayload(payload);
    const { model } = clean;
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) {
        throw createAllKeysCooldownError();
      }
      throw e;
    }

    logRequest(keyInfo.tag, model);
    this.logSelection(OPENAI_CHAT_ENDPOINT, model, keyInfo);

    const start = Date.now();
    try {
      const stream = await this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...clean, stream: true }, keyInfo.key);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[LLM7][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('llm7', model, `[streaming] stream established`, latency);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('llm7', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[LLM7][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[LLM7][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'llm7', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- Model discovery: GET /v1/models (dynamic, manual fallback catalog) ---

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL) {
      return { object: 'list', source: 'cache', data: cachedModels };
    }

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      console.warn('[LLM7] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('llm7');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'llm7' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'llm7',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('llm7'),
      onHealthy: (latency) => {
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
      },
      onFailure: (o) => {
        if (o.status === 'rate_limited') {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        } else {
          this.keyManager.markFailure(keyInfo.index, o.reason);
        }
      },
    });

    // Freely usable models are merged in so the provider stays routable for the
    // free tier even if upstream is temporarily unavailable.
    const merged = new Map<string, any>();
    for (const m of models) {
      const id = typeof m === 'string' ? m : m.id;
      if (id) merged.set(id, m);
    }
    for (const id of FALLBACK_MODELS) {
      if (!merged.has(id)) {
        merged.set(id, { id, object: 'model', created: Math.floor(now / 1000), owned_by: 'llm7', virtual: true });
      }
    }

    if (outcome.status === 'healthy') {
      cachedModels = Array.from(merged.values());
      lastModelFetch = now;
      return { object: 'list', source: 'api', data: cachedModels };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: Array.from(merged.values()) };
    }
    return {
      object: 'list',
      source: 'fallback',
      data: Array.from(merged.values()),
    };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'llm7',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All LLM7 API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'llm7',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'llm7',
        baseUrl: this.baseUrl,
        ok: false,
        status: getStatus(error) || 500,
        latency,
        models: 0,
        error: error?.message ?? String(error),
      };
    }
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('LLM7 provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'llm7', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'llm7', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'llm7', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'llm7', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'llm7', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'llm7', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}