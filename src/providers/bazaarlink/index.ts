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
  providerId: 'bazaarlink',
  providerName: 'BazaarLink',
};

const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const MODELS_ENDPOINT = '/models';

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createBazaarLinkKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'BazaarLink');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All BazaarLink API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'BazaarLink API error';
  const err: any = new Error(`BazaarLink API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class BazaarLinkProvider implements Provider {
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
    console.log(`[BAZAARLINK] Base URL: ${this.baseUrl}`);
    console.log(`[BAZAARLINK] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[BAZAARLINK] Backend model: ${model}`);
    console.log(`[BAZAARLINK] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
  }

  private async executeWithKey<T>(
    endpoint: string,
    model: string,
    requestFn: (key: string) => Promise<T>,
  ): Promise<T> {
    let keyInfo: KeyInfo;
    let lastError: any = null;
    const triedIndices = new Set<number>();

    for (let attempt = 0; attempt < this.keyManager.keyCount; attempt++) {
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
        console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        return result;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('bazaarlink', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }
        logPipelineError({ provider: 'bazaarlink', model, status, error: error.message ?? String(error), latencyMs: latency });
        lastError = wrapError(error);
      }
    }
    throw lastError ?? wrapError(new Error('All BazaarLink API keys failed'));
  }

  async chatCompletion(payload: any): Promise<any> {
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    logPipelineParsed('bazaarlink', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('bazaarlink', payload.model, text, location);
    logPipelineFinal('bazaarlink', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('bazaarlink', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('bazaarlink', payload.model, text, location);
    logPipelineFinal('bazaarlink', payload.model, raw);
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
        console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        logPipelineFinal('bazaarlink', model, `[streaming] stream established`, latency);
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = getStatus(error);
        error = wrapError(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('bazaarlink', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[BAZAARLINK][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }
        logPipelineError({ provider: 'bazaarlink', model, status, error: error.message ?? String(error), latencyMs: latency });
        lastError = error;
      }
    }
    throw lastError ?? wrapError(new Error('All BazaarLink API keys failed'));
  }

  async listModels(): Promise<any> {
    const now = Date.now();

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      console.warn('[BAZAARLINK] listModels: no key available — using cached/fallback catalog');
      const cached = discoveryStore.getLastGoodModels('bazaarlink');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'bazaarlink' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'bazaarlink',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('bazaarlink'),
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
      return { object: 'list', source: 'api', data: models };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: models };
    }
    return {
      object: 'list',
      source: 'fallback',
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'bazaarlink' })),
    };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'bazaarlink',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All BazaarLink API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'bazaarlink',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'bazaarlink',
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
    const err: any = new Error('BazaarLink provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bazaarlink', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'bazaarlink', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bazaarlink', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'bazaarlink', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'bazaarlink', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'bazaarlink', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}