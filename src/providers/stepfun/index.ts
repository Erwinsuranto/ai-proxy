import axios, { AxiosInstance } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager } from '../../lib/key-manager';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError, logPipelineRateLimit, maskApiKey,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';

const PROTOCOL = 'openai';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'stepfun',
  providerName: 'StepFun',
};

const STEPFUN_MODELS = [
  'step-3.7-flash',
  'step-2-16k-nightly',
  'step-1-8k',
  'step-1-32k',
  'step-1-flash',
];

export function createStepFunKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'StepFun');
}

export class StepFunProvider implements Provider {
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
    });
  }

  getProviderInfo(): ProviderInfo {
    return PROVIDER_INFO;
  }

  private async withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const keyInfo = await this.keyManager.getNextKey();
    console.log(`[Provider=StepFun] ${keyInfo.tag}`);
    return fn(keyInfo.key);
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private logRequest(model: string, endpoint: string, apiKey: string): void {
    const masked = apiKey.slice(0, 4) + '***' + apiKey.slice(-4);
    const fullUrl = `${this.baseUrl}${endpoint}`;
    console.log(`[Provider=StepFun] Model=${model}  URL=${fullUrl}  Method=POST`);
    console.log(`[Provider=StepFun] Authorization: Bearer ${masked}`);
  }

  async chatCompletion(payload: any): Promise<any> {
    return this.withKey(async (key) => {
      this.logRequest(payload.model, '/chat/completions', key);
      const start = Date.now();
      try {
        const result = await this.makeRequest('post', '/chat/completions', payload, key);
        const latency = Date.now() - start;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        logPipelineParsed('stepfun', payload.model, result, true);
        const { text, location } = findTextInResponse(result);
        logPipelineExtracted('stepfun', payload.model, text, location);
        logPipelineFinal('stepfun', payload.model, result);
        return result;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'stepfun', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    return this.withKey(async (key) => {
      this.logRequest(payload.model, '/chat/completions', key);
      const start = Date.now();
      try {
        const raw = await this.makeRequestRaw('post', '/chat/completions', payload, key);
        const latency = Date.now() - start;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        const parsed = parseResponseBody(raw);
        logPipelineParsed('stepfun', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
        const { text, location } = findTextInResponse(parsed.body ?? raw);
        logPipelineExtracted('stepfun', payload.model, text, location);
        logPipelineFinal('stepfun', payload.model, raw);
        return raw;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'stepfun', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    return this.withKey(async (key) => {
      this.logRequest(payload.model, '/chat/completions', key);
      const start = Date.now();
      try {
        const stream = await this.makeStreamRequest('/chat/completions', { ...payload, stream: true }, key);
        const latency = Date.now() - start;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        logPipelineFinal('stepfun', payload.model, `[streaming] stream established`, latency);
        return { stream, keyIndex: 0, tag: '[StepFun]' };
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'stepfun', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async listModels(): Promise<any> {
    return {
      object: 'list',
      data: STEPFUN_MODELS.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'stepfun',
      })),
    };
  }

  async createEmbedding(payload: any): Promise<any> {
    return this.withKey(async (key) => {
      this.logRequest(payload.model, '/embeddings', key);
      const start = Date.now();
      try {
        const result = await this.makeRequest('post', '/embeddings', payload, key);
        const latency = Date.now() - start;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        return result;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=StepFun] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'stepfun', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string): Promise<any> {
    this.logRequestBody(data?.model ?? 'unknown', url, data);
    logPipelineRequest({ provider: 'stepfun', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({ method: method as any, url, data, headers: this.buildHeaders(apiKey) });
    logPipelineRaw({ provider: 'stepfun', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    this.logRequestBody(data?.model ?? 'unknown', url, data);
    logPipelineRequest({ provider: 'stepfun', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.request({ method: method as any, url, data, headers: this.buildHeaders(apiKey), responseType: 'text' });
    logPipelineRaw({ provider: 'stepfun', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    this.logRequestBody(data?.model ?? 'unknown', url, data);
    logPipelineRequest({ provider: 'stepfun', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });
    const start = Date.now();
    const response = await this.client.post(url, data, { headers: this.buildHeaders(apiKey), responseType: 'stream', timeout: 0 });
    logPipelineRaw({ provider: 'stepfun', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }

  private logRequestBody(model: string, url: string, data: any): void {
    const debug = process.env.DEBUG === 'true';
    if (!debug) return;
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`[Provider=StepFun] DEBUG Model=${model}  Endpoint=${url}  Body=${body}`);
  }

  private wrapError(error: any): any {
    const status = error?.response?.status ?? error?.status ?? 500;
    let errorBody: any = error?.response?.data;
    if (typeof errorBody === 'string') {
      try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
    }
    const msg = errorBody?.error?.message ?? error?.message ?? 'StepFun API error';
    const err: any = new Error(`StepFun API error (${status}): ${msg}`);
    err.status = status;
    err.response = error?.response;
    return err;
  }
}
