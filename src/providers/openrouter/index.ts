import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isQuotaError } from '../../lib/retry';
import { logRequest, logSuccessLatency, logRateLimited } from '../../lib/logger';
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
  providerId: 'openrouter',
  providerName: 'OpenRouter',
};

let cachedModels: any[] | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL = 300_000;

const OPENROUTER_KNOWN_MODELS = [
  'cohere/north-mini-code:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-20b:free',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-promini',
  'deepseek-r1',
  'deepseek-chat',
  'z-ai/glm-5.2',
  'z-ai/glm-4',
  'z-ai/glm-4v',
  'minimaxai/minimax-m2.7',
  'mistralai/mistral-medium-3.5-128b',
  'mistralai/mistral-large-2',
  'meta-llama/llama-3.1-8b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  'meta-llama/llama-3.1-405b-instruct',
];

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createOpenRouterKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'OpenRouter');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All OpenRouter API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'OpenRouter API error';
  const err: any = new Error(`OpenRouter API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

async function executeWithKey<T>(
  requestFn: (key: string) => Promise<T>,
  keyManager: KeyManager,
  model: string,
): Promise<T> {
  let keyInfo: KeyInfo;
  try {
    keyInfo = await keyManager.getNextKey();
  } catch (e) {
    if (e instanceof AllKeysCooldownError) {
      throw createAllKeysCooldownError();
    }
    throw e;
  }

  logRequest(keyInfo.tag, model);
  console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Using=${maskKeySuffix(keyInfo.key)}`);

  const start = Date.now();
  try {
    const result = await requestFn(keyInfo.key);
    const latency = Date.now() - start;
    keyManager.markSuccess(keyInfo.index, latency);
    logSuccessLatency(keyInfo.tag, latency);
    console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
    return result;
  } catch (error: any) {
    const latency = Date.now() - start;
    const status = getStatus(error);

    if (isQuotaError(error)) {
      keyManager.markCooldown(keyInfo.index);
      logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
      logPipelineRateLimit('openrouter', model, COOLDOWN_DURATION_MS / 1000, status);
      console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
    } else {
      keyManager.markFailure(keyInfo.index, error.message ?? String(error));
      console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
    }

    logPipelineError({ provider: 'openrouter', model, status, error: error.message ?? String(error), latencyMs: latency });

    throw wrapError(error);
  }
}

export class OpenRouterProvider implements Provider {
  private client: AxiosInstance;
  private keyManager: KeyManager;
  private baseUrl: string;
  private timeout: number;
  private siteUrl: string;
  private siteName: string;

  constructor(keyManager: KeyManager, baseUrl: string, timeout: number, siteUrl?: string, siteName?: string) {
    this.keyManager = keyManager;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
    this.siteUrl = siteUrl || '';
    this.siteName = siteName || '';

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

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;
    if (this.siteName) headers['X-Title'] = this.siteName;
    return headers;
  }

  async chatCompletion(payload: any): Promise<any> {
    const result = await executeWithKey(
      (key) => this.makeRequest('post', '/chat/completions', payload, key),
      this.keyManager,
      payload.model,
    );
    logPipelineParsed('openrouter', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('openrouter', payload.model, text, location);
    logPipelineFinal('openrouter', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await executeWithKey(
      (key) => this.makeRequestRaw('post', '/chat/completions', payload, key),
      this.keyManager,
      payload.model,
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('openrouter', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('openrouter', payload.model, text, location);
    logPipelineFinal('openrouter', payload.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
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
    console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Using=${maskKeySuffix(keyInfo.key)}`);

    const start = Date.now();
    try {
      const stream = await this.makeStreamRequest('/chat/completions', { ...payload, stream: true }, keyInfo.key);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('openrouter', model, `[streaming] stream established`, latency);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);

      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('openrouter', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[OPENROUTER][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }

      logPipelineError({ provider: 'openrouter', model, status, error: error.message ?? String(error), latencyMs: latency });

      throw wrapError(error);
    }
  }

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL) {
      return { object: 'list', data: cachedModels };
    }

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      const cached = discoveryStore.getLastGoodModels('openrouter');
      return {
        object: 'list',
        data: cached.length > 0 ? cached : OPENROUTER_KNOWN_MODELS.map((id) => ({
          id,
          object: 'model',
          created: Math.floor(now / 1000),
          owned_by: 'openrouter',
        })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'openrouter',
      url: `${this.baseUrl ?? ''}/models`,
      request: async () => {
        const r = await this.client.get('/models', { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('openrouter'),
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
      return { object: 'list', data: models };
    }
    if (models.length > 0) {
      return { object: 'list', data: models };
    }
    return {
      object: 'list',
      data: OPENROUTER_KNOWN_MODELS.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(now / 1000),
        owned_by: 'openrouter',
      })),
    };
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('OpenRouter provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({
      provider: 'openrouter',
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
      provider: 'openrouter',
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
      provider: 'openrouter',
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
      provider: 'openrouter',
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
      provider: 'openrouter',
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
      provider: 'openrouter',
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
