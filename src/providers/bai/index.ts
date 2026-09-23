import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isQuotaError, isRetryableError } from '../../lib/retry';
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
  providerId: 'bai',
  providerName: 'BAI',
};

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

export function createBaiKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'BAI');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All BAI API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'BAI API error';
  const err: any = new Error(`BAI API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class BaiProvider implements Provider {
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
      'Accept': 'application/json',
    };
  }

  private logSelection(endpoint: string, model: string, keyInfo: KeyInfo): void {
    console.log(`[BAI] Base URL: ${this.baseUrl}`);
    console.log(`[BAI] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[BAI] Backend model: ${model}`);
    console.log(`[BAI] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
  }

  private async executeWithKey<T>(
    endpoint: string,
    model: string,
    requestFn: (key: string) => Promise<T>,
  ): Promise<T> {
    let lastError: any = null;
    const triedIndices = new Set<number>();

    for (let attempt = 0; attempt < this.keyManager.keyCount; attempt++) {
      let keyInfo: KeyInfo;
      try {
        keyInfo = await this.keyManager.getNextKey();
      } catch (e) {
        if (e instanceof AllKeysCooldownError) {
          throw lastError ?? createAllKeysCooldownError();
        }
        throw e;
      }
      if (triedIndices.has(keyInfo.index)) continue;
      triedIndices.add(keyInfo.index);

      logRequest(keyInfo.tag, model);
      this.logSelection(endpoint, model, keyInfo);

      const start = Date.now();
      try {
        const result = await requestFn(keyInfo.key);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[BAI][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        return result;
      } catch (error: any) {
        lastError = error;
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('bai', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[BAI][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[BAI][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }

        if (attempt < this.keyManager.keyCount - 1 && isRetryableError(error)) {
          console.log(`[BAI] Retry with fresh key  Attempt=${attempt + 2}  Status=${status}  Model=${model}`);
          logPipelineError({ provider: 'bai', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          continue;
        }

        logPipelineError({ provider: 'bai', model, status, error: error.message ?? String(error), latencyMs: latency });
        throw wrapError(error);
      }
    }

    throw wrapError(lastError);
  }

  async chatCompletion(payload: any): Promise<any> {
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    logPipelineParsed('bai', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('bai', payload.model, text, location);
    logPipelineFinal('bai', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('bai', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('bai', payload.model, text, location);
    logPipelineFinal('bai', payload.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    let lastError: any = null;
    const triedIndices = new Set<number>();

    for (let attempt = 0; attempt < this.keyManager.keyCount; attempt++) {
      let keyInfo: KeyInfo;
      try {
        keyInfo = await this.keyManager.getNextKey();
      } catch (e) {
        if (e instanceof AllKeysCooldownError) {
          throw lastError ?? createAllKeysCooldownError();
        }
        throw e;
      }
      if (triedIndices.has(keyInfo.index)) continue;
      triedIndices.add(keyInfo.index);

      logRequest(keyInfo.tag, model);
      this.logSelection(OPENAI_CHAT_ENDPOINT, model, keyInfo);

      const start = Date.now();
      try {
        const stream = await this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...payload, stream: true }, keyInfo.key);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[BAI][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        logPipelineFinal('bai', model, `[streaming] stream established`, latency);
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        lastError = error;
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('bai', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[BAI][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[BAI][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }

        if (attempt < this.keyManager.keyCount - 1 && isRetryableError(error)) {
          console.log(`[BAI] Retry with fresh key  Attempt=${attempt + 2}  Status=${status}  Model=${model}`);
          logPipelineError({ provider: 'bai', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          continue;
        }

        logPipelineError({ provider: 'bai', model, status, error: error.message ?? String(error), latencyMs: latency });
        throw wrapError(error);
      }
    }

    throw wrapError(lastError);
  }

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL) {
      return { object: 'list', source: 'cache', data: cachedModels };
    }

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      console.warn('[BAI] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('bai');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'bai' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'bai',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('bai'),
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

    if (outcome.status === 'healthy') {
      cachedModels = models;
      lastModelFetch = now;
      return { object: 'list', source: 'api', data: models };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: models };
    }
    return {
      object: 'list',
      source: 'fallback',
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'bai' })),
    };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'bai',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All BAI API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'bai',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'bai',
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
    const err: any = new Error('BAI provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'bai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'bai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'bai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}