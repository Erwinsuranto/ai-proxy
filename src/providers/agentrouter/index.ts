// AgentRouter provider — self-contained implementation.
//
// All AgentRouter logic lives in this folder. Other providers only know the
// standard Provider interface (lib/types.ts). This class wires together the
// self-contained modules (client/auth/catalog/discovery/request/response/stream/
// transform/health/cache/retry/logger) and exposes the same public API as before:
//   - AgentRouterProvider  (implements Provider)
//   - createAgentRouterKeyManager
//
// AgentRouter operates without a reachable GET /v1/models: the static catalog is
// always registered so the provider stays healthy and routable even when
// discovery is blocked by a WAF/CAPTCHA/HTML page or returns an empty body.
// When AGENTROUTER_PROXY_MODE=true requests/responses are forwarded verbatim
// (no body transformation).

import { Provider, ProviderInfo } from '../../lib/types';
import { KeyManager, KeyInfo } from '../../lib/key-manager';
import { createClients } from './client';
import { createAgentRouterKeyManager, createAllKeysCooldownError, isAllKeysCooldown, buildHeaders } from './auth';
import { AgentRouterDiscovery } from './discovery';
import { resolveProtocol, endpointForProtocol } from './protocol';
import { AgentRouterRequester } from './request';
import { anthropicToOpenAI, parseResponseBody, findTextInResponse } from './response';
import { openaiToAnthropic } from './transform';
import { createAnthropicToOpenAIStream } from './stream';
import { healthCheck } from './health';
import { AgentRouterProxy } from './proxy';
import { getStatus, isQuotaError, wrapError } from './retry';
import { DEFAULT_STATIC_MODELS } from './catalog';
import { PROVIDER_ID, PROVIDER_NAME, COOLDOWN_DURATION_MS, CatalogEntry } from './types';
import {
  selectionLog,
  requestLog,
  successLog,
  failureLog,
  rateLimitLog,
  maskKeySuffix,
  responseRawLog,
  responseParsedLog,
  responseExtractLog,
  responseSentLog,
} from './logger';

const PROVIDER_INFO: ProviderInfo = {
  providerId: PROVIDER_ID,
  providerName: PROVIDER_NAME,
};

export { createAgentRouterKeyManager };

export class AgentRouterProvider implements Provider {
  private keyManager: KeyManager;
  private baseUrl: string;
  private clients: ReturnType<typeof createClients>;
  private request: AgentRouterRequester;
  private discovery: AgentRouterDiscovery;
  private proxy: AgentRouterProxy;

