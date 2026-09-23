import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isRetryableError, isQuotaError } from '../../lib/retry';
import { logRequest, logSuccessLatency, logRetry, logTrying, logRateLimited } from '../../lib/logger';
import { MODELS } from './models';
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

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'nvidia',
  providerName: 'NVIDIA NIM',
};

const PROTOCOL = 'openai';

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All NVIDIA API keys are currently in cooldown due to rate limits. Please wait before retrying.');
  err.status = 429;
  err.type = 'rate_limit_error';
  return err;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createNvidiaKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'NVIDIA');
}

async function attemptWithRetry(
  requestFn: (key: string) => Promise<any>,
  keyManager: KeyManager,
  model: string,
): Promise<any> {
  let lastError: any = null;
  const triedIndices = new Set<number>();

  for (let attempt = 0; attempt < keyManager.keyCount; attempt++) {
    let keyInfo: KeyInfo;
    try {
      keyInfo = await keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) {
        if (lastError) throw wrapError(lastError);
        throw createAllKeysCooldownError();
      }
      throw e;
    }

    if (triedIndices.has(keyInfo.index)) continue;
    triedIndices.add(keyInfo.index);

    logRequest(keyInfo.tag, model);
    console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  KeySuffix=${maskKeySuffix(keyInfo.key)}`);
    if (attempt > 0) logTrying(keyInfo.tag);

    const start = Date.now();
    try {
      const result = await requestFn(keyInfo.key);
      const latency = Date.now() - start;
      keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Latency=${latency}ms  Status=200`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      lastError = error;
      const status = getStatus(error);

      if (isQuotaError(error)) {
        keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('nvidia', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Status=${status}  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }

      if (attempt < keyManager.keyCount - 1 && isRetryableError(error)) {
        logRetry(keyInfo.tag, `${status}`);
        logPipelineError({ provider: 'nvidia', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
        keyManager.markRetry(keyInfo.index);
        continue;
      } else {
        logPipelineError({ provider: 'nvidia', model, status, error: error.message ?? String(error), latencyMs: latency });
      }
    }
  }
  throw wrapError(lastError);
}

function wrapError(error: any): any {
  if (error && error.status) return error;
  const status = getStatus(error) || 500;
  let errorBody: any = error?.response?.data;
  if (typeof errorBody === 'string') {
    try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
  }
  const nvidiaMsg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'Internal Server Error';
  const err: any = new Error(`NVIDIA API error (${status}): ${nvidiaMsg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class NvidiaProvider implements Provider {
  private client: AxiosInstance;
  private keyManager: KeyManager;
  private baseUrl: string;
  private timeout: number;

  constructor(keyManager: KeyManager, baseUrl: string, timeout: number) {
    this.keyManager = keyManager;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
    this.client = axios.create({
      baseURL: baseUrl,
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

  async chatCompletion(payload: any): Promise<any> {
    const result = await attemptWithRetry(
      (key) => this.makeRequest('post', '/chat/completions', payload, key),
      this.keyManager,
      payload.model,
    );
    logPipelineParsed('nvidia', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('nvidia', payload.model, text, location);
    logPipelineFinal('nvidia', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await attemptWithRetry(
      (key) => this.makeRequestRaw('post', '/chat/completions', payload, key),
      this.keyManager,
      payload.model,
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('nvidia', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('nvidia', payload.model, text, location);
    logPipelineFinal('nvidia', payload.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<any> {
    const { model } = payload;
    let lastError: any = null;
    const triedIndices = new Set<number>();

    for (let attempt = 0; attempt < this.keyManager.keyCount; attempt++) {
      let keyInfo: KeyInfo;
      try {
        keyInfo = await this.keyManager.getNextKey();
      } catch (e) {
        if (e instanceof AllKeysCooldownError) {
          if (lastError) throw wrapError(lastError);
          throw createAllKeysCooldownError();
        }
        throw e;
      }

      if (triedIndices.has(keyInfo.index)) continue;
      triedIndices.add(keyInfo.index);

      logRequest(keyInfo.tag, model);
      console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  KeySuffix=${maskKeySuffix(keyInfo.key)}`);
      if (attempt > 0) logTrying(keyInfo.tag);

      const start = Date.now();
      try {
        const stream = await this.makeStreamRequest('/chat/completions', { ...payload, stream: true }, keyInfo.key);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Latency=${latency}ms  Status=200`);
        logPipelineFinal('nvidia', model, `[streaming] stream established`, latency);
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        const latency = Date.now() - start;
        lastError = error;
        const status = getStatus(error);

        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('nvidia', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Status=${status}  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[Provider=NVIDIA] Model=${model}  ${keyInfo.tag}  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }

        if (attempt < this.keyManager.keyCount - 1 && isRetryableError(error)) {
          logRetry(keyInfo.tag, `${status}`);
          logPipelineError({ provider: 'nvidia', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          this.keyManager.markRetry(keyInfo.index);
          continue;
        } else {
          logPipelineError({ provider: 'nvidia', model, status, error: error.message ?? String(error), latencyMs: latency });
        }
      }
    }
    throw wrapError(lastError);
  }

  async listModels(): Promise<any> {
    const staticFallback = () => ({
      object: 'list',
      source: 'fallback',
      data: MODELS.map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'nvidia' })),
    });

    for (let attempt = 0; attempt < this.keyManager.keyCount; attempt++) {
      let keyInfo: KeyInfo;
      try {
        keyInfo = await this.keyManager.getNextKey();
      } catch {
        const cached = discoveryStore.getLastGoodModels('nvidia');
        if (cached.length > 0) return { object: 'list', source: 'cache', data: cached };
        console.warn('[Provider=NVIDIA] listModels: no key available, falling back to static model list');
        return staticFallback();
      }

      logRequest(keyInfo.tag, 'models');

      const { outcome, models } = await runDiscovery({
        provider: 'nvidia',
        url: `${this.client.defaults.baseURL ?? ''}/models`,
        request: async () => {
          const r = await this.client.request({
            method: 'get',
            url: '/models',
            headers: { 'Authorization': `Bearer ${keyInfo.key}` },
          });
          return { status: r.status, headers: r.headers as any, data: r.data };
        },
        extract: openAIModelExtractor('nvidia'),
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

      // A rate-limited/transient key failure: try the next key. A WAF block or
      // auth failure will not improve across keys, so stop and use cache.
      if ((outcome.status === 'rate_limited' || outcome.status === 'upstream_error' || outcome.status === 'timeout')
          && attempt < this.keyManager.keyCount - 1) {
        this.keyManager.markRetry(keyInfo.index);
        continue;
      }

      if (models.length > 0) return { object: 'list', source: 'cache', data: models };
      break;
    }

    const cached = discoveryStore.getLastGoodModels('nvidia');
    if (cached.length > 0) return { object: 'list', source: 'cache', data: cached };
    console.warn('[Provider=NVIDIA] listModels: live API failed, falling back to static model list');
    return staticFallback();
  }

  async createEmbedding(payload: any): Promise<any> {
    return attemptWithRetry(
      (key) => this.makeRequest('post', '/embeddings', payload, key),
      this.keyManager,
      payload.model,
    );
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({
      provider: 'nvidia',
      baseUrl: this.baseUrl,
      endpoint: url,
      model,
      protocol: PROTOCOL,
      keyMasked: maskApiKey(apiKey),
    });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { 'Authorization': `Bearer ${apiKey}`, ...extraConfig?.headers },
    });
    logPipelineRaw({
      provider: 'nvidia',
      model,
      endpoint: url,
      protocol: PROTOCOL,
      status: response.status,
      headers: response.headers,
      body: response.data,
      latencyMs: Date.now() - start,
    });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({
      provider: 'nvidia',
      baseUrl: this.baseUrl,
      endpoint: url,
      model,
      protocol: PROTOCOL,
      keyMasked: maskApiKey(apiKey),
    });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: { 'Authorization': `Bearer ${apiKey}` },
      responseType: 'text',
    });
    logPipelineRaw({
      provider: 'nvidia',
      model,
      endpoint: url,
      protocol: PROTOCOL,
      status: response.status,
      headers: response.headers,
      body: response.data,
      latencyMs: Date.now() - start,
    });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({
      provider: 'nvidia',
      baseUrl: this.baseUrl,
      endpoint: url,
      model,
      protocol: PROTOCOL,
      keyMasked: maskApiKey(apiKey),
    });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({
      provider: 'nvidia',
      model,
      endpoint: url,
      protocol: PROTOCOL,
      status: response.status,
      headers: response.headers,
      body: '[streaming]',
      latencyMs: Date.now() - start,
    });
    return response.data;
  }
}
