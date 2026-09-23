import axios, { AxiosRequestConfig } from 'axios';
import { Provider, ProviderInfo } from '../../lib/types';
import { EndpointManager, EndpointInfo, AllEndpointsCooldownError } from '../../lib/endpoint-manager';
import { isRetryableError, isQuotaError } from '../../lib/retry';
import { withEndpointRotation } from '../../lib/provider-utils';
import { ModelRegistry } from './model-registry';
import { joinDatabricksUrl } from './url-utils';
import {
  logPipelineRequest, logPipelineRaw, logPipelineParsed, logPipelineExtracted, logPipelineFinal,
  logPipelineError, logPipelineRateLimit, maskApiKey,
} from '../../lib/pipeline-log';
import { parseResponseBody, findTextInResponse } from '../../lib/pipeline';

const PROTOCOL = 'openai';

const PROVIDER_INFO: ProviderInfo = {
  providerId: 'databricks',
  providerName: 'Databricks',
};

function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split('.');
    if (parts.length >= 2) return parts[0] + '...';
    return parsed.hostname.slice(0, 8) + '...';
  } catch {
    return url.length > 8 ? url.slice(0, 8) + '...' : url;
  }
}

function logRequestDetail(context: {
  endpointShort: string;
  url: string;
  method: string;
  model: string;
  apiKey: string;
  body?: any;
}): void {
  const { endpointShort, url, method, model, apiKey, body } = context;
  console.log(`[Databricks] ${method} ${url}`);
  console.log(`[Databricks] Endpoint : ${endpointShort}`);
  console.log(`[Databricks] Model    : ${model}`);
  console.log(`[Databricks] Authorization: Bearer ${apiKey.slice(0, 8)}...`);
  if (body !== undefined) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    console.log(`[Databricks] Body:`);
    console.log(bodyStr);
  }
}

function logErrorDetail(error: any, context: {
  endpointShort: string;
  url: string;
  method: string;
  model: string;
  latency: number;
  timeout?: number;
  requestBody?: any;
}): void {
  const { endpointShort, url, method, model, latency, timeout, requestBody } = context;
  const status = error?.response?.status ?? error?.status ?? 0;
  const statusText = error?.response?.statusText ?? '';
  const axiosCode = error?.code ?? '';
  const message = error?.message ?? 'Unknown error';
  const respData = error?.response?.data;
  const respHeaders = error?.response?.headers;

  const separator = '='.repeat(50);
  const errSep = '!'.repeat(50);
  console.log(errSep);
  console.log(`===== DATABRICKS ERROR =====`);
  console.log(`Status   : ${status} ${statusText}`);
  if (respHeaders) {
    console.log(`Headers  : ${JSON.stringify(respHeaders, null, 2)}`);
  }
  console.log(`Error Msg: ${message}`);
  if (axiosCode) {
    console.log(`Axios Code: ${axiosCode}`);
  }
  console.log(`Latency  : ${latency} ms`);
  if (timeout !== undefined) {
    console.log(`Timeout  : ${timeout} ms`);
  }
  console.log(`Endpoint : ${endpointShort}`);
  console.log(`Request URL: ${url}`);
  console.log(`Model    : ${model}`);
  if (requestBody) {
    console.log(`Request Body:`);
    console.log(JSON.stringify(requestBody, null, 2));
  }

  if (respData) {
    if (typeof respData === 'object') {
      const code = respData.error_code ?? respData.error?.code ?? '';
      const msg = respData.message ?? respData.error?.message ?? '';
      if (code) console.log(`Error Code: ${code}`);
      if (msg) console.log(`Error Msg : ${msg}`);
      console.log(`Response Body:`);
      console.log(JSON.stringify(respData, null, 2));
    } else if (typeof respData === 'string') {
      try {
        const parsed = JSON.parse(respData);
        const code = parsed.error_code ?? parsed.error?.code ?? '';
        const msg = parsed.message ?? parsed.error?.message ?? '';
        if (code) console.log(`Error Code: ${code}`);
        if (msg) console.log(`Error Msg : ${msg}`);
        console.log(`Response Body:`);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(`Response Body (text):`);
        console.log(respData);
      }
    }
  } else {
    console.log(`Response Body: (no response body)`);
  }
  console.log(errSep);
}

export function createDatabricksEndpointManager(configs: { baseUrl: string; apiKey: string }[]): EndpointManager {
  return new EndpointManager(configs, 'Databricks');
}

export class DatabricksProvider implements Provider {
  private endpointManager: EndpointManager;
  private modelRegistry: ModelRegistry;
  private timeout: number;
  private modelAliasMap: Map<string, string>;
  private virtualAliasMap: Map<string, string>;

