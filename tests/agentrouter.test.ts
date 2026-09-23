import { describe, it, expect, vi } from 'vitest';
import { AgentRouterProvider, createAgentRouterKeyManager } from '../src/providers/agentrouter';

const BASE_URL = 'https://agentrouter.org/v1';

function makeProvider(): AgentRouterProvider {
  const km = createAgentRouterKeyManager(['test-key-1', 'test-key-2']);
  return new AgentRouterProvider(km, BASE_URL, 10000);
}

function mockClient(provider: AgentRouterProvider, overrides: Record<string, any> = {}): void {
  const client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
  (provider as any).clients = {
    openai: client,
    anthropic: { ...overrides },
  };
  (provider as any).request.clients = (provider as any).clients;
}

describe('AgentRouterProvider', () => {
  it('getProviderInfo returns agentrouter identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'agentrouter', providerName: 'AgentRouter' });
  });

  it('getBaseUrl trims trailing slashes', () => {
    const provider = makeProvider();
    expect(provider.getBaseUrl()).toBe(BASE_URL);
  });

  it('chatCompletion posts to OpenAI-compatible /chat/completions and forwards tools/vision payload', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = {
      model: 'some-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      tool_choice: 'auto',
    };

    await provider.chatCompletion(payload);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const config = requestMock.mock.calls[0][0];
    expect(config.method).toBe('post');
    expect(config.url).toBe('/chat/completions');
    expect(config.data).toEqual(payload);
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
  });

  it('chatCompletionRaw returns raw text response', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: '{"id":"chatcmpl-1","object":"chat.completion"}',
    });
    mockClient(provider, { request: requestMock });

    const raw = await provider.chatCompletionRaw({ model: 'm', messages: [] });

    expect(raw).toBe('{"id":"chatcmpl-1","object":"chat.completion"}');
    const config = requestMock.mock.calls[0][0];
    expect(config.responseType).toBe('text');
    expect(config.url).toBe('/chat/completions');
  });

  it('chatCompletionStream sets stream:true and returns the upstream stream', async () => {
    const provider = makeProvider();
    const streamObj = { pipe: vi.fn() };
    const postMock = vi.fn().mockResolvedValue({ data: streamObj });
    mockClient(provider, { post: postMock });

    const result = await provider.chatCompletionStream({ model: 'm', messages: [] });

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, data, config] = postMock.mock.calls[0];
    expect(url).toBe('/chat/completions');
    expect(data.stream).toBe(true);
    expect(config.responseType).toBe('stream');
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
    expect(result.stream).toBe(streamObj);
    expect(result.keyIndex).toBe(0);
  });

  it('listModels uses dynamic GET /models (never hardcoded) when upstream is reachable', async () => {
    const provider = makeProvider();
    const getMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { data: [{ id: 'model-a' }, { id: 'model-b' }] },
    });
    mockClient(provider, { get: getMock });

    const result = await provider.listModels();

    expect(getMock).toHaveBeenCalledWith(
      '/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key-1' }) }),
    );
    expect(result.source).toBe('api');
    expect(result.data.map((m: any) => m.id)).toEqual(['model-a', 'model-b']);
  });

  it('listModels falls back to the static catalog (never empty) when upstream fails', async () => {
    vi.resetModules();
    const { AgentRouterProvider, createAgentRouterKeyManager } = await import('../src/providers/agentrouter');
    const km = createAgentRouterKeyManager(['test-key-1', 'test-key-2']);
    const provider = new AgentRouterProvider(km, BASE_URL, 10000);
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await provider.listModels();

    expect(result.source).toBe('static');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('round-robins across multiple API keys', async () => {
    const provider = makeProvider();
    const requestMock = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'a' } })
      .mockResolvedValueOnce({ data: { id: 'b' } });
    mockClient(provider, { request: requestMock });

    await provider.chatCompletion({ model: 'm', messages: [] });
    await provider.chatCompletion({ model: 'm', messages: [] });

    expect(requestMock.mock.calls[0][0].headers['Authorization']).toBe('Bearer test-key-1');
    expect(requestMock.mock.calls[1][0].headers['Authorization']).toBe('Bearer test-key-2');
  });

it('marks a rate-limited key for cooldown and fails over to the next key on the next request', async () => {
    const provider = makeProvider();
    const requestMock = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 }, message: 'ratelimited' })
      .mockResolvedValueOnce({ data: { id: 'chatcmpl-ok', choices: [] } });
    mockClient(provider, { request: requestMock });

    const km = provider.getKeyManager() as any;

    await expect(provider.chatCompletion({ model: 'm', messages: [] })).rejects.toMatchObject({ status: 429 });
    expect(km.keyStats[0].disabledUntil).toBeTypeOf('number');

    const result = await provider.chatCompletion({ model: 'm', messages: [] });
    expect(result.id).toBe('chatcmpl-ok');
    expect(requestMock.mock.calls[1][0].headers['Authorization']).toBe('Bearer test-key-2');
  });

  it('healthCheck reports ok WITHOUT depending on GET /v1/models', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 502 }, message: 'bad gateway' }),
    });

    const health = await provider.healthCheck();

    // Even though /v1/models would fail (e.g. WAF/HTML/empty), health stays ok
    // because it keys off API-key availability + static catalog, not discovery.
    expect(health.provider).toBe('agentrouter');
    expect(health.ok).toBe(true);
    expect(health.status).toBe(200);
    expect(typeof health.latency).toBe('number');
    expect(provider.getBaseUrl()).toBe(BASE_URL);
  });

  it('healthCheck reports failure only when no API key is available', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 502 }, message: 'bad gateway' }),
    });
    const km = provider.getKeyManager() as any;
    km.keyStats[0].disabledUntil = Infinity;
    km.keyStats[1].disabledUntil = Infinity;

    const health = await provider.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe(429);
    expect(health.models).toBe(4);
  });

  it('createEmbedding is unsupported', async () => {
    const provider = makeProvider();
    await expect(provider.createEmbedding({})).rejects.toMatchObject({ status: 400 });
  });

  it('forwards OpenAI payload verbatim in proxy mode (no body transform)', async () => {
    vi.resetModules();
    const { AgentRouterProvider, createAgentRouterKeyManager } = await import('../src/providers/agentrouter');
    const km = createAgentRouterKeyManager(['test-key-1']);
    const provider = new AgentRouterProvider(km, BASE_URL, 10000, undefined, true);
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-proxy', object: 'chat.completion', choices: [] },
    });
    mockClient(provider, { request: requestMock });

    const payload = { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 123 };
    const result = await provider.chatCompletion(payload);

    const cfg = requestMock.mock.calls[0][0];
    expect(result.id).toBe('chatcmpl-proxy');
    expect(cfg.url).toBe('/chat/completions');
    expect(cfg.data).toEqual(payload); // verbatim, unchanged
  });
});