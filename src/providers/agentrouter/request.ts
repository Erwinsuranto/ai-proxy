// AgentRouter request execution. All upstream requests are made here. Supports
// OpenAI Chat Completions, Anthropic Messages, and (future) Responses API. The
// endpoint is chosen from per-model metadata (protocol), never a hardcoded name.

import { AxiosRequestConfig, AxiosInstance } from 'axios';
import { Protocol } from './types';
import { AgentRouterClients } from './client';
import { buildHeaders } from './auth';
import { endpointForProtocol } from './protocol';
import { wrapError } from './retry';

export class AgentRouterRequester {
  constructor(private clients: AgentRouterClients) {}

  private clientFor(protocol: Protocol): AxiosInstance {
    return protocol === 'anthropic' ? this.clients.anthropic : this.clients.openai;
  }

  /** Resolved absolute/relative URL for a model's endpoint. */
  endpoint(protocol: Protocol): string {
    return endpointForProtocol(protocol);
  }

  /** POST JSON, returning the parsed response body. */
  async postJson(
    endpoint: string,
    data: any,
    apiKey: string,
    protocol: Protocol = 'openai',
    extraConfig?: AxiosRequestConfig,
  ): Promise<any> {
    const response = await this.clientFor(protocol).request({
      method: 'post',
      url: endpoint,
      data,
      ...extraConfig,
      headers: { ...buildHeaders(apiKey, protocol), ...extraConfig?.headers },
    });
    return response.data;
  }

  /** POST returning the raw text body (for non-streaming passthrough). */
  async postRaw(
    endpoint: string,
    data: any,
    apiKey: string,
    protocol: Protocol = 'openai',
  ): Promise<string> {
    const response = await this.clientFor(protocol).request({
      method: 'post',
      url: endpoint,
      data,
      headers: buildHeaders(apiKey, protocol),
      responseType: 'text',
    });
    return response.data;
  }

  /** POST returning a readable stream (SSE). */
  async postStream(
    endpoint: string,
    data: any,
    apiKey: string,
    protocol: Protocol = 'openai',
  ): Promise<any> {
    const response = await this.clientFor(protocol).post(endpoint, data, {
      headers: buildHeaders(apiKey, protocol),
      responseType: 'stream',
      timeout: 0,
    } as AxiosRequestConfig);
    return response.data;
  }
}