import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, AllKeysCooldownError, KeyInfo } from '../../lib/key-manager';
import { isQuotaError, isRetryableError, normalizeStreamError } from '../../lib/retry';
import { logRequest, logSuccessLatency, logRateLimited } from '../../lib/logger';
import { MODELS as STATIC_MODELS } from './models';
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
  providerId: 'hive',
  providerName: 'Hive',
};

// Upstream endpoints (relative to baseUrl, e.g. https://api-cdn.thehive.ai/api/v3).
// NOTE: no /v1 prefix — Hive V3 serves /chat/completions directly.
const OPENAI_CHAT_ENDPOINT = '/chat/completions';

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createHiveKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'Hive');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All Hive API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'Hive API error';
  const err: any = new Error(`Hive API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class HiveProvider implements Provider {
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
    console.log(`[HIVE] Base URL: ${this.baseUrl}`);
    console.log(`[HIVE] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[HIVE] Backend model: ${model}`);
    console.log(`[HIVE] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
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
        console.log(`[HIVE][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        return result;
      } catch (error: any) {
        lastError = error;
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('hive', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[HIVE][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[HIVE][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }

        if (attempt < this.keyManager.keyCount - 1 && isRetryableError(error)) {
          console.log(`[HIVE] Retry with fresh key  Attempt=${attempt + 2}  Status=${status}  Model=${model}`);
          logPipelineError({ provider: 'hive', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          continue;
        }

        logPipelineError({ provider: 'hive', model, status, error: error.message ?? String(error), latencyMs: latency });
        throw wrapError(error);
      }
    }

    throw wrapError(lastError);
  }

  async chatCompletion(payload: any): Promise<any> {
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, async (key) => {
      try {
        return await this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key);
      } catch (e: any) {
        /* Hive LLM gateway ids 500 plain calls but answer streaming ones:
         * transparently reassemble so clients see a normal response. */
        if ((e?.status ?? e?.response?.status) === 500) {
          return await this.postStreamAssembled(OPENAI_CHAT_ENDPOINT, payload, key);
        }
        throw e;
      }
    });
    logPipelineParsed('hive', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('hive', payload.model, text, location);
    logPipelineFinal('hive', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, async (key) => {
      try {
        return await this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key);
      } catch (e: any) {
        if ((e?.status ?? e?.response?.status) === 500) {
          return JSON.stringify(await this.postStreamAssembled(OPENAI_CHAT_ENDPOINT, payload, key));
        }
        throw e;
      }
    });
    const parsed = parseResponseBody(raw);
    logPipelineParsed('hive', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('hive', payload.model, text, location);
    logPipelineFinal('hive', payload.model, raw);
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
        console.log(`[HIVE][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        logPipelineFinal('hive', model, `[streaming] stream established`, latency);
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        lastError = error;
        const latency = Date.now() - start;
        /* Streaming rejections carry an unread body stream: drain it first so
         * quota/balance classification (and failover) works like non-stream. */
        await normalizeStreamError(error);
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('hive', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[HIVE][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[HIVE][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }

        if (attempt < this.keyManager.keyCount - 1 && isRetryableError(error)) {
          console.log(`[HIVE] Retry with fresh key  Attempt=${attempt + 2}  Status=${status}  Model=${model}`);
          logPipelineError({ provider: 'hive', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          continue;
        }

        logPipelineError({ provider: 'hive', model, status, error: error.message ?? String(error), latencyMs: latency });
        throw wrapError(error);
      }
    }

    throw wrapError(lastError);
  }

  /* Hive exposes no model-discovery endpoint: the catalog is static. */
  async listModels(): Promise<any> {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      source: 'static',
      data: STATIC_MODELS.map((id) => ({ id, object: 'model', created: nowSec, owned_by: 'hive' })),
    };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'hive',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: STATIC_MODELS.length,
        error: 'All Hive API keys are currently in cooldown',
      };
    }
    // No discovery endpoint to probe: report key availability + static catalog.
    // A cheap upstream probe would spend inference budget on every check.
    void keyInfo;
    return {
      provider: 'hive',
      baseUrl: this.baseUrl,
      ok: true,
      status: 200,
      latency: Date.now() - start,
      models: STATIC_MODELS.length,
    };
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('Hive provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'hive', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'hive', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'hive', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'hive', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'hive', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'hive', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }

  /* Posts with stream:true and reassembles the SSE chunks into a single
   * OpenAI-style chat completion object. Used as a fallback for Hive LLM
   * gateway ids that 500 plain (non-streaming) calls. */
  private async postStreamAssembled(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    const started = Date.now();
    const response = await this.client.post(
      url,
      { ...data, stream: true },
      { headers: this.buildHeaders(apiKey), responseType: 'stream', timeout: this.timeout } as AxiosRequestConfig,
    );
    const raw: string = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      response.data.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      response.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      response.data.on('error', reject);
    });
    let id = `hive-${Date.now()}`;
    let responseModel = model;
    let created = Math.floor(Date.now() / 1000);
    let content = '';
    let finishReason: string | null = null;
    let usage: any = undefined;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.id) id = evt.id;
        if (evt.model) responseModel = evt.model;
        if (evt.created) created = evt.created;
        const choice = evt.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.message?.content) content += choice.message.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (evt.usage) usage = evt.usage;
      } catch {
        /* skip malformed SSE lines */
      }
    }
    const assembled = {
      id,
      object: 'chat.completion',
      created,
      model: responseModel,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason ?? 'stop' }],
      ...(usage ? { usage } : {}),
    };
    logPipelineRaw({ provider: 'hive', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: assembled, latencyMs: Date.now() - started });
    return assembled;
  }
}
