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
const PROTOCOL = 'openai';

/** True for any Claude family (opus, sonnet, fable, haiku, etc.) via SeekAI. */
function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes('claude');
}

/** Back-compat alias — now covers all Claude, not only Opus. */
function isClaudeOpus(model: string): boolean {
  return isClaudeModel(model);
}

/** Detect an empty Claude completion that should be retried.
 *  Empty = choices[0].message.content is ""/whitespace, no tool_calls, no reasoning,
 *  and finish_reason is stop/length. Tool-calls with empty content are VALID (not empty).
 *  Applies to ALL Claude variants (opus / sonnet / fable / haiku) via SeekAI. */
function isEmptyClaudeResponse(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.choices) || data.choices.length === 0) return false;
  const choice = data.choices[0];
  const msg = choice?.message;
  if (!msg) return false;
  // Tool calls present -> not empty (proxy forwards them)
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false;
  if (msg.function_call) return false;
  const content = msg.content;
  const hasContent = typeof content === 'string' ? content.trim().length > 0 : false;
  if (hasContent) return false;
  // Also consider reasoning_content as content for empty check? If reasoning present but content empty, still empty for text client
  // we treat pure empty as error only when finish_reason indicates complete (stop/length)
  const fr = choice.finish_reason;
  if (fr === 'tool_calls') return false; // already handled
  // Any array content with text blocks -> not empty
  if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === 'string' && b.trim()) return false;
      if (b && typeof b.text === 'string' && b.text.trim()) return false;
      // Anthropic content blocks may be {type:'text', text:'...'}
      if (b && typeof b.content === 'string' && b.content.trim()) return false;
    }
  }
  // Also check reasoning content — if present, not considered empty for retry?
  // For Claude text clients, pure empty string with finish_reason stop/length is still empty
  return true;
}

// Back-compat alias for older call sites / tests
function isEmptyOpusResponse(data: any): boolean {
  return isEmptyClaudeResponse(data);
}

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'seekai',
  providerName: 'SeekAI',
};

// Upstream endpoints (relative to baseUrl, e.g. https://seekai.cc/v1).
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

