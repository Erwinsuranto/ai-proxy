import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { PassThrough } from 'stream';
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
import {
  detectInlineUpstreamError,
  createUpstreamError,
  getStreamVerdict,
  StreamVerdict,
} from '../../lib/inline-error';

const COOLDOWN_DURATION_MS = 60_000;
const PROTOCOL = 'openai';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'aisurplus',
  providerName: 'Aisurplus',
};

// Upstream endpoints (relative to baseUrl, e.g. https://aisurplus.io/v1).
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

export function createAisurplusKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'Aisurplus');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All Aisurplus API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.error ?? errorBody?.message ?? error?.message ?? 'Aisurplus API error';
  const err: any = new Error(`Aisurplus API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class AisurplusProvider implements Provider {
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
    console.log(`[AISURPLUS] Base URL: ${this.baseUrl}`);
    console.log(`[AISURPLUS] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[AISURPLUS] Backend model: ${model}`);
    console.log(`[AISURPLUS] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
  }

  /**
   * Runs a single request through one round-robin API key, recording
   * success/failure/cooldown so the KeyManager can rotate keys within the
   * provider. `endpoint` selects the upstream OpenAI-compatible path.
   */
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
      console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('aisurplus', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'aisurplus', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- OpenAI-compatible endpoint: POST /v1/chat/completions ---
  // The payload is forwarded as-is (OpenAI Chat Completions format), which
  // transparently supports tool calls, vision (image_url content parts), and
  // other OpenAI-compatible fields without special handling.

  async chatCompletion(payload: any): Promise<any> {
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    logPipelineParsed('aisurplus', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('aisurplus', payload.model, text, location);
    logPipelineFinal('aisurplus', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('aisurplus', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('aisurplus', payload.model, text, location);
    logPipelineFinal('aisurplus', payload.model, raw);
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
    this.logSelection(OPENAI_CHAT_ENDPOINT, model, keyInfo);

    const start = Date.now();
    try {
      const stream = await this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...payload, stream: true }, keyInfo.key);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('aisurplus', model, `[streaming] stream established`, latency);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('aisurplus', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[AISURPLUS][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'aisurplus', model, status, error: error.message ?? String(error), latencyMs: latency });
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
      console.warn('[AISURPLUS] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('aisurplus');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'aisurplus' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'aisurplus',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('aisurplus'),
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
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'aisurplus' })),
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
        provider: 'aisurplus',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All Aisurplus API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'aisurplus',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'aisurplus',
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
    const err: any = new Error('Aisurplus provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'aisurplus', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'aisurplus', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // HTTP 200 but the body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('Aisurplus', inline);
    }
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'aisurplus', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'aisurplus', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // HTTP 200 but the raw body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('Aisurplus', inline);
    }
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'aisurplus', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      // Aisurplus requests must not be cut off at the global 30s timeout.
      // Apply the Aisurplus-specific (120s) timeout consistently to normal AND
      // streaming requests so long generations can complete.
      timeout: this.timeout,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'aisurplus', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    // Inspect the first SSE event(s). If the upstream turned a HTTP-200
    // stream into an inline error, destroy it and surface a real upstream
    // failure so the existing fallback/key-rotation path can act on it. Genuine
    // content is forwarded untouched (no corruption, no false positives).
    return this.inspectStreamStart(response.data);
  }

  /**
   * Buffers the initial bytes of an upstream SSE stream and decides whether it
   * is a genuine completion or an inline upstream error. Resolves with a stream
   * that replays the buffered bytes first (so nothing is lost) when the stream
   * is genuine; rejects with an upstream failure when an inline error is found.
   */
  private inspectStreamStart(upstream: any): Promise<any> {
    // Defensive: non-Node streams (e.g. test mocks) are returned as-is.
    if (!upstream || typeof upstream.on !== 'function') {
      return Promise.resolve(upstream);
    }

    const passthrough = new PassThrough();
    const total = { buf: '' };
    const content = { buf: '', started: false };
    let settled = false;

    return new Promise((resolve, reject) => {
      const settle = (verdict: StreamVerdict) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (verdict === 'error') {
          const err = createUpstreamError('Aisurplus', {
            status: 502,
            message: 'Service temporarily unavailable',
          });
          if (!passthrough.destroyed) passthrough.destroy();
          if (!upstream.destroyed) upstream.destroy();
          reject(err);
          return;
        }
        try {
          upstream.pipe(passthrough);
        } catch {
          // ignore
        }
        resolve(passthrough);
      };

      const onData = (chunk: Buffer) => {
        // Forward every byte into the replay stream immediately so a genuine
        // stream is only delayed until the first SSE event is classified.
        if (!passthrough.destroyed) passthrough.write(chunk);
        const text = chunk.toString();
        total.buf += text;
        const decision = getStreamVerdict(total.buf, content.buf, content.started);
        if (decision === 'error' || decision === 'legit') {
          settle(decision);
          return;
        }
        // Still undecided: keep accumulating, but track content so a split
        // `[error]` tag spanning multiple chunks is recognised.
        const cls = peekContent(text);
        if (cls) {
          content.buf += cls;
          content.started = true;
        }
      };

      const onEnd = () => {
        // Stream ended early. Decide from everything we buffered.
        const decision = getStreamVerdict(total.buf, content.buf, content.started);
        settle(decision ?? 'legit');
        if (!passthrough.destroyed && !passthrough.writableEnded) passthrough.end();
      };

      const onError = (err: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!passthrough.destroyed) passthrough.destroy();
        reject(err);
      };

      const cleanup = () => {
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onError);
      };

      // Safety valve: never hang a request on a silent upstream.
      const cap = setTimeout(() => {
        if (settled) return;
        const decision = getStreamVerdict(total.buf, content.buf, content.started);
        settle(decision ?? 'legit');
      }, Math.min(30_000, Math.max(10_000, this.timeout || 10_000)));

      upstream.on('data', onData);
      upstream.on('end', onEnd);
      upstream.on('error', onError);
    });
  }
}

/** Extract assistant content text from a single SSE chunk for incremental tracking. */
function peekContent(chunkText: string): string {
  // Only consider complete `data: {...}` lines for content accumulation.
  const lines = chunkText.split('\n');
  if (!chunkText.endsWith('\n')) lines.pop();
  let acc = '';
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const content = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!content || content === '[DONE]') continue;
    try {
      const parsed = JSON.parse(content);
      const choices = parsed?.choices;
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const text = c?.message?.content ?? c?.delta?.content;
          if (typeof text === 'string') acc += text;
        }
      }
    } catch {
      // ignore non-JSON chunk lines
    }
  }
  return acc;
}
