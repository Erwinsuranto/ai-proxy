import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelRegistry } from '../src/lib/model-registry';
import { registry } from '../src/providers/registry';
import { discoveryStore } from '../src/lib/discovery';
import { AgentRouterProvider, createAgentRouterKeyManager } from '../src/providers/agentrouter';
import { generateModelAliases } from '../src/lib/model-registry';

const BASE_URL = 'https://agentrouter.org/v1';

// Mirrors the REAL AgentRouter upstream ids the user reported. Note the dot in
// the version ("4.8") vs the dashed client request ("4-8").
const UPSTREAM = [
  { id: 'anthropic/claude-opus-4.8', owned_by: 'anthropic' },
  { id: 'anthropic/claude-opus-5', owned_by: 'anthropic' },
  { id: 'anthropic/claude-sonnet-5', owned_by: 'anthropic' },
  { id: 'openai/gpt-5.6-sol', owned_by: 'openai' },
];

function freshProvider(): AgentRouterProvider {
  vi.resetModules();
  const km = createAgentRouterKeyManager(['k1']);
  const provider = new AgentRouterProvider(km, BASE_URL, 10000);
  (provider as any).client = {
    get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { data: UPSTREAM } }),
    request: vi.fn(),
    post: vi.fn(),
  };
  return provider;
}

async function register(provider: AgentRouterProvider): Promise<void> {
  modelRegistry.clear();
  (registry as any).providers = (registry as any).providers.filter((p: any) => p.identity.providerId !== 'agentrouter');
  (registry as any).providerMap.delete('agentrouter');
  registry.register(provider.getProviderInfo(), provider as any);
  await modelRegistry.loadFromProvider('agentrouter');
}

describe('generateModelAliases (normalizer)', () => {
  it('produces de-prefixed + dot->dash aliases', () => {
    expect(generateModelAliases('anthropic/claude-opus-4.8')).toEqual(['claude-opus-4.8', 'claude-opus-4-8']);
    expect(generateModelAliases('anthropic/claude-opus-5')).toEqual(['claude-opus-5']);
    expect(generateModelAliases('anthropic/claude-sonnet-5')).toEqual(['claude-sonnet-5']);
    expect(generateModelAliases('openai/gpt-5.6-sol')).toEqual(['gpt-5.6-sol', 'gpt-5-6-sol']);
  });
});

describe('AgentRouter alias registration + routing (real-id mirror)', () => {
  beforeEach(() => modelRegistry.clear());

  it('registers dashed alias so "claude-opus-4-8" resolves to AgentRouter (backend = anthropic/claude-opus-4.8)', async () => {
    const provider = freshProvider();
    await register(provider);

    const p = modelRegistry.getProvidersForModel('claude-opus-4-8');
    expect(p.length).toBeGreaterThan(0);
    expect(p[0].providerId).toBe('agentrouter');
    expect(p[0].backendModel).toBe('anthropic/claude-opus-4.8');
  });

  it('all target aliases resolve to AgentRouter', async () => {
    const provider = freshProvider();
    await register(provider);

    for (const [alias, backend] of [
      ['claude-opus-4-8', 'anthropic/claude-opus-4.8'],
      ['claude-opus-4.8', 'anthropic/claude-opus-4.8'],
      ['claude-opus-5', 'anthropic/claude-opus-5'],
      ['claude-sonnet-5', 'anthropic/claude-sonnet-5'],
      ['gpt-5-6-sol', 'openai/gpt-5.6-sol'],
      ['anthropic/claude-opus-4.8', 'anthropic/claude-opus-4.8'],
    ] as const) {
      const p = modelRegistry.getProvidersForModel(alias);
      expect(p[0]?.providerId, `alias ${alias}`).toBe('agentrouter');
      expect(p[0]?.backendModel ?? p[0]?.model, `backend for ${alias}`).toBe(backend);
    }
  });

  it('GET /v1/models registry entries include both canonical id and dashed alias', async () => {
    const provider = freshProvider();
    await register(provider);
    const ids = modelRegistry.getAllEntries().map((e) => e.model);
    expect(ids).toContain('anthropic/claude-opus-4.8');
    expect(ids).toContain('claude-opus-4.8');
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('anthropic/claude-opus-5');
    expect(ids).toContain('claude-opus-5');
  });
});

describe('AgentRouter static catalog (WAF/HTML/empty discovery)', () => {
  beforeEach(() => {
    modelRegistry.clear();
    discoveryStore.reset();
  });

  async function makeBlockedProvider() {
    // Dynamic import so the module-level model cache is fresh per call.
    vi.resetModules();
    const { AgentRouterProvider, createAgentRouterKeyManager } = await import('../src/providers/agentrouter');
    const km = createAgentRouterKeyManager(['k1']);
    const provider = new AgentRouterProvider(km, BASE_URL, 10000);
    (provider as any).client = {
      get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body>Access Denied</body></html>' }),
      request: vi.fn(),
      post: vi.fn(),
    };
    (provider as any).anthropicClient = {
      get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html></html>' }),
      request: vi.fn(),
      post: vi.fn(),
    };
    return provider;
  }

  it('keeps the provider healthy via static catalog when /v1/models returns HTML/WAF', async () => {
    const { AgentRouterProvider, createAgentRouterKeyManager } = await import('../src/providers/agentrouter');
    const km = createAgentRouterKeyManager(['k1']);
    const provider = new AgentRouterProvider(km, BASE_URL, 10000);
    (provider as any).client = {
      get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body>Access Denied</body></html>' }),
      request: vi.fn(),
      post: vi.fn(),
    };
    (provider as any).anthropicClient = {
      get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html></html>' }),
      request: vi.fn(),
      post: vi.fn(),
    };

    modelRegistry.clear();
    (registry as any).providers = (registry as any).providers.filter((p: any) => p.identity.providerId !== 'agentrouter');
    (registry as any).providerMap.delete('agentrouter');
    registry.register(provider.getProviderInfo(), provider as any);

    const result = await provider.listModels();
    expect(result.source).toBe('static');
    expect(result.data.length).toBeGreaterThan(0);

    await modelRegistry.loadFromProvider('agentrouter');
    const p = modelRegistry.getProvidersForModel('claude-opus-4-8');
    expect(p[0]?.providerId).toBe('agentrouter');
    expect(p[0]?.backendModel ?? p[0]?.model).toBe('anthropic/claude-opus-4.8');

    // claude-* must route to the Anthropic protocol (base URL WITHOUT /v1).
    const proto = (provider as any).resolveProtocol('claude-opus-4-8');
    expect(proto).toBe('anthropic');
  });

  it('healthCheck stays ok even when /v1/models is blocked by WAF', async () => {
    const provider = await makeBlockedProvider();
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.models).toBeGreaterThan(0);
  });
});