  constructor(endpointManager: EndpointManager, timeout: number, modelAliasMap?: Map<string, string>, virtualAliasMap?: Map<string, string>) {
    this.endpointManager = endpointManager;
    this.modelRegistry = new ModelRegistry(endpointManager);
    this.timeout = timeout;
    this.modelAliasMap = modelAliasMap ?? new Map();
    this.virtualAliasMap = virtualAliasMap ?? new Map();

  }

  getProviderInfo(): ProviderInfo {
    return PROVIDER_INFO;
  }

  getEndpointManager(): EndpointManager {
    return this.endpointManager;
  }

  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  getModelAliasMap(): Map<string, string> {
    return this.modelAliasMap;
  }

  getVirtualAliasMap(): Map<string, string> {
    return this.virtualAliasMap;
  }

  private applyModelAlias(modelId: string): { mappedModel: string; mapped: boolean } {
    if (modelId.startsWith('databricks-')) {
      return { mappedModel: modelId, mapped: false };
    }

    const virtualKey = `databricks/${modelId}`;
    const virtualAlias = this.virtualAliasMap.get(virtualKey);
    if (virtualAlias) {
      console.log(`[Databricks] Virtual Alias: "${virtualKey}" -> "${virtualAlias}"`);
      return { mappedModel: virtualAlias, mapped: true };
    }

    const alias = this.modelAliasMap.get(modelId);
    if (alias) {
      console.log(`[Databricks] Model Alias: "${modelId}" -> "${alias}"`);
      return { mappedModel: alias, mapped: true };
    }
    return { mappedModel: modelId, mapped: false };
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async chatCompletion(payload: any): Promise<any> {
    const modelId = payload.model;
    const { mappedModel: actualModel } = this.applyModelAlias(modelId);
    const candidateIndices = this.resolveCandidateEndpoints(modelId);
    const orderedPool = await this.endpointManager.getEndpointPreferenceOrder(candidateIndices);

    const matchedLog = candidateIndices.map(idx => `  ${this.endpointManager.getEndpointInfo(idx).tag}`).join('\n');
    console.log(`Requested model:${modelId}`);
    if (matchedLog) console.log(`Matched endpoints:\n${matchedLog}`);

    return withEndpointRotation(this.endpointManager, {
      async request(baseUrl, apiKey) {
        const url = joinDatabricksUrl(baseUrl, '/chat/completions');
        const short = shortUrl(baseUrl);
        const modifiedPayload = { ...payload, model: actualModel };

        const requestJson = JSON.stringify(modifiedPayload, null, 2);
        console.log(`[REQUEST_JSON] ${requestJson}`);

        logRequestDetail({
          endpointShort: short,
          url,
          method: 'POST',
          model: actualModel,
          apiKey,
          body: modifiedPayload,
        });
        logPipelineRequest({ provider: 'databricks', baseUrl, endpoint: '/chat/completions', model: actualModel, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });

        const start = Date.now();
        try {
          const resp = await axios.post(url, modifiedPayload, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          });
          logPipelineRaw({ provider: 'databricks', model: actualModel, endpoint: '/chat/completions', protocol: PROTOCOL, status: resp.status, headers: resp.headers, body: resp.data, latencyMs: Date.now() - start });
          return resp.data;
        } catch (error: any) {
          const latency = Date.now() - start;
          logErrorDetail(error, {
            endpointShort: short,
            url,
            method: 'POST',
            model: actualModel,
            latency,
            requestBody: modifiedPayload,
          });
          logPipelineError({ provider: 'databricks', model: actualModel, status: getStatus(error), error: error?.message ?? String(error), latencyMs: latency });
          throw error;
        }
      },
      onTrying(index, maskedBaseUrl) {
        if (!orderedPool.includes(index)) return;
        console.log(`[Databricks] Endpoint #${index + 1} (${maskedBaseUrl}) -> Trying model=${modelId}`);
      },
      onSuccess(index, latencyMs) {
        console.log(`[Databricks] Endpoint #${index + 1} -> Success (${latencyMs}ms)`);
      },
      onCooldown(index, status) {
        console.log(`[Databricks] Endpoint #${index + 1} -> ${status} -> Cooldown`);
        logPipelineRateLimit('databricks', modelId, 60, status);
      },
      onRotate(index, _error, status, isTimeout) {
        if (isTimeout) {
          console.log(`[Databricks] Endpoint #${index + 1} -> Timeout -> Rotate`);
        } else {
          console.log(`[Databricks] Endpoint #${index + 1} -> ${status} -> Rotate`);
        }
      },
    }, orderedPool.length > 0 ? orderedPool : undefined).catch((error: any) => {
      throw this.wrapError(error);
    }).then((result: any) => {
      logPipelineParsed('databricks', modelId, result, true);
      const { text, location } = findTextInResponse(result);
      logPipelineExtracted('databricks', modelId, text, location);
      logPipelineFinal('databricks', modelId, result);
      return result;
    });
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const modelId = payload.model;
    const { mappedModel: actualModel } = this.applyModelAlias(modelId);
    const candidateIndices = this.resolveCandidateEndpoints(modelId);
    const orderedPool = await this.endpointManager.getEndpointPreferenceOrder(candidateIndices);

    return withEndpointRotation(this.endpointManager, {
      async request(baseUrl, apiKey) {
        const url = joinDatabricksUrl(baseUrl, '/chat/completions');
        const short = shortUrl(baseUrl);
        const modifiedPayload = { ...payload, model: actualModel };

        const requestJson = JSON.stringify(modifiedPayload, null, 2);
        console.log(`[REQUEST_JSON] ${requestJson}`);

        logRequestDetail({
          endpointShort: short,
          url,
          method: 'POST',
          model: actualModel,
          apiKey,
          body: modifiedPayload,
        });
        logPipelineRequest({ provider: 'databricks', baseUrl, endpoint: '/chat/completions', model: actualModel, protocol: PROTOCOL, keyMasked: maskApiKey(apiKey) });

        const start = Date.now();
        try {
          const resp = await axios.post(url, modifiedPayload, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            responseType: 'text',
          });
          logPipelineRaw({ provider: 'databricks', model: actualModel, endpoint: '/chat/completions', protocol: PROTOCOL, status: resp.status, headers: resp.headers, body: resp.data, latencyMs: Date.now() - start });
          return resp.data;
        } catch (error: any) {
          const latency = Date.now() - start;
          logErrorDetail(error, {
            endpointShort: short,
            url,
            method: 'POST',
            model: actualModel,
            latency,
            requestBody: modifiedPayload,
          });
          logPipelineError({ provider: 'databricks', model: actualModel, status: getStatus(error), error: error?.message ?? String(error), latencyMs: latency });
          throw error;
        }
      },
      onTrying(index, maskedBaseUrl) {
        if (!orderedPool.includes(index)) return;
        console.log(`[Databricks] Endpoint #${index + 1} (${maskedBaseUrl}) -> Trying model=${modelId}`);
      },
      onSuccess(index, latencyMs) {
        console.log(`[Databricks] Endpoint #${index + 1} -> Success (${latencyMs}ms)`);
      },
      onCooldown(index, status) {
        console.log(`[Databricks] Endpoint #${index + 1} -> ${status} -> Cooldown`);
        logPipelineRateLimit('databricks', modelId, 60, status);
      },
      onRotate(index, _error, status, isTimeout) {
        if (isTimeout) {
          console.log(`[Databricks] Endpoint #${index + 1} -> Timeout -> Rotate`);
        } else {
          console.log(`[Databricks] Endpoint #${index + 1} -> ${status} -> Rotate`);
        }
      },
    }, orderedPool.length > 0 ? orderedPool : undefined).catch((error: any) => {
      throw this.wrapError(error);
    }).then((raw: any) => {
      const parsed = parseResponseBody(raw);
      logPipelineParsed('databricks', modelId, parsed.body, parsed.wasJson, parsed.parseError);
      const { text, location } = findTextInResponse(parsed.body ?? raw);
      logPipelineExtracted('databricks', modelId, text, location);
      logPipelineFinal('databricks', modelId, raw);
      return raw;
    });
  }

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const modelId = payload.model;
    const { mappedModel: actualModel } = this.applyModelAlias(modelId);
    const candidateIndices = this.resolveCandidateEndpoints(modelId);
    const orderedPool = await this.endpointManager.getEndpointPreferenceOrder(candidateIndices);

    if (orderedPool.length === 0) {
      const err: any = new Error(`No available endpoint for model "${modelId}"`);
      err.status = 503;
      throw err;
    }

    let lastError: any = null;
    const triedIndices = new Set<number>();

    for (const idx of orderedPool) {
      if (triedIndices.has(idx)) continue;
      triedIndices.add(idx);

      const ep = this.endpointManager.getEndpointInfo(idx);
      const short = shortUrl(ep.baseUrl);
      console.log(`[Databricks] Endpoint #${idx + 1} (${short}) -> Streaming model=${modelId}`);

      const url = joinDatabricksUrl(ep.baseUrl, '/chat/completions');
      const streamPayload = { ...payload, stream: true, model: actualModel };

      const streamRequestJson = JSON.stringify(streamPayload, null, 2);
      console.log(`[REQUEST_JSON] ${streamRequestJson}`);

      logRequestDetail({
        endpointShort: short,
        url,
        method: 'POST',
        model: actualModel,
        apiKey: ep.apiKey,
        body: streamPayload,
      });
      logPipelineRequest({ provider: 'databricks', baseUrl: ep.baseUrl, endpoint: '/chat/completions', model: actualModel, protocol: PROTOCOL, keyMasked: maskApiKey(ep.apiKey) });

      const start = Date.now();
      try {
        const resp = await axios.post(url, streamPayload, {
          headers: this.buildHeaders(ep.apiKey),
          responseType: 'stream',
          timeout: 0,
        } as AxiosRequestConfig);
        const latency = Date.now() - start;
        this.endpointManager.markSuccess(idx, latency);
        console.log(`[Databricks] Endpoint #${idx + 1} -> Success (${latency}ms)`);
        logPipelineRaw({ provider: 'databricks', model: actualModel, endpoint: '/chat/completions', protocol: PROTOCOL, status: resp.status, headers: resp.headers, body: '[streaming]', latencyMs: latency });
        logPipelineFinal('databricks', modelId, `[streaming] stream established`, latency);
        return { stream: resp.data, keyIndex: idx, tag: ep.tag };
      } catch (error: any) {
        const latency = Date.now() - start;
        lastError = error;
        const status = getStatus(error);

        logErrorDetail(error, {
          endpointShort: short,
          url,
          method: 'POST',
          model: modelId,
          latency,
          requestBody: streamPayload,
        });
        logPipelineError({ provider: 'databricks', model: modelId, status, error: error?.message ?? String(error), latencyMs: latency });

        if (isQuotaError(error)) {
          this.endpointManager.markCooldown(idx);
          console.log(`[Databricks] Endpoint #${idx + 1} -> ${status} -> Cooldown`);
          logPipelineRateLimit('databricks', modelId, 60, status);
        } else {
          this.endpointManager.markFailure(idx, error.message ?? String(error));
          if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
            console.log(`[Databricks] Endpoint #${idx + 1} -> Timeout -> Rotate`);
          } else {
            console.log(`[Databricks] Endpoint #${idx + 1} -> ${status} -> Rotate`);
          }
        }

        if (isRetryableError(error)) {
          continue;
        }
      }
    }

    throw this.wrapError(lastError);
  }

  async listModels(): Promise<any> {
    const models = Array.from(this.virtualAliasMap.keys()).map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'databricks',
    }));

    if (models.length === 0) {
      return {
        object: 'list',
        data: [
          { id: 'databricks/*', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'databricks' },
        ],
      };
    }

    return { object: 'list', data: models };
  }

  async createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('Databricks provider does not support embeddings.');
    err.status = 400;
    throw err;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    for (let attempt = 0; attempt < this.endpointManager.endpointCount; attempt++) {
      let ep: EndpointInfo;
      try {
        ep = await this.endpointManager.getNextEndpoint();
      } catch {
        return { ok: false, message: 'All endpoints in cooldown' };
      }

      const url = joinDatabricksUrl(ep.baseUrl, '/chat/completions');
      const start = Date.now();
      try {
        const resp = await axios.get(url, {
          headers: this.buildHeaders(ep.apiKey),
          timeout: 10_000,
          validateStatus: () => true,
        });
        return { ok: true, message: `Endpoint #${ep.index + 1} responded status=${resp.status}` };
      } catch (error: any) {
        const latency = Date.now() - start;
        logErrorDetail(error, {
          endpointShort: shortUrl(ep.baseUrl),
          url,
          method: 'GET',
          model: 'N/A',
          latency,
          timeout: 10_000,
        });
      }
    }
    return { ok: false, message: 'All endpoints failed health check' };
  }

  private resolveCandidateEndpoints(modelId: string): number[] {
    let candidateIndices = this.modelRegistry.getModelEndpoints(modelId);
    if (candidateIndices.length === 0) {
      candidateIndices = Array.from({ length: this.endpointManager.endpointCount }, (_, i) => i);
    }
    return candidateIndices;
  }

  private wrapError(error: any): any {
    if (error && error.status) return error;
    const status = getStatus(error) || 500;
    let errorBody: any = error?.response?.data;
    if (typeof errorBody === 'string') {
      try { errorBody = JSON.parse(errorBody); } catch { errorBody = {}; }
    }
    const msg = errorBody?.error?.message ?? errorBody?.message ?? error?.message ?? 'Databricks API error';
    const err: any = new Error(`Databricks API error (${status}): ${msg}`);
    err.status = status;
    err.response = error?.response;
    return err;
  }
}
