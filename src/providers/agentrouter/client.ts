// AgentRouter HTTP clients. Two axios instances per base URL family:
//   - OpenAI-compatible client rooted at the full base URL (e.g. .../v1)
//   - Anthropic client rooted at the base URL WITHOUT the trailing /v1
// ((Anthropic Messages lives at <baseWithoutV1>/messages).

import axios, { AxiosInstance } from 'axios';

export function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

export interface AgentRouterClients {
  openai: AxiosInstance;
  anthropic: AxiosInstance;
  baseUrl: string;
  anthropicBaseUrl: string;
}

export function createClients(baseUrl: string, timeout: number): AgentRouterClients {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const anthropicBaseUrl = stripTrailingV1(trimmed);

  const openai = axios.create({
    baseURL: trimmed,
    timeout,
    headers: { 'Content-Type': 'application/json' },
  });
  const anthropic = axios.create({
    baseURL: anthropicBaseUrl,
    timeout,
    headers: { 'Content-Type': 'application/json' },
  });

  return { openai, anthropic, baseUrl: trimmed, anthropicBaseUrl };
}