export function createSeekAIKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'SeekAI');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All SeekAI API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'SeekAI API error';
  const err: any = new Error(`SeekAI API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class SeekAIProvider implements Provider {
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
    console.log(`[SEEKAI] Base URL: ${this.baseUrl}`);
    console.log(`[SEEKAI] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[SEEKAI] Backend model: ${model}`);
    console.log(`[SEEKAI] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
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
      console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('seekai', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'seekai', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- OpenAI-compatible endpoint: POST /v1/chat/completions ---
  // The payload is forwarded as-is (OpenAI Chat Completions format), which
  // transparently supports tool calls, vision (image_url content parts), and
  // other OpenAI-compatible fields without special handling.

  async chatCompletion(payload: any): Promise<any> {
    // Claude family (opus/sonnet/fable/haiku): retry across keys when upstream returns 502/503 or empty content
    const maxAttempts = isClaudeModel(payload.model) ? Math.min(3, this.keyManager.keyCount) : 1;
    let lastError: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
          this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
        );
        // Fix Claude empty: upstream returned 200 with content="" and no tool_calls
        if (isClaudeModel(payload.model) && isEmptyClaudeResponse(result)) {
          console.warn(`[SEEKAI][CLAUDE-EMPTY] Model=${payload.model} attempt ${attempt + 1}/${maxAttempts} got empty content, retrying`);
          logPipelineError({ provider: 'seekai', model: payload.model, status: 502, error: 'empty claude response', latencyMs: 0 });
          throw createUpstreamError('SeekAI', { status: 502, message: 'Empty Claude response, retrying' });
        }
        logPipelineParsed('seekai', payload.model, result, true);
        const { text, location } = findTextInResponse(result);
        // For Claude tool_calls, log as tool_calls instead of no-text-field-found
        const isTool = (result as any)?.choices?.[0]?.message?.tool_calls?.length > 0;
        logPipelineExtracted('seekai', payload.model, text, isTool && !text ? 'tool_calls' : location);
        logPipelineFinal('seekai', payload.model, result);
        return result;
      } catch (e: any) {
        lastError = e;
        const status = getStatus(e);
        // Only retry on retryable / empty for Claude, otherwise bubble immediately
        if (!isClaudeModel(payload.model) || attempt === maxAttempts - 1) throw e;
        if (status === 429 || status === 502 || status === 503 || status === 504 || status === 0 || e?.message?.includes('Empty Claude')) {
          console.log(`[SEEKAI][CLAUDE-RETRY] Model=${payload.model} attempt ${attempt + 1} failed status=${status}, trying next key`);
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const maxAttempts = isClaudeModel(payload.model) ? Math.min(3, this.keyManager.keyCount) : 1;
    let lastError: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
          this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
        );
        const parsed = parseResponseBody(raw);
        if (isClaudeModel(payload.model) && parsed.wasJson && isEmptyClaudeResponse(parsed.body)) {
          console.warn(`[SEEKAI][CLAUDE-EMPTY-RAW] Model=${payload.model} attempt ${attempt + 1}/${maxAttempts} got empty content, retrying`);
          throw createUpstreamError('SeekAI', { status: 502, message: 'Empty Claude response (raw), retrying' });
        }
        logPipelineParsed('seekai', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
        const { text, location } = findTextInResponse(parsed.body ?? raw);
        const isToolRaw = typeof parsed.body === 'object' && (parsed.body as any)?.choices?.[0]?.message?.tool_calls?.length > 0;
        logPipelineExtracted('seekai', payload.model, text, isToolRaw && !text ? 'tool_calls' : location);
        logPipelineFinal('seekai', payload.model, raw);
        return raw;
      } catch (e: any) {
        lastError = e;
        const status = getStatus(e);
        if (!isClaudeModel(payload.model) || attempt === maxAttempts - 1) throw e;
        if (status === 429 || status === 502 || status === 503 || status === 504 || status === 0 || e?.message?.includes('Empty Claude')) {
          console.log(`[SEEKAI][CLAUDE-RETRY-RAW] Model=${payload.model} attempt ${attempt + 1} failed status=${status}, trying next key`);
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    // Claude family streaming: retry across keys on 502/503 and empty content
    const maxAttempts = isClaudeModel(model) ? Math.min(3, this.keyManager.keyCount) : 1;
    let lastError: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        let stream = await this.makeStreamRequest(OPENAI_CHAT_ENDPOINT, { ...payload, stream: true }, keyInfo.key);
        // For Claude, ensure the stream actually carries content (not empty). This wraps
        // the upstream stream, buffers until first content/tool_calls or stream end,
        // and rejects as upstream error when the stream ends empty (triggers key retry).
        if (isClaudeModel(model)) {
          stream = await this.ensureClaudeStreamNotEmpty(stream, model);
        }
        const latency = Date.now() - start;
        this.keyManager.markSuccess(keyInfo.index, latency);
        logSuccessLatency(keyInfo.tag, latency);
        console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
        logPipelineFinal('seekai', model, `[streaming] stream established`, latency);
        return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
      } catch (error: any) {
        lastError = error;
        const latency = Date.now() - start;
        const status = getStatus(error);
        if (isQuotaError(error)) {
          this.keyManager.markCooldown(keyInfo.index);
          logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
          logPipelineRateLimit('seekai', model, COOLDOWN_DURATION_MS / 1000, status);
          console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
        } else {
          this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
          console.log(`[SEEKAI][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
        }
        logPipelineError({ provider: 'seekai', model, status, error: error.message ?? String(error), latencyMs: latency });
        const wrapped = wrapError(error);
        if (!isClaudeModel(model) || attempt === maxAttempts - 1) throw wrapped;
        if (status === 429 || status === 502 || status === 503 || status === 504 || status === 0 || String(error?.message ?? '').includes('Empty Claude')) {
          console.log(`[SEEKAI][CLAUDE-STREAM-RETRY] Model=${model} attempt ${attempt + 1} failed status=${status}, trying next key`);
          continue;
        }
        throw wrapped;
      }
    }
    throw wrapError(lastError);
  }

  /**
   * For Claude via SeekAI: ensure a streaming response actually contains assistant
   * content or tool_calls. Upstream occasionally returns HTTP 200 with a stream that
   * ends immediately (or after only empty deltas) → client sees "pesan kosong".
   * We buffer until first content/tool_calls appears or the stream ends. If the
   * stream ends with no content and no tool_calls we surface it as a 502 upstream
   * error so the caller can retry the next key (and ultimately fallback to another
   * provider). For genuine streams we replay the buffered bytes first so nothing
   * is lost and first-token latency is only the time to the first content chunk.
   */
  private async ensureClaudeStreamNotEmpty(upstream: any, model: string): Promise<any> {
    if (!upstream || typeof upstream.on !== 'function') return upstream;
    return new Promise((resolve, reject) => {
      const passthrough = new PassThrough();
      const bufferedChunks: Buffer[] = [];
      let pending = '';
      let contentSeen = '';
      let hasTool = false;
      let hasContent = false;
      let upstreamEnded = false;
      let settled = false;

      const flushBuffered = () => {
        for (const c of bufferedChunks) {
          if (!passthrough.destroyed) passthrough.write(c);
        }
        bufferedChunks.length = 0;
      };

      const cleanup = () => {
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onError);
      };

      const settleSuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushBuffered();
        // Pipe the remainder of upstream directly to passthrough
        try {
          upstream.pipe(passthrough);
        } catch {
          // ignore
        }
        cleanup();
        resolve(passthrough);
      };

      const settleEmpty = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (!passthrough.destroyed) passthrough.destroy();
        if (!upstream.destroyed) upstream.destroy();
        const err = createUpstreamError('SeekAI', { status: 502, message: 'Empty Claude response (stream), retrying' });
        console.warn(`[SEEKAI][CLAUDE-EMPTY-STREAM] Model=${model} got empty stream, retrying`);
        logPipelineError({ provider: 'seekai', model, status: 502, error: 'empty claude stream', latencyMs: 0 });
        reject(err);
      };

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        // Buffer for replay
        bufferedChunks.push(Buffer.from(chunk));
        pending += text;

        // Extract complete lines
        let idx: number;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
          const content = stripped.startsWith('data:') ? stripped.slice(5).trim() : stripped.trim();
          if (!content || content === '[DONE]') continue;
          try {
            const parsed = JSON.parse(content);
            const choices = parsed?.choices;
            if (Array.isArray(choices)) {
              for (const c of choices as any[]) {
                const deltaText: any = c?.delta?.content ?? c?.message?.content;
                if (typeof deltaText === 'string' && deltaText.trim().length > 0) {
                  hasContent = true;
                  contentSeen += deltaText;
                }
                if (Array.isArray(deltaText)) {
                  for (const b of deltaText) {
                    if (typeof b === 'string' && b.trim()) hasContent = true;
                    if (b && typeof b.text === 'string' && b.text.trim()) hasContent = true;
                  }
                }
                if (c?.delta?.tool_calls && Array.isArray(c.delta.tool_calls) && c.delta.tool_calls.length > 0) hasTool = true;
                if (c?.message?.tool_calls && Array.isArray(c.message.tool_calls) && c.message.tool_calls.length > 0) hasTool = true;
                if (c?.delta?.function_call || c?.message?.function_call) hasTool = true;
              }
            }
            // Top-level tool_calls (some providers)
            if ((parsed as any)?.tool_calls && Array.isArray((parsed as any).tool_calls) && (parsed as any).tool_calls.length > 0) hasTool = true;
          } catch {
            // non-JSON line — treat any non-empty line as content (conservative)
            if (content.length > 0 && content !== '[DONE]') {
              // ignore plain text non-JSON; not counted as content
            }
          }
        }
        if (hasContent || hasTool) {
          settleSuccess();
        }
      };

      const onEnd = () => {
        upstreamEnded = true;
        // Process any trailing pending without newline
        if (pending.length > 0 && !settled) {
          const stripped = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
          const content = stripped.startsWith('data:') ? stripped.slice(5).trim() : stripped.trim();
          if (content && content !== '[DONE]') {
            try {
              const parsed = JSON.parse(content);
              const choices = parsed?.choices;
              if (Array.isArray(choices)) {
                for (const c of choices as any[]) {
                  const deltaText: any = c?.delta?.content ?? c?.message?.content;
                  if (typeof deltaText === 'string' && deltaText.trim().length > 0) hasContent = true;
                  if (c?.delta?.tool_calls && Array.isArray(c.delta.tool_calls) && c.delta.tool_calls.length > 0) hasTool = true;
                }
              }
            } catch { /* ignore */ }
          }
        }
        if (hasContent || hasTool) {
          settleSuccess();
        } else {
          settleEmpty();
        }
      };

      const onError = (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (!passthrough.destroyed) passthrough.destroy();
        reject(err);
      };

      // Safety: if upstream is silent for too long, flush and return stream as-is
      // (still monitors for empty at end via wrapper). This prevents hanging.
      const timer = setTimeout(() => {
        if (settled) return;
        if (upstreamEnded) {
          if (hasContent || hasTool) settleSuccess();
          else settleEmpty();
          return;
        }
        // Stream still ongoing but no content yet after 7s — release buffered data
        // and continue piping; empty will be detected at actual end.
        // We create a second-stage wrapper that still tracks content for final empty check.
        // For now, just release as success; final empty will be caught via end handler
        // that still has hasContent/hasTool tracking after piping.
        // To keep tracking, we keep onData/onEnd listeners and also pipe remaining.
        // Instead of settling now, we just flush and pipe while keeping listeners for final verdict.
        // But to avoid double-pipe, we settle as success and keep a lightweight monitor.
        settleSuccess();
        // After settling, we continue to track content for logging, but no longer reject.
        // Attach a monitor that only logs if stream later ends empty (not reject).
        let finalHasContent = hasContent;
        let finalHasTool = hasTool;
        const monitorData = (chunk: Buffer) => {
          const t = chunk.toString();
          // quick check for content without full parse (best-effort)
          if (t.includes('"content"') && t.includes('"text"')) finalHasContent = true;
          if (t.includes('tool_calls')) finalHasTool = true;
        };
        const monitorEnd = () => {
          if (!finalHasContent && !finalHasTool) {
            console.warn(`[SEEKAI][CLAUDE-EMPTY-STREAM-LATE] Model=${model} stream ended empty after timeout`);
          }
          passthrough.removeListener('data', monitorData as any);
          passthrough.removeListener('end', monitorEnd);
        };
        passthrough.on('data', monitorData as any);
        passthrough.on('end', monitorEnd);
      }, 7000);

      upstream.on('data', onData);
      upstream.on('end', onEnd);
      upstream.on('error', onError);
    });
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
      console.warn('[SEEKAI] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('seekai');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'seekai' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'seekai',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('seekai'),
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
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'seekai' })),
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
        provider: 'seekai',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All SeekAI API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'seekai',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'seekai',
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
    const err: any = new Error('SeekAI provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'seekai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'seekai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // Fix #1: HTTP 200 but the body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('SeekAI', inline);
    }
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'seekai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'seekai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    // Fix #1: HTTP 200 but the raw body is actually an inline upstream error.
    const inline = detectInlineUpstreamError(response.data);
    if (inline) {
      throw createUpstreamError('SeekAI', inline);
    }
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'seekai', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      // Fix #2: SeekAI requests must not be cut off at the global 30s timeout.
      // Apply the SeekAI-specific (120s) timeout consistently to normal AND
      // streaming requests so long generations can complete.
      timeout: this.timeout,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'seekai', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
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
          const err = createUpstreamError('SeekAI', {
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
