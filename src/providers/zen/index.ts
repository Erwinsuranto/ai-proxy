import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { randomUUID } from 'crypto';
import { Transform } from 'stream';
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
  providerId: 'zen',
  providerName: 'OpenCode Zen',
};

// Upstream endpoints (relative to baseUrl, e.g. https://opencode.ai/zen/v1).
const OPENAI_CHAT_ENDPOINT = '/chat/completions';
const MODELS_ENDPOINT = '/models';

/* Muse Spark free-tier models are NOT served by /chat/completions (upstream
 * answers HTTP 500 there). They are only served by the OpenAI Responses API
 * (/responses) under the OpenCode-client identity: `Bearer public` plus the
 * x-opencode-* session headers — i.e. exactly what the real OpenCode app
 * sends, which is why "opencode langsung bisa". Verified live 2026-09-11
 * (same shape as 9router's open-sse/executors/opencode.js). */
const RESPONSES_ENDPOINT = '/responses';

function isMuseSparkModel(model: string): boolean {
  return /muse[-_]?spark/i.test(model ?? '');
}

function newSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, '')}`;
}

function newRequestId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/* Best-effort upstream error body reader for server logs (never client-facing).
 * Stream error bodies are drained; circular objects fall back safely. */
async function readUpstreamErrorBody(data: any): Promise<string> {
  try {
    if (data && typeof data.on === 'function' && typeof data.read === 'function') {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        data.on('data', (c: any) => { try { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); } catch { /* ignore */ } });
        data.on('end', () => { clearTimeout(timer); resolve(); });
        data.on('error', () => { clearTimeout(timer); resolve(); });
      });
      return Buffer.concat(chunks).toString('utf-8').slice(0, 1000) || '(empty stream body)';
    }
    const s = JSON.stringify(data);
    return (s ?? String(data)).slice(0, 1000);
  } catch (e: any) {
    return `(unloggable error body: ${e?.message ?? e})`;
  }
}

/* Extracts plain text from chat message content (string or parts array).
 * Non-text parts (images, etc.) are dropped — the free tier can't serve them
 * and upstream 400s on unknown content shapes. */
function chatContentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && (c.type === 'text' || c.type === 'input_text') && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return ''; }
}

/* Translates an OpenAI chat-completions payload into an OpenAI Responses API
 * request body for Muse Spark models. */
function chatToResponsesBody(payload: any, stream: boolean): any {
  const input: any[] = [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : 'user';
    /* Tool results -> Responses function_call_output items. Sending them as
     * `{type:'message', role:'tool'}` makes upstream 400
     * ("did not match any supported type"). */
    if (role === 'tool') {
      const callId = (m as any).tool_call_id || (m as any).id || '';
      if (!callId) continue;
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: chatContentToText((m as any).content),
      });
      continue;
    }
    /* Assistant turn that made tool calls -> text message (if any) followed
     * by function_call items so the calls stay linked to their outputs. */
    if (role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0) {
      const text = chatContentToText((m as any).content);
      if (text) input.push({ type: 'message', role: 'assistant', content: text });
      for (const tc of (m as any).tool_calls) {
        if (!tc || tc.type !== 'function' || !tc.function?.name) continue;
        const args = tc.function.arguments;
        input.push({
          type: 'function_call',
          call_id: tc.id || undefined,
          name: tc.function.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        });
      }
      continue;
    }
    /* Plain user/system/developer message. Unknown roles are sent as user —
     * upstream only accepts user/assistant/system/developer here. */
    const text = chatContentToText((m as any).content);
    if (!text) continue;
    const safeRole = role === 'assistant' || role === 'system' || role === 'developer' ? role : 'user';
    input.push({ type: 'message', role: safeRole, content: text });
  }
  const body: any = { model: payload.model, input, stream };
  const maxOut = payload?.max_output_tokens ?? payload?.max_completion_tokens ?? payload?.max_tokens;
  if (maxOut !== undefined) body.max_output_tokens = maxOut;
  if (payload?.temperature !== undefined) body.temperature = payload.temperature;
  if (payload?.top_p !== undefined) body.top_p = payload.top_p;
  if (typeof payload?.instructions === 'string') body.instructions = payload.instructions;
  /* Chat function tools -> Responses function tools (same shape, `type`
   * stays 'function'). Custom/non-function tools are dropped. */
  if (Array.isArray(payload?.tools) && payload.tools.length > 0) {
    const fns = payload.tools
      .filter((t: any) => t && (t.type === 'function' || (!t.type && t.function?.name)) && t.function?.name)
      .map((t: any) => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    if (fns.length > 0) body.tools = fns;
  }
  if (payload?.tool_choice !== undefined) {
    const tc = payload.tool_choice;
    if (typeof tc === 'string') body.tool_choice = tc;
    else if (tc?.type === 'function' && tc?.function?.name) {
      body.tool_choice = { type: 'function', name: tc.function.name };
    }
  }
  return body;
}

function extractResponsesText(res: any): string {
  const out = Array.isArray(res?.output) ? res.output : [];
  const parts: string[] = [];
  for (const item of out) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

/* Translates an OpenAI Responses API result into an OpenAI chat-completion
 * object so the rest of the gateway (chat route, usage recording) works
 * unchanged. */
function responsesToChatCompletion(res: any, requestedModel: string): any {
  const status = res?.status;
  const out = Array.isArray(res?.output) ? res.output : [];
  const toolCalls: any[] = [];
  for (const item of out) {
    if (item?.type !== 'function_call' || !item?.name) continue;
    toolCalls.push({
      id: item.call_id || item.id,
      type: 'function',
      function: {
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? ''),
      },
    });
  }
  const finish = toolCalls.length > 0 ? 'tool_calls' : (status === 'incomplete' ? 'length' : 'stop');
  const usage = res?.usage;
  const message: any = { role: 'assistant', content: extractResponsesText(res) };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const chat: any = {
    id: res?.id ?? `resp-${Date.now()}`,
    object: 'chat.completion',
    created: res?.created_at ?? Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finish,
    }],
  };
  if (usage && typeof usage === 'object') {
    chat.usage = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    };
  }
  return chat;
}

/* Translates an upstream Responses-API SSE stream into OpenAI
 * chat-completions SSE chunks (`data: {...}` + `data: [DONE]`). */
function createResponsesToChatStream(model: string): Transform {
  let buf = '';
  let respId = `resp-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let finished = false;
  let hasToolCalls = false;
  let tcCounter = 0;
  const tcIndexByItem = new Map<string, number>();

  const chatChunk = (delta: any, finish: string | null, usage?: any): string => {
    const chunk: any = {
      id: respId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };
  const toChatUsage = (u: any): any => ({
    prompt_tokens: u?.input_tokens ?? 0,
    completion_tokens: u?.output_tokens ?? 0,
    total_tokens: u?.total_tokens ?? 0,
  });

  const handleEvent = (event: string, data: any, push: (s: string) => void): void => {
    if (finished) return;
    const type = typeof data?.type === 'string' ? data.type : event;
    if (type === 'response.created' || type === 'response.in_progress') {
      const r = data?.response;
      if (r?.id) respId = r.id;
      if (r?.created_at) created = r.created_at;
      return;
    }
    if (type === 'response.output_text.delta') {
      const delta = typeof data?.delta === 'string' ? data.delta : '';
      if (!delta) return;
      if (!roleSent) {
        roleSent = true;
        push(chatChunk({ role: 'assistant', content: '' }, null));
      }
      push(chatChunk({ content: delta }, null));
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      finished = true;
      const r = data?.response;
      if (r?.id) respId = r.id;
      if (r?.created_at) created = r.created_at;
      const finish = hasToolCalls ? 'tool_calls' : (type === 'response.incomplete' ? 'length' : 'stop');
      push(chatChunk({}, finish, r?.usage ? toChatUsage(r.usage) : undefined));
      push('data: [DONE]\n\n');
      return;
    }
    if (type === 'response.failed') {
      finished = true;
      push(chatChunk({}, 'error'));
      push('data: [DONE]\n\n');
      return;
    }
    if (type === 'response.output_item.added') {
      const item = data?.item;
      if (item?.type === 'function_call') {
        const key = String(item.call_id || item.id || `tc${tcCounter}`);
        let idx = tcIndexByItem.get(key);
        if (idx === undefined) {
          idx = tcCounter++;
          tcIndexByItem.set(key, idx);
        }
        hasToolCalls = true;
        if (!roleSent) {
          roleSent = true;
          push(chatChunk({ role: 'assistant', content: '' }, null));
        }
        push(chatChunk({
          tool_calls: [{
            index: idx,
            id: item.call_id || item.id,
            type: 'function',
            function: { name: item.name || '', arguments: '' },
          }],
        }, null));
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = String(data?.item_id || '');
      const idx = tcIndexByItem.get(key) ?? 0;
      const delta = typeof data?.delta === 'string' ? data.delta : '';
      if (!delta) return;
      hasToolCalls = true;
      if (!roleSent) {
        roleSent = true;
        push(chatChunk({ role: 'assistant', content: '' }, null));
      }
      push(chatChunk({ tool_calls: [{ index: idx, function: { arguments: delta } }] }, null));
      return;
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        buf += chunk.toString();
        const out: string[] = [];
        const push = (s: string): void => { out.push(s); };
        for (;;) {
          const idx = buf.indexOf('\n\n');
          if (idx === -1) break;
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = '';
          const dataLines: string[] = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          const payload = dataLines.join('\n');
          if (payload === '[DONE]') continue;
          let parsed: any;
          try { parsed = JSON.parse(payload); } catch { continue; }
          handleEvent(event || parsed?.type || '', parsed, push);
        }
        callback(null, Buffer.from(out.join('')));
      } catch (err: any) {
        callback(err);
      }
    },
    flush(callback) {
      if (!finished) {
        finished = true;
        callback(null, Buffer.from(`${chatChunk({}, 'stop')}data: [DONE]\n\n`));
      } else {
        callback(null, Buffer.from(''));
      }
    },
  });
}

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

