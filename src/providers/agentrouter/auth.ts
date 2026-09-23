// AgentRouter authentication: key-manager construction + per-protocol headers.

import { KeyManager, AllKeysCooldownError } from '../../lib/key-manager';
import { Protocol } from './types';

export function createAgentRouterKeyManager(keys: string[]): KeyManager {
  return new KeyManager(keys, 'AgentRouter');
}

export function createAllKeysCooldownError(): any {
  const err: any = new Error('All AgentRouter API keys are currently in cooldown. Please wait before retrying.');
  err.status = 429;
  err.type = 'rate_limit_error';
  return err;
}

/**
 * Build HTTP auth headers for an API key + protocol. The Anthropic Messages API
 * expects x-api-key + a version header in addition to the standard Authorization.
 */
export function buildHeaders(apiKey: string, protocol: Protocol = 'openai'): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

export function isAllKeysCooldown(e: any): boolean {
  return e instanceof AllKeysCooldownError;
}