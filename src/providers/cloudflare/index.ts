import axios, { AxiosInstance } from 'axios';
import { Transform } from 'stream';
import { Provider, ProviderInfo, CLOUDFLARE_MODEL_MAP } from '../../lib/types';
import { MODELS as FALLBACK_MODELS } from './models';
import { runDiscovery, discoveryStore } from '../../lib/discovery';
import { isRetryableError, isQuotaError } from '../../lib/retry';
import { KeyManager } from '../../lib/key-manager';
import { v4 as uuidv4 } from 'uuid';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse, normalizeToOpenAI } from '../../lib/pipeline';

const MAX_RETRIES = 3;
const PROTOCOL = 'cloudflare';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'cloudflare',
  providerName: 'Cloudflare',
};

function maskToken(token: string): string {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function extractResponseBody(error: any): string {
  try {
    const data = error?.response?.data;
    if (!data) return '(no response body)';
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 2000);
    return JSON.stringify(data).slice(0, 2000);
  } catch {
    return '(unable to read response body)';
  }
}

function wrapError(error: any, prefix: string): any {
  const status = getStatus(error) || 500;
  let errorBody: any = error?.response?.data;
  if (typeof errorBody === 'string') {
    try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
  }
  const apiMsg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'Internal Server Error';
  const err: any = new Error(`${prefix} API error (${status}): ${apiMsg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

function buildEndpoint(accountId: string, model: string): string {
  const encodedModel = encodeURIComponent(model);
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
}

function createStreamTransform(model: string): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: Function) {
      try {
        const text = chunk.toString();
        const lines = text.split('\n');
        let result = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === 'data: [DONE]') {
            result += trimmed + '\n\n';
            continue;
          }
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              const responseText = parsed?.response ?? '';
              const openaiChunk = {
                id: `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 12)}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: responseText || null,
                  },
                  finish_reason: null,
                  logprobs: null,
                }],
              };
              result += `data: ${JSON.stringify(openaiChunk)}\n\n`;
            } catch {
              result += trimmed + '\n\n';
            }
          }
        }
        callback(null, Buffer.from(result));
      } catch (err: any) {
        callback(err);
      }
    },
  });
}

export class CloudflareProvider implements Provider {
  private accountId: string;
  private timeout: number;
  private keyManager: KeyManager;

  constructor(keyManager: KeyManager, accountId: string, timeout: number) {
    this.keyManager = keyManager;
    this.accountId = accountId;
    this.timeout = timeout;
  }

  getProviderInfo(): ProviderInfo {
    return PROVIDER_INFO;
  }

  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  private async withToken<T>(fn: (token: string) => Promise<T>, model: string): Promise<T> {
    const tokenInfo = await this.keyManager.getNextKey();
    console.log(`[Provider=Cloudflare] ${tokenInfo.tag}`);
    return fn(tokenInfo.key);
  }

  private async retry<T>(fn: (token: string) => Promise<T>, model: string): Promise<T> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const start = Date.now();
      console.log(`[Provider=Cloudflare] Model=${model}  Attempt=${attempt + 1}/${MAX_RETRIES + 1}`);
      try {
        const result = await this.withToken((token) => fn(token), model);
        const latency = Date.now() - start;
        console.log(`[Provider=Cloudflare] Model=${model}  Latency=${latency}ms  Status=200`);
        return result;
      } catch (error: any) {
        const latency = Date.now() - start;
        lastError = error;
        const status = getStatus(error);
        console.log(`[Provider=Cloudflare] Model=${model}  Latency=${latency}ms  Status=${status}  Error=${error.message ?? 'unknown'}`);

        if (attempt < MAX_RETRIES && isRetryableError(error)) {
          if (isQuotaError(error)) {
            const waitMs = 1000 * Math.pow(2, attempt);
            console.log(`[Provider=Cloudflare] Rate limited, waiting ${waitMs}ms before retry  Attempt=${attempt + 1}`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          logPipelineError({ provider: 'cloudflare', model, status, error: error.message ?? String(error), latencyMs: latency, retry: true });
          continue;
        }
        logPipelineError({ provider: 'cloudflare', model, status, error: error.message ?? String(error), latencyMs: latency });
        break;
      }
    }
    throw wrapError(lastError, 'Cloudflare');
  }