export function createZenKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'OpenCode Zen');
}

function createAllKeysCooldownError(): any {
  const err: any = new Error('All OpenCode Zen API keys are currently in cooldown. Please wait before retrying.');
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
  const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'OpenCode Zen API error';
  const err: any = new Error(`OpenCode Zen API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

export class ZenProvider implements Provider {
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

  /* OpenCode-client identity for the Responses API (free tier). Auth is the
   * fixed `Bearer public` token — account API keys are NOT used here. */
  private buildResponsesHeaders(): Record<string, string> {
    return {
      'Authorization': 'Bearer public',
      'Content-Type': 'application/json',
      'User-Agent': 'opencode',
      'x-opencode-client': 'desktop',
      'x-opencode-session': newSessionId(),
      'x-opencode-request': newRequestId(),
      'x-opencode-project': 'global',
    };
  }

  /* POST to the Responses API (Muse Spark path — no key rotation, the free
   * tier quota is per egress IP, not per key). */
  private async responsesRequest(body: any, model: string): Promise<any> {
    logPipelineRequest({ provider: 'zen', baseUrl: this.baseUrl, endpoint: RESPONSES_ENDPOINT, model, protocol: 'openai-responses', keyMasked: 'public' });
    const start = Date.now();
    try {
      const response = await this.client.post(RESPONSES_ENDPOINT, body, {
        headers: this.buildResponsesHeaders(),
      });
      logPipelineRaw({ provider: 'zen', model, endpoint: RESPONSES_ENDPOINT, protocol: 'openai-responses', status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
      console.log(`[ZEN] Responses API success  Model=${model}  Latency=${Date.now() - start}ms`);
      return response.data;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      console.log(`[ZEN] Responses API failed  Model=${model}  Status=${status}  Error=${error.message ?? 'unknown'}`);
      console.log(`[ZEN] Responses API error body: ${await readUpstreamErrorBody(error?.response?.data)}`);
      logPipelineError({ provider: 'zen', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  private logSelection(endpoint: string, model: string, keyInfo: KeyInfo): void {
    console.log(`[ZEN] Base URL: ${this.baseUrl}`);
    console.log(`[ZEN] Endpoint: POST ${this.baseUrl}${endpoint}`);
    console.log(`[ZEN] Backend model: ${model}`);
    console.log(`[ZEN] API key index: KEY#${keyInfo.index + 1} (${maskKeySuffix(keyInfo.key)})`);
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
      console.log(`[ZEN][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('zen', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[ZEN][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[ZEN][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'zen', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
  }

  // --- OpenAI-compatible endpoint: POST /v1/chat/completions ---

  async chatCompletion(payload: any): Promise<any> {
    if (isMuseSparkModel(payload.model)) {
      const res = await this.responsesRequest(chatToResponsesBody(payload, false), payload.model);
      const chat = responsesToChatCompletion(res, payload.model);
      logPipelineParsed('zen', payload.model, chat, true);
      const { text, location } = findTextInResponse(chat);
      logPipelineExtracted('zen', payload.model, text, location);
      logPipelineFinal('zen', payload.model, chat);
      return chat;
    }
    const result = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequest('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    logPipelineParsed('zen', payload.model, result, true);
    const { text, location } = findTextInResponse(result);
    logPipelineExtracted('zen', payload.model, text, location);
    logPipelineFinal('zen', payload.model, result);
    return result;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    if (isMuseSparkModel(payload.model)) {
      const res = await this.responsesRequest(chatToResponsesBody(payload, false), payload.model);
      const chat = responsesToChatCompletion(res, payload.model);
      logPipelineParsed('zen', payload.model, chat, true);
      const { text, location } = findTextInResponse(chat);
      logPipelineExtracted('zen', payload.model, text, location);
      logPipelineFinal('zen', payload.model, chat);
      return JSON.stringify(chat);
    }
    const raw = await this.executeWithKey(OPENAI_CHAT_ENDPOINT, payload.model, (key) =>
      this.makeRequestRaw('post', OPENAI_CHAT_ENDPOINT, payload, key),
    );
    const parsed = parseResponseBody(raw);
    logPipelineParsed('zen', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('zen', payload.model, text, location);
    logPipelineFinal('zen', payload.model, raw);
    return raw;
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const { model } = payload;
    if (isMuseSparkModel(model)) {
      const start = Date.now();
      console.log(`[ZEN] Base URL: ${this.baseUrl}`);
      console.log(`[ZEN] Endpoint: POST ${this.baseUrl}${RESPONSES_ENDPOINT} (openai-responses)`);
      console.log(`[ZEN] Backend model: ${model}`);
      try {
        const response = await this.client.post(
          RESPONSES_ENDPOINT,
          chatToResponsesBody(payload, true),
          {
            headers: { ...this.buildResponsesHeaders(), Accept: 'text/event-stream' },
            responseType: 'stream',
            timeout: 0,
          } as AxiosRequestConfig,
        );
        logPipelineRaw({ provider: 'zen', model, endpoint: RESPONSES_ENDPOINT, protocol: 'openai-responses', status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
        logPipelineFinal('zen', model, `[streaming] responses stream established`, Date.now() - start);
        const translated = createResponsesToChatStream(model);
        response.data.on('error', (err: Error) => translated.destroy(err));
        response.data.pipe(translated);
        return { stream: translated, keyIndex: -1, tag: 'zen-responses' };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      console.log(`[ZEN] Responses API failed  Model=${model}  Status=${status}  Error=${error.message ?? 'unknown'}`);
      console.log(`[ZEN] Responses API error body: ${await readUpstreamErrorBody(error?.response?.data)}`);
      logPipelineError({ provider: 'zen', model, status, error: error.message ?? String(error), latencyMs: latency });
      throw wrapError(error);
    }
    }
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
      console.log(`[ZEN][KEY#${keyInfo.index + 1}] Success  Model=${model}  Latency=${latency}ms`);
      logPipelineFinal('zen', model, `[streaming] stream established`, latency);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        logRateLimited(keyInfo.tag, COOLDOWN_DURATION_MS / 1000);
        logPipelineRateLimit('zen', model, COOLDOWN_DURATION_MS / 1000, status);
        console.log(`[ZEN][KEY#${keyInfo.index + 1}] Status=${status}  RateLimited  Cooldown=${COOLDOWN_DURATION_MS / 1000}s`);
      } else {
        this.keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        console.log(`[ZEN][KEY#${keyInfo.index + 1}] Failed  Status=${status}  Error=${error.message ?? 'unknown'}`);
      }
      logPipelineError({ provider: 'zen', model, status, error: error.message ?? String(error), latencyMs: latency });
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
      console.warn('[ZEN] listModels: no key available — using last-known-good cache');
      const cached = discoveryStore.getLastGoodModels('zen');
      return {
        object: 'list',
        source: cached.length > 0 ? 'cache' : 'fallback',
        data: cached.length > 0 ? cached : FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'zen' })),
      };
    }

    logRequest(keyInfo.tag, 'models');

    const { outcome, models } = await runDiscovery({
      provider: 'zen',
      url: `${this.baseUrl}${MODELS_ENDPOINT}`,
      request: async () => {
        const r = await this.client.get(MODELS_ENDPOINT, { headers: this.buildHeaders(keyInfo.key) });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: openAIModelExtractor('zen'),
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

    const mergeFallback = (apiModels: any[]): any[] => {
      const apiIds = new Set(apiModels.map((m: any) => (typeof m === 'string' ? m : m.id)?.toLowerCase()));
      const nowSec = Math.floor(Date.now() / 1000);
      for (const id of FALLBACK_MODELS) {
        if (!apiIds.has(id.toLowerCase())) {
          apiModels.push({ id, object: 'model', created: nowSec, owned_by: 'zen' });
        }
      }
      return apiModels;
    };

    if (outcome.status === 'healthy') {
      cachedModels = mergeFallback(models);
      lastModelFetch = now;
      return { object: 'list', source: 'api', data: cachedModels };
    }
    if (models.length > 0) {
      return { object: 'list', source: 'cache', data: mergeFallback(models) };
    }
    return {
      object: 'list',
      source: 'fallback',
      data: FALLBACK_MODELS.map((id) => ({ id, object: 'model', created: Math.floor(now / 1000), owned_by: 'zen' })),
    };
  }

  async healthCheck(): Promise<any> {
    const start = Date.now();
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getFirstActiveKey();
    } catch {
      return {
        provider: 'zen',
        baseUrl: this.baseUrl,
        ok: false,
        status: 429,
        latency: Date.now() - start,
        models: 0,
        error: 'All OpenCode Zen API keys are currently in cooldown',
      };
    }

    try {
      const response = await this.client.get(MODELS_ENDPOINT, {
        headers: this.buildHeaders(keyInfo.key),
        timeout: Math.min(5000, this.timeout || 5000),
      });
      const latency = Date.now() - start;
      return {
        provider: 'zen',
        baseUrl: this.baseUrl,
        ok: true,
        status: response.status,
        latency,
        models: Array.isArray(response.data?.data) ? response.data.data.length : 0,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      return {
        provider: 'zen',
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
    const err: any = new Error('OpenCode Zen provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string, extraConfig?: AxiosRequestConfig): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'zen', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      ...extraConfig,
      headers: { ...this.buildHeaders(apiKey), ...extraConfig?.headers },
    });
    logPipelineRaw({ provider: 'zen', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'zen', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({
      method: method as any,
      url,
      data,
      headers: this.buildHeaders(apiKey),
      responseType: 'text',
    });
    logPipelineRaw({ provider: 'zen', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    const model = data?.model ?? 'n/a';
    logPipelineRequest({ provider: 'zen', baseUrl: this.baseUrl, endpoint: url, model, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, {
      headers: this.buildHeaders(apiKey),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    logPipelineRaw({ provider: 'zen', model, endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }
}