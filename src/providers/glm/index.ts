import axios, { AxiosInstance } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager } from '../../lib/key-manager';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';

const PROTOCOL = 'openai';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'glm',
  providerName: 'GLM (Zhipu AI)',
};

export function createGlmKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'GLM');
}

export class GlmProvider implements Provider {
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

  private async withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const keyInfo = await this.keyManager.getNextKey();
    console.log(`[Provider=GLM] ${keyInfo.tag}`);
    return fn(keyInfo.key);
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async chatCompletion(payload: any): Promise<any> {
    return this.withKey(async (key) => {
      const start = Date.now();
      console.log(`[Provider=GLM] Model=${payload.model}`);
      try {
        const result = await this.makeRequest('post', '/chat/completions', payload, key);
        const latency = Date.now() - start;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        logPipelineParsed('glm', payload.model, result, true);
        const { text, location } = findTextInResponse(result);
        logPipelineExtracted('glm', payload.model, text, location);
        logPipelineFinal('glm', payload.model, result);
        return result;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'glm', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    return this.withKey(async (key) => {
      const start = Date.now();
      console.log(`[Provider=GLM] Model=${payload.model}`);
      try {
        const raw = await this.makeRequestRaw('post', '/chat/completions', payload, key);
        const latency = Date.now() - start;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        const parsed = parseResponseBody(raw);
        logPipelineParsed('glm', payload.model, parsed.body, parsed.wasJson, parsed.parseError);
        const { text, location } = findTextInResponse(parsed.body ?? raw);
        logPipelineExtracted('glm', payload.model, text, location);
        logPipelineFinal('glm', payload.model, raw);
        return raw;
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'glm', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    return this.withKey(async (key) => {
      const start = Date.now();
      console.log(`[Provider=GLM] Model=${payload.model}`);
      try {
        const stream = await this.makeStreamRequest('/chat/completions', { ...payload, stream: true }, key);
        const latency = Date.now() - start;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=200`);
        logPipelineFinal('glm', payload.model, `[streaming] stream established`, latency);
        return { stream, keyIndex: 0, tag: '[GLM]' };
      } catch (error: any) {
        const latency = Date.now() - start;
        const status = error?.response?.status ?? error?.status ?? 0;
        console.log(`[Provider=GLM] Model=${payload.model}  Latency=${latency}ms  Status=${status}  Error=${error?.message ?? 'unknown'}`);
        logPipelineError({ provider: 'glm', model: payload.model, status, error: error?.message ?? String(error), latencyMs: latency });
        throw this.wrapError(error);
      }
    });
  }

  async listModels(): Promise<any> {
    const now = Date.now();
    return {
      object: 'list',
      data: [
        { id: 'glm-5.2', object: 'model', created: Math.floor(now / 1000), owned_by: 'zhipu' },
        { id: 'glm-4', object: 'model', created: Math.floor(now / 1000), owned_by: 'zhipu' },
        { id: 'glm-4v', object: 'model', created: Math.floor(now / 1000), owned_by: 'zhipu' },
      ],
    };
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('GLM provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  private async makeRequest(method: string, url: string, data: any, apiKey: string): Promise<any> {
    logPipelineRequest({ provider: 'glm', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: apiKey.slice(0, 4) + '***' + apiKey.slice(-4) });
    const start = Date.now();
    const response = await this.client.request({ method: method as any, url, data, headers: this.buildHeaders(apiKey) });
    logPipelineRaw({ provider: 'glm', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeRequestRaw(method: string, url: string, data: any, apiKey: string): Promise<string> {
    logPipelineRequest({ provider: 'glm', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: apiKey.slice(0, 4) + '***' + apiKey.slice(-4) });
    const start = Date.now();
    const response = await this.client.request({ method: method as any, url, data, headers: this.buildHeaders(apiKey), responseType: 'text' });
    logPipelineRaw({ provider: 'glm', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: response.data, latencyMs: Date.now() - start });
    return response.data;
  }

  private async makeStreamRequest(url: string, data: any, apiKey: string): Promise<any> {
    logPipelineRequest({ provider: 'glm', baseUrl: this.baseUrl, endpoint: url, model: data?.model ?? 'n/a', protocol: PROTOCOL, keyMasked: apiKey.slice(0, 4) + '***' + apiKey.slice(-4) });
    const start = Date.now();
    const response = await this.client.post(url, data, { headers: this.buildHeaders(apiKey), responseType: 'stream', timeout: 0 });
    logPipelineRaw({ provider: 'glm', model: data?.model ?? 'n/a', endpoint: url, protocol: PROTOCOL, status: response.status, headers: response.headers, body: '[streaming]', latencyMs: Date.now() - start });
    return response.data;
  }

  private wrapError(error: any): any {
    const status = error?.response?.status ?? error?.status ?? 500;
    let errorBody: any = error?.response?.data;
    if (typeof errorBody === 'string') {
      try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
    }
    const msg = errorBody?.error?.message ?? error?.message ?? 'GLM API error';
    const err: any = new Error(`GLM API error (${status}): ${msg}`);
    err.status = status;
    err.response = error?.response;
    return err;
  }
}
