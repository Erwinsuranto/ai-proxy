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

const COOLDOWN_DURATION_MS = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();
const WAF_RETRY_COUNT = 3;
const WAF_RETRY_BASE_MS = 1_500;
const WAF_RETRY_MAX_MS = 6_000;
const PROTOCOL = 'openai';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'justwoker',
  providerName: 'JustWoker',
};

// Upstream endpoints (relative to baseUrl, e.g. https://justwoker.cc/v1).
const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const MODELS_ENDPOINT = '/models';

let cachedModels: any[] | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL = 300_000;

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function isWafBlock(error: any): boolean {
  if (getStatus(error) !== 403) return false;
  const data = error?.response?.data;
  const msg = String(data?.error?.message ?? error?.message ?? (typeof data === 'string' ? data : '')).toLowerCase();
  const ct = String(error?.response?.headers?.['content-type'] ?? '').toLowerCase();
  return (
    msg.includes('abusive') ||
    msg.includes('non-compliant') ||
    msg.includes('access denied') ||
    msg.includes('request failed with status code 403') ||
    ct.includes('text/html')
  );
}

function maskKeySuffix(key: string): string {
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function createJustWokerKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'JustWoker');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All JustWoker API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'JustWoker API error';
  const err: any = new Error(`JustWoker API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class JustWokerProvider implements Provider {
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
      'User-Agent': USER_AGENT,
    };
  }

  private logSelection(endpoint: string, model: string, keyInfo: KeyInfo): void {
    console.log(`[JUSTWOKER] Base URL: ${this.baseUrl}`);
    console.log(`[JUSTWOKER] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[JUSTWOKER] Backend model: ${model}`);
    console.log(`[JUSTWOKER] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
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
    let wafRetry = 0;
    try {
      let result: T;
      while (true) {
        try {
          result = await requestFn(keyInfo.key);
          break;
        } catch (error: any) {
          if (isWafBlock(error) && wafRetry < WAF_RETRY_COUNT) {
            const backoff = Math.min(WAF_RETRY_MAX_MS, WAF_RETRY_BASE_MS * Math.pow(2, wafRetry));
            wafRetry++;
            console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] WAF blocked  Retry=${wafRetry}/${WAF_RETRY_COUNT}  Backoff=${backoff}ms  Model=${model}`);
            await delay(backoff);
            continue;
          }
          throw error;
        }
      }
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('justwoker', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'justwoker', model, status, error: error.message ?? String(error), latencyMs: latency });
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
    logPipelineParsed('justwoker', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('justwoker', payload.model, text, location);
    logPipelineFinal('justwoker', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('justwoker', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('justwoker', payload.model, text, location);
    logPipelineFinal('justwoker', payload.model, raw);
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
    let wafRetry = 0;
    try {
      let stream: any;
      while (true) {
        try {
          stream = await this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...payload, stream: true }, keyInfo.key);
          break;
        } catch (error: any) {
          if (isWafBlock(error) && wafRetry < WAF_RETRY_COUNT) {
            const backoff = Math.min(WAF_RETRY_MAX_MS, WAF_RETRY_BASE_MS * Math.pow(2, wafRetry));
            wafRetry++;
            console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] WAF blocked  Retry=${wafRetry}/${WAF_RETRY_COUNT}  Backoff=${backoff}ms  Model=${model} [stream]`);
            await delay(backoff);
            continue;
          }
          throw error;
        }
      }
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      logSuccessLatency(keyInfo.tag, latency);
      console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('justwoker', model, `[streaming] stream established`, latency);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('justwoker', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[JUSTWOKER][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'justwoker', model, status, error: error.message ?? String(error), latencyMs: latency });
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
      console.warn('[JUSTWOKER] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('justwoker');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'justwoker' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'justwoker',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('justwoker'),
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
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'justwoker' })),
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
        provider: 'justwoker',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All JustWoker API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'justwoker',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'justwoker',
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
    const err: any = new Error('JustWoker provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'justwoker', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'justwoker', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // Fix #1: HTTP 200 but the body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('JustWoker', inline);
    }
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'justwoker', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'justwoker', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // Fix #1: HTTP 200 but the raw body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('JustWoker', inline);
    }
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'justwoker', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      // Fix #2: JustWoker requests must not be cut off at the global 30s timeout.
      // Apply the JustWoker-specific (120s) timeout consistently to normal AND
      // streaming requests so long generations can complete.
      timeout: this.timeout,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'justwoker', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    // Fix #1: Inspect the first SSE event(s). If the upstream turned a HTTP-200
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
          const err = createUpstreamError('JustWoker', {
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
