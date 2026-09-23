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
  providerId: 'orcarouter',
  providerName: 'OrcaRouter',
};

// Upstream endpoints (relative to baseUrl, e.g. https://api.orcarouter.ai/v1).
const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const ANTHROPIC_MESSAGES_ENDPOINT = '/messages';
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

export function createOrcaRouterKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'OrcaRouter');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All OrcaRouter API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'OrcaRouter API error';
  const err: any = new Error(`OrcaRouter API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class OrcaRouterProvider implements Provider {
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

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private logSelection(endpoint: string, model: string, keyInfo: KeyInfo): void {
    console.log(`[ORCAROUTER] Base URL: ${this.baseUrl}`);
    console.log(`[ORCAROUTER] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[ORCAROUTER] Backend model: ${model}`);
    console.log(`[ORCAROUTER] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
  }

  /**
   * Runs a single request through round-robin API keys, automatically failing
   * over to the next key on quota/permission errors (429/403) so one request
   * succeeds as long as at least one key can serve it. Records
   * success/failure/cooldown so the KeyManager can rotate keys within the
   * provider. `endpoint` selects the upstream path (OpenAI vs Anthropic).
   */
  private async executeWithKey<T>(
    endpoint: string,
    model: string,
    requestFn: (key: string) => Promise<T>,
  ): Promise<{ value: T; keyIndex: number; tag: string }> {
    let lastError: any;
    const attempts = this.keyManager.keyCount;

    for (let attempt = 0; attempt < attempts; attempt++) {
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
        const value = await requestFn(keyInfo.key);
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[ORCAROUTER][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        return { value, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('orcarouter', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[ORCAROUTER][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[ORCAROUTER][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }
        logPipelineError({ provider: 'orcarouter', model, status, error: error.message ?? String(error), latencyMs: latency });
        lastError = wrapError(error);
        if (attempt < attempts - 1) {
          console.log(`[ORCAROUTER] Status=${status} on KEY#${keyInfo.index + 1} — failing over to next key (attempt ${attempt + 2}/${attempts})`);
        }
      }
    }

    throw lastError;
  }

  // --- OpenAI-compatible endpoint: POST /v1/chat/completions ---

  async chatCompletion(payload: any): Promise<any> {
    const { value } = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    logPipelineParsed('orcarouter', payload.model, value, true);
    const { text, location } = findTextInResponse(value);
    logPipelineExtracted('orcarouter', payload.model, text, location);
    logPipelineFinal('orcarouter', payload.model, value);
    return value;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const { value } = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(value);
    logPipelineParsed('orcarouter', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? value);
    logPipelineExtracted('orcarouter', payload.model, text, location);
    logPipelineFinal('orcarouter', payload.model, value);
    return value;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    const { value: stream, keyIndex, tag } = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, model, (key) =>
      this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...payload, stream: true }, key),
    );
    logPipelineFinal('orcarouter', model, `[streaming] stream established`);
    return { stream, keyIndex, tag };
  }

  // --- Anthropic-compatible endpoint: POST /v1/messages ---

  async messages(payload: any): Promise<any> {
    const { value } = await this.executeWithKey(ANTHROPIC_MESSAGES_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', ANTHROPIC_MESSAGES_ENDPOINT, payload, key),
    );
    logPipelineParsed('orcarouter', payload.model, value, true);
    const { text, location } = findTextInResponse(value);
    logPipelineExtracted('orcarouter', payload.model, text, location);
    logPipelineFinal('orcarouter', payload.model, value);
    return value;
  }

  async messagesRaw(payload: any): Promise<string> {
    const { value } = await this.executeWithKey(ANTHROPIC_MESSAGES_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', ANTHROPIC_MESSAGES_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(value);
    logPipelineParsed('orcarouter', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? value);
    logPipelineExtracted('orcarouter', payload.model, text, location);
    logPipelineFinal('orcarouter', payload.model, value);
    return value;
  }

  async messagesStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    const { value: stream, keyIndex, tag } = await this.executeWithKey(ANTHROPIC_MESSAGES_ENDPOINT, model, (key) =>
      this.makeStreamRequest(ANTHROPIC_MESSAGES_ENDPOINT, { ...payload, stream: true }, key),
    );
    logPipelineFinal('orcarouter', model, `[streaming] stream established`);
    return { stream, keyIndex, tag };
  }

  // --- Model discovery: GET /v1/models (dynamic, no hardcoded catalog) ---

  private tagModels(models: any[]): any[] {
    // Upstream entries carry the model owner (e.g. owned_by=claude); normalize
    // to the provider id so /v1/models attribution is stable for OrcaRouter.
    return models.map((m: any) => ({ ...m, owned_by: 'orcarouter' }));
  }

  async listModels(): Promise<any> {
    const now = Date.now();
    if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL) {
      return { object: 'list', source: 'cache', data: this.tagModels(cachedModels) };
    }

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch {
      console.warn('[ORCAROUTER] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('orcarouter');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? this.tagModels(cached) : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'orcarouter' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'orcarouter',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('orcarouter'),
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
      return { object: 'list', source: 'api', data: this.tagModels(models) };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: this.tagModels(models) };
    }
    return {
      object: 'list',
      source: 'fallback',
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'orcarouter' })),
    };
  }

  /**
   * Lightweight provider health check: issues a GET /v1/models against the
   * upstream with the first available key and reports reachability, status,
   * latency and the number of models the account can access.
   */
  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'orcarouter',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All OrcaRouter API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'orcarouter',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'orcarouter',
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
    const err: any = new Error('OrcaRouter provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    const protocol = url === ANTHROPIC_MESSAGES_ENDPOINT ? 'anthropic' : PROTOCOL;
    logPipelineRequest({ provider: 'orcarouter', baseUrl: this.baseUrl, endpoint: url, model, protocol, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'orcarouter', model, endpoint: url, protocol, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    const protocol = url === ANTHROPIC_MESSAGES_ENDPOINT ? 'anthropic' : PROTOCOL;
    logPipelineRequest({ provider: 'orcarouter', baseUrl: this.baseUrl, endpoint: url, model, protocol, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'orcarouter', model, endpoint: url, protocol, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    const protocol = url === ANTHROPIC_MESSAGES_ENDPOINT ? 'anthropic' : PROTOCOL;
    logPipelineRequest({ provider: 'orcarouter', baseUrl: this.baseUrl, endpoint: url, model, protocol, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'orcarouter', model, endpoint: url, protocol, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}
