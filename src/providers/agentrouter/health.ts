// AgentRouter health check. Deliberately does NOT depend on GET /v1/models — a
// WAF/CAPTCHA/HTML/empty response must never mark the provider unavailable.
// Health is keyed off API-key availability + the cached/static catalog.

import { KeyInfo, KeyManager } from '../../lib/key-manager';
import { ProviderStatus } from './types';
// import { AgentRouterCache } from './cache';
import { healthLog } from './logger';

export interface HealthResult {
  provider: 'agentrouter';
  baseUrl: string;
  ok: boolean;
  status: number;
  latency: number;
  models: number;
  source: string;
  discovery: ProviderStatus;
  keyIndex?: number;
  error?: string;
}

export interface HealthDeps {
  keyManager: KeyManager;
  baseUrl: string;
  cachedModelCount: number;
  staticModelCount: number;
  discoveryStatus: ProviderStatus;
}

export async function healthCheck(deps: HealthDeps): Promise<HealthResult> {
  const start = Date.now();
  let keyInfo: KeyInfo;
  try {
    keyInfo = await deps.keyManager.getFirstActiveKey();
  } catch {
    return {
      provider: 'agentrouter',
      baseUrl: deps.baseUrl,
      ok: false,
      status: 429,
      latency: Date.now() - start,
      models: deps.staticModelCount,
      source: 'static',
      discovery: deps.discoveryStatus,
      error: 'All AgentRouter API keys are currently in cooldown',
    };
  }

  const models = deps.cachedModelCount > 0 ? deps.cachedModelCount : deps.staticModelCount;
  healthLog(`ok (source=${deps.cachedModelCount > 0 ? 'cache' : 'static'}, models=${models})`);
  return {
    provider: 'agentrouter',
    baseUrl: deps.baseUrl,
    ok: true,
    status: 200,
    latency: Date.now() - start,
    models,
    source: deps.cachedModelCount > 0 ? 'cache' : 'static',
    discovery: deps.discoveryStatus,
    keyIndex: keyInfo.index + 1,
  };
}