  constructor(
    keyManager: KeyManager,
    baseUrl: string,
    timeout: number,
    staticModels?: CatalogEntry[],
    proxyMode = false,
  ) {
    this.keyManager = keyManager;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clients = createClients(this.baseUrl, timeout);
    this.request = new AgentRouterRequester(this.clients);
    this.discovery = new AgentRouterDiscovery(staticModels && staticModels.length > 0 ? staticModels : DEFAULT_STATIC_MODELS);
    this.proxy = new AgentRouterProxy(proxyMode);
    if (this.proxy.enabled) console.log(`[${PROVIDER_ID}] Proxy mode ON — payloads forwarded verbatim.`);
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

  private protocolFor(model: string): any {
    return resolveProtocol(model, this.discovery.getProtocolMap());
  }

  /** Resolve the wire protocol for a model (public, used by tests/tooling). */
  resolveProtocol(model: string): string {
    return this.protocolFor(model);
  }

  private endpointFor(model: string): string {
    return endpointForProtocol(this.protocolFor(model));
  }

  /** Run one request through a key, recording success/failure/cooldown. */
  private async runWithKey<T>(
    model: string,
    endpoint: string,
    protocol: string,
    fn: (key: string) => Promise<T>,
  ): Promise<T> {
    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e: any) {
      if (isAllKeysCooldown(e)) throw createAllKeysCooldownError();
      throw e;
    }

    requestLog(keyInfo.index, model, model, protocol, endpoint, this.proxy.enabled);
    selectionLog(this.baseUrl, endpoint, model, protocol, model, maskKeySuffix(keyInfo.key), this.proxy.enabled);

    const start = Date.now();
    try {
      const result = await fn(keyInfo.key);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      successLog(keyInfo.index, model, latency, 200);
      return result;
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        rateLimitLog(keyInfo.index, Math.round(COOLDOWN_DURATION_MS / 1000));
      } else {
        this.keyManager.markFailure(keyInfo.index, error?.message ?? String(error));
      }
      throw wrapError(error);
    }
  }

  // ---- Non-streaming chat --------------------------------------------------

  async chatCompletion(payload: any): Promise<any> {
    const model = payload?.model;
    const protocol = this.protocolFor(model);
    const endpoint = this.endpointFor(model);

    if (this.proxy.enabled) {
      return this.runWithKey(model, endpoint, protocol, (key) =>
        this.request.postJson(endpoint, payload, key, protocol),
      );
    }

    if (protocol === 'anthropic') {
      const anthropicPayload = openaiToAnthropic(payload);
      const raw = await this.runWithKey(model, endpoint, protocol, (key) =>
        this.request.postJson(endpoint, anthropicPayload, key, protocol),
      );
      responseRawLog(model, raw);
      const parsedBody = parseResponseBody(raw);
      responseParsedLog(model, parsedBody);
      const found = findTextInResponse(parsedBody.body ?? raw);
      responseExtractLog(model, found.text, found.location);
      const parsed = anthropicToOpenAI(parsedBody.body ?? raw, model);
      responseSentLog(model, parsed);
      return parsed;
    }

    // OpenAI-compatible upstream: passthrough, never re-parse.
    const raw = await this.runWithKey(model, endpoint, protocol, (key) =>
      this.request.postJson(endpoint, payload, key, protocol),
    );
    responseRawLog(model, raw);
    const parsedBody = parseResponseBody(raw);
    responseParsedLog(model, parsedBody);
    const found = findTextInResponse(parsedBody.body ?? raw);
    responseExtractLog(model, found.text, found.location);
    responseSentLog(model, raw);
    return raw;
  }

  async chatCompletionRaw(payload: any): Promise<string> {
    const model = payload?.model;
    const protocol = this.protocolFor(model);
    const endpoint = this.endpointFor(model);

    if (this.proxy.enabled) {
      return this.runWithKey(model, endpoint, protocol, (key) =>
        this.request.postRaw(endpoint, payload, key, protocol),
      );
    }

    if (protocol === 'anthropic') {
      const anthropicPayload = openaiToAnthropic(payload);
      const raw = await this.runWithKey(model, endpoint, protocol, (key) =>
        this.request.postJson(endpoint, anthropicPayload, key, protocol),
      );
      responseRawLog(model, raw);
      const parsedBody = parseResponseBody(raw);
      responseParsedLog(model, parsedBody);
      const found = findTextInResponse(parsedBody.body ?? raw);
      responseExtractLog(model, found.text, found.location);
      const parsed = anthropicToOpenAI(parsedBody.body ?? raw, model);
      const rawJson = JSON.stringify(parsed);
      responseSentLog(model, rawJson);
      return rawJson;
    }

    const rawText = await this.runWithKey(model, endpoint, protocol, (key) =>
      this.request.postRaw(endpoint, payload, key, protocol),
    );
    responseRawLog(model, rawText);
    responseSentLog(model, rawText);
    return rawText;
  }

  /** --- Streaming ------------------------------------------------------------ */

  async chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }> {
    const model = payload?.model;
    const protocol = this.protocolFor(model);
    const endpoint = this.endpointFor(model);

    let keyInfo: KeyInfo;
    try {
      keyInfo = await this.keyManager.getNextKey();
    } catch (e: any) {
      if (isAllKeysCooldown(e)) throw createAllKeysCooldownError();
      throw e;
    }

    requestLog(keyInfo.index, model, model, protocol, endpoint, this.proxy.enabled);
    selectionLog(this.baseUrl, endpoint, model, protocol, model, maskKeySuffix(keyInfo.key), this.proxy.enabled);

    const outbound =
      this.proxy.enabled
        ? { ...payload, stream: true }
        : protocol === 'anthropic'
          ? { ...openaiToAnthropic(payload), stream: true }
          : { ...payload, stream: true };

    const start = Date.now();
    try {
      const upstream = await this.request.postStream(endpoint, outbound, keyInfo.key, protocol);
      const latency = Date.now() - start;
      this.keyManager.markSuccess(keyInfo.index, latency);
      successLog(keyInfo.index, model, latency, 200);

      const stream =
        protocol === 'anthropic' && !this.proxy.enabled
          ? upstream.pipe(createAnthropicToOpenAIStream(model))
          : upstream;
      responseSentLog(model, `stream (${protocol}${this.proxy.enabled ? ', proxy' : ''})`);
      return { stream, keyIndex: keyInfo.index, tag: keyInfo.tag };
    } catch (error: any) {
      const latency = Date.now() - start;
      const status = getStatus(error);
      if (isQuotaError(error)) {
        this.keyManager.markCooldown(keyInfo.index);
        rateLimitLog(keyInfo.index, Math.round(COOLDOWN_DURATION_MS / 1000));
      } else {
        this.keyManager.markFailure(keyInfo.index, error?.message ?? String(error));
      }
      throw wrapError(error);
    }
  }

  /** --- Discovery / catalog ---------------------------------------------------- */

  async listModels(): Promise<any> {
    const now = Date.now();

    const fetchModels = async (): Promise<{ status: number; headers?: Record<string, any>; data: any }> => {
      let keyInfo: KeyInfo;
      try {
        keyInfo = await this.keyManager.getFirstActiveKey();
      } catch (e: any) {
        if (isAllKeysCooldown(e)) throw createAllKeysCooldownError();
        throw e;
      }
      const res = await this.clients.openai.get('/models', { headers: buildHeaders(keyInfo.key, 'openai') });
      return { status: res.status, headers: res.headers as any, data: res.data };
    };

    const extract = (data: any): any[] => {
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      return list;
    };

    const result = await this.discovery.refresh(fetchModels, extract, Date.now());
    return { object: 'list', source: result.source, data: result.models };
  }

  /** --- Health ------------------------------------------------------------------ */

  async healthCheck(): Promise<any> {
    return healthCheck({
      keyManager: this.keyManager,
      baseUrl: this.baseUrl,
      cachedModelCount: this.discovery.cache.size(),
      staticModelCount: this.discovery.staticModels().length,
      discoveryStatus: this.discovery.getStatus().status,
    });
  }

  createEmbedding(_payload: any): Promise<any> {
    const err: any = new Error('AgentRouter provider does not support embeddings.');
    err.status = 400;
    return Promise.reject(err);
  }
}