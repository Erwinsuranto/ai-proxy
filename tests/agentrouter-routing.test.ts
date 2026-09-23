import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelRegistry } from '../src/lib/model-registry';
import { registry } from '../src/providers/registry';
import { AgentRouterProvider, createAgentRouterKeyManager } from '../src/providers/agentrouter';

const BASE_URL = 'https://agentrouter.org/v1';

// Model catalog mirroring what AgentRouter's GET /v1/models returns: every id
// carries an org/vendor namespace prefix. None of them are OpenAI/Anthropic
// specific in a way we should infer from the name.
const UPSTREAM_MODELS = [
  { id: 'anthropic/claude-opus-4-8', owned_by: 'anthropic' },
  { id: 'openai/gpt-5', owned_by: 'openai' },
  { id: 'google/gemini-3-pro', owned_by: 'google' },
  { id: 'deepseek/deepseek-v4', owned_by: 'deepseek' },
  { id: 'x-ai/grok-4', owned_by: 'x-ai' },
  { id: 'qwen/qwen3-max', owned_by: 'qwen' },
  { id: 'z-ai/glm-5', owned_by: 'z-ai' },
  // Explicitly Anthropic-Messages-only model (metadata says so):
  { id: 'anthropic/claude-messages-only', owned_by: 'anthropic', protocol: 'anthropic' },
];

function makeProvider(models = UPSTREAM_MODELS): AgentRouterProvider {
  const km = createAgentRouterKeyManager(['test-key-1', 'test-key-2']);
  const provider = new AgentRouterProvider(km, BASE_URL, 10000);
  const requestMock = vi.fn().mockResolvedValue({ data: { id: 'chatcmpl-1', choices: [] } });
  const postMock = vi.fn().mockResolvedValue({ data: { pipe: (x: any) => x } });
  const openai = {
    request: requestMock,
    post: postMock,
    get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { data: models } }),
  };
  const anthropic = {
    request: vi.fn().mockResolvedValue({ data: { id: 'chatcmpl-1', choices: [] } }),
    post: postMock,
    get: vi.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { data: models } }),
  };
  (provider as any).clients = { openai, anthropic, baseUrl: BASE_URL, anthropicBaseUrl: 'https://agentrouter.org' };
  (provider as any).request.clients = (provider as any).clients;
  return provider;
}

async function registerAgentRouter(provider: AgentRouterProvider): Promise<void> {
  modelRegistry.clear();
  // Ensure the provider is present in the singleton registry for loadFromProvider.
  (registry as any).providers = (registry as any).providers.filter(
    (p: any) => p.identity.providerId !== 'agentrouter',
  );
  (registry as any).providerMap.delete('agentrouter');
  registry.register(provider.getProviderInfo(), provider as any);
  await modelRegistry.loadFromProvider('agentrouter');
}

describe('AgentRouter model discovery + prefix-agnostic routing', () => {
  beforeEach(() => {
    modelRegistry.clear();
  });

  it('registers each upstream id under provider "agentrouter" (origin provider)', async () => {
    const provider = makeProvider();
    await registerAgentRouter(provider);

    for (const m of UPSTREAM_MODELS) {
      const providers = modelRegistry.getProvidersForModel(m.id);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers[0].providerId).toBe('agentrouter');
    }
  });

  it('resolves a PREFIXED request "anthropic/claude-opus-4-8" to AgentRouter', async () => {
    const provider = makeProvider();
    await registerAgentRouter(provider);

    const providers = modelRegistry.getProvidersForModel('anthropic/claude-opus-4-8');
    expect(providers[0].providerId).toBe('agentrouter');
    expect(providers[0].model).toBe('anthropic/claude-opus-4-8');
  });

  it('resolves an UNPREFIXED request "claude-opus-4-8" to AgentRouter, backend = anthropic/claude-opus-4-8', async () => {
    const provider = makeProvider();
    await registerAgentRouter(provider);

    const providers = modelRegistry.getProvidersForModel('claude-opus-4-8');
    expect(providers[0].providerId).toBe('agentrouter');
    // Alias keeps the provider but forwards the canonical upstream id.
    expect(providers[0].backendModel).toBe('anthropic/claude-opus-4-8');
  });

  it.each([
    ['gpt-5', 'openai/gpt-5'],
    ['gemini-3-pro', 'google/gemini-3-pro'],
    ['deepseek-v4', 'deepseek/deepseek-v4'],
    ['grok-4', 'x-ai/grok-4'],
    ['qwen3-max', 'qwen/qwen3-max'],
    ['glm-5', 'z-ai/glm-5'],
  ])('unprefixed "%s" resolves to AgentRouter with backend "%s" (no hardcoded Claude-only logic)', async (alias, upstream) => {
    const provider = makeProvider();
    await registerAgentRouter(provider);

    const providers = modelRegistry.getProvidersForModel(alias);
    expect(providers[0].providerId).toBe('agentrouter');
    expect(providers[0].backendModel).toBe(upstream);
  });

  it('does not use the name prefix to select a provider (no provider named "anthropic")', async () => {
    const provider = makeProvider();
    await registerAgentRouter(provider);
    expect(registry.getProviderById('anthropic')).toBeUndefined();
    // Yet the prefixed model still resolves — via the registry, not the prefix.
    expect(modelRegistry.getProvidersForModel('anthropic/claude-opus-4-8')[0].providerId).toBe('agentrouter');
  });
});

describe('AgentRouter per-model endpoint/protocol selection', () => {
  it('defaults OpenAI-compatible models to POST /chat/completions', async () => {
    const provider = makeProvider();
    await provider.listModels();
    const requestMock = (provider as any).clients.openai.request;

    await provider.chatCompletion({ model: 'openai/gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    const cfg = requestMock.mock.calls.at(-1)[0];
    expect(cfg.url).toBe('/chat/completions');
    // No Anthropic auth headers on the OpenAI path.
    expect(cfg.headers['x-api-key']).toBeUndefined();
    expect(cfg.headers['anthropic-version']).toBeUndefined();
  });

  it('routes an Anthropic-Messages-only model to POST /messages with anthropic headers + translated body', async () => {
    const provider = makeProvider();
    await provider.listModels();
    const requestMock = (provider as any).clients.anthropic.request;
    requestMock.mockResolvedValueOnce({
      data: {
        id: 'msg_1',
        model: 'anthropic/claude-messages-only',
        content: [{ type: 'text', text: 'hello there' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    });

    const result = await provider.chatCompletion({
      model: 'anthropic/claude-messages-only',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 100,
    });

    const cfg = requestMock.mock.calls.at(-1)[0];
    expect(cfg.url).toBe('/messages');
    expect(cfg.headers['x-api-key']).toBe('test-key-1');
    expect(cfg.headers['anthropic-version']).toBeDefined();
    // Anthropic request shape: system hoisted, messages without system role.
    expect(cfg.data.system).toBe('be nice');
    expect(cfg.data.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(cfg.data.max_tokens).toBe(100);
    // Response translated back into OpenAI Chat Completion shape.
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('hello there');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBe(8);
  });

  it('resolves protocol by de-prefixed alias too', async () => {
    const provider = makeProvider();
    await provider.listModels();
    // "gpt-5" (alias of openai/gpt-5) must resolve to the openai protocol.
    expect((provider as any).resolveProtocol('gpt-5')).toBe('openai');
    expect((provider as any).resolveProtocol('claude-messages-only')).toBe('anthropic');
  });
});