  async chatCompletion(payload: any): Promise<any> {
    const model = payload.model;
    const url = buildEndpoint(this.accountId, model);
    const cfPayload = { messages: payload.messages };

    const data = await this.retry(
      (token) => this.makeRequest(url, cfPayload, token),
      model,
    );

    const normalized = normalizeToOpenAI(data, model);
    logPipelineParsed('cloudflare', model, data, true);
    const { text, location } = findTextInResponse(data);
    logPipelineExtracted('cloudflare', model, text, location);
    logPipelineFinal('cloudflare', model, normalized);
    return normalized;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const model = payload.model;
    const url = buildEndpoint(this.accountId, model);
    const cfPayload = { messages: payload.messages };

    const raw = await this.retry(
      (token) => this.makeRequestRaw(url, cfPayload, token),
      model,
    );

    const parsed = parseResponseBody(raw);
    logPipelineParsed('cloudflare', model, parsed.body, parsed.wasJson, parsed.parseError);
    const { text, location } = findTextInResponse(parsed.body ?? raw);
    logPipelineExtracted('cloudflare', model, text, location);
    const normalized = normalizeToOpenAI(parsed.body ?? raw, model);
    logPipelineFinal('cloudflare', model, normalized);
    return JSON.stringify(normalized);
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const model = payload.model;
    const url = buildEndpoint(this.accountId, model);
    const cfPayload = { messages: payload.messages, stream: true };

    const rawStream = await this.retry(
      (token) => this.makeStreamRequest(url, cfPayload, token),
      model,
    );

    logPipelineFinal('cloudflare', model, `[streaming] stream established`);

    const transform = createStreamTransform(model);
    rawStream.pipe(transform);

    return { stream: transform, keyIndex: 0, tag: '[Cloudflare]' };
  }

  async listModels(): Promise<any> {
    const staticFallback = () => ({
      object: 'list',
      data: FALLBACK_MODELS.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'cloudflare',
      })),
    });

    let tokenInfo: { key: string };
    try {
      tokenInfo = await this.keyManager.getNextKey();
    } catch {
      const cached = discoveryStore.getLastGoodModels('cloudflare');
      return cached.length > 0 ? { object: 'list', data: cached } : staticFallback();
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/models`;
    const { outcome, models } = await runDiscovery({
      provider: 'cloudflare',
      url,
      request: async () => {
        const r = await axios.get(url, {
          headers: { Authorization: `Bearer ${tokenInfo.key}` },
          timeout: this.timeout,
        });
        return { status: r.status, headers: r.headers as any, data: r.data };
      },
      extract: (data: any) => {
        const list = Array.isArray(data?.result?.data)
          ? data.result.data
          : Array.isArray(data?.result)
            ? data.result
            : Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data)
                ? data
                : null;
        if (list === null) return null;
        const now = Math.floor(Date.now() / 1000);
        return list
          .map((m: any) => ({ id: typeof m === 'string' ? m : m?.id, object: 'model', created: now, owned_by: 'cloudflare' }))
          .filter((m: any) => !!m.id);
      },
    });

    if (outcome.status === 'healthy') {
      return { object: 'list', data: models };
    }
    if (models.length > 0) {
      return { object: 'list', data: models };
    }
    return staticFallback();
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('Cloudflare provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(url: string, data: any, token: string): Promise<any> {
    logPipelineRequest({ provider: 'cloudflare', baseUrl: buildEndpoint(this.accountId, data?.model ?? 'n/a'), endpoint: '/ai/v1/chat/completions', model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskToken(token) });
    const start = Date.now();
    try {
      const response = await axios.post(url, data, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: this.timeout,
      });
      logPipelineRaw({ provider: 'cloudflare', model: data?.model ?? 'n/a', endpoint: '/ai/v1/chat/completions', protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
      return response.data;
    } catch (error: any) {
      const status = getStatus(error);
      const respBody = extractResponseBody(error);
      console.log(`[Provider=Cloudflare] Error response: Status=${status}  Body=${respBody}`);
      throw error;
    }
  }

  private async makeRequestRaw(url: string, data: any, token: string): Promise<string> {
    logPipelineRequest({ provider: 'cloudflare', baseUrl: buildEndpoint(this.accountId, data?.model ?? 'n/a'), endpoint: '/ai/v1/chat/completions', model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskToken(token) });
    const start = Date.now();
    try {
      const response = await axios.post(url, data, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: this.timeout,
        responseType: 'text',
      });
      logPipelineRaw({ provider: 'cloudflare', model: data?.model ?? 'n/a', endpoint: '/ai/v1/chat/completions', protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
      return response.data;
    } catch (error: any) {
      const status = getStatus(error);
      const respBody = extractResponseBody(error);
      console.log(`[Provider=Cloudflare] Error response: Status=${status}  Body=${respBody}`);
      throw error;
    }
  }

  private async makeStreamRequest(url: string, data: any, token: string): Promise<any> {
    logPipelineRequest({ provider: 'cloudflare', baseUrl: buildEndpoint(this.accountId, data?.model ?? 'n/a'), endpoint: '/ai/v1/chat/completions', model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskToken(token) });
    const start = Date.now();
    try {
      const response = await axios.post(url, data, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 0,
      });
      logPipelineRaw({ provider: 'cloudflare', model: data?.model ?? 'n/a', endpoint: '/ai/v1/chat/completions', protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
      return response.data;
    } catch (error: any) {
      const status = getStatus(error);
      const respBody = extractResponseBody(error);
      console.log(`[Provider=Cloudflare] Error response: Status=${status}  Body=${respBody}`);
      throw error;
    }
  }
}
