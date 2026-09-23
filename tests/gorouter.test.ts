import { describe, it, expect, vi } from 'vitest';
import { GoRouterProvider, createGoRouterKeyManager } from '../src/providers/gorouter';

const BASE_URL = 'https://gorouter.app/v1';

function makeProvider(): GoRouterProvider {
  const km = createGoRouterKeyManager(['test-key-1', 'test-key-2']);
  return new GoRouterProvider(km, BASE_URL, 10000);
}

function mockClient(provider: GoRouterProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

/* Prompt 13: GoRouter.app is explicitly NOT used. Its test suite is skipped
 * (not deleted, not falsified) so the skip count is reported by vitest while
 * the GoRouter source remains available for reference. Do NOT re-enable. */
describe.skip('GoRouterProvider', () => {
  it('getProviderInfo returns gorouter identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'gorouter', providerName: 'GoRouter' });
  });

  it('getKeyManager returns the key manager', () => {
    const provider = makeProvider();
    expect(provider.getKeyManager().keyCount).toBe(2);
  });

  it('chatCompletion posts to OpenAI-compatible /chat/completions and forwards tools/vision payload', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = {
      model: 'deepseek-v4-flash',
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

    const result = await provider.chatCompletion(payload);

    expect(result).toEqual({ id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} });
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

  it('messages posts to Anthropic-compatible /messages endpoint', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'msg-1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn' },
    });
    mockClient(provider, { request: requestMock });

    const payload = {
      model: 'deepseek-v4-flash',
      max_tokens: 128,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = await provider.messages(payload);

    expect(result.id).toBe('msg-1');
    expect(requestMock).toHaveBeenCalledTimes(1);
    const config = requestMock.mock.calls[0][0];
    expect(config.method).toBe('post');
    expect(config.url).toBe('/messages');
    expect(config.data).toEqual(payload);
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
  });

  it('messagesRaw returns raw text response from /messages', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: '{"id":"msg-1","type":"message"}',
    });
    mockClient(provider, { request: requestMock });

    const raw = await provider.messagesRaw({ model: 'm', max_tokens: 10, messages: [] });

    expect(raw).toBe('{"id":"msg-1","type":"message"}');
    const config = requestMock.mock.calls[0][0];
    expect(config.responseType).toBe('text');
    expect(config.url).toBe('/messages');
  });

  it('messagesStream sets stream:true and posts to /messages', async () => {
    const provider = makeProvider();
    const streamObj = { pipe: vi.fn() };
    const postMock = vi.fn().mockResolvedValue({ data: streamObj });
    mockClient(provider, { post: postMock });

    const result = await provider.messagesStream({ model: 'm', max_tokens: 10, messages: [] });

    const [url, data, config] = postMock.mock.calls[0];
    expect(url).toBe('/messages');
    expect(data.stream).toBe(true);
    expect(config.responseType).toBe('stream');
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
    expect(result.stream).toBe(streamObj);
    expect(result.keyIndex).toBe(0);
  });

  it('listModels uses dynamic GET /models when upstream is reachable', async () => {
    const provider = makeProvider();
    const getMock = vi.fn().mockResolvedValue({
      data: { data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] },
    });
    mockClient(provider, { get: getMock });

    const result = await provider.listModels();

    expect(getMock).toHaveBeenCalledWith(
      '/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key-1' }) }),
    );
    expect(result.source).toBe('api');
    expect(result.data.map((m: any) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(result.data.every((m: any) => m.owned_by === 'gorouter')).toBe(true);
  });

  it('listModels falls back to empty catalog when upstream fails', async () => {
    vi.resetModules();
    const { GoRouterProvider, createGoRouterKeyManager } = await import('../src/providers/gorouter');
    const km = createGoRouterKeyManager(['test-key-1', 'test-key-2']);
    const provider = new GoRouterProvider(km, BASE_URL, 10000);
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await provider.listModels();

    expect(result.source).toBe('fallback');
    expect(result.data).toEqual([]);
  });

  it('fails over to the next key within one call after a 429 on the first key', async () => {
    const provider = makeProvider();
    const requestMock = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: { id: 'chatcmpl-ok', choices: [] } });
    mockClient(provider, { request: requestMock });

    const result = await provider.chatCompletion({ model: 'm', messages: [] });

    expect(result.id).toBe('chatcmpl-ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0][0].headers['Authorization']).toBe('Bearer test-key-1');
    expect(requestMock.mock.calls[1][0].headers['Authorization']).toBe('Bearer test-key-2');
    expect(provider.getKeyManager().availableKeys()).toEqual([1]);
  });

  it('fails over to the next key within one call after a 403 on the first key', async () => {
    const provider = makeProvider();
    const requestMock = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockResolvedValueOnce({ data: { id: 'chatcmpl-ok', choices: [] } });
    mockClient(provider, { request: requestMock });

    const result = await provider.chatCompletion({ model: 'm', messages: [] });

    expect(result.id).toBe('chatcmpl-ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0][0].headers['Authorization']).toBe('Bearer test-key-1');
    expect(requestMock.mock.calls[1][0].headers['Authorization']).toBe('Bearer test-key-2');
  });

  it('skips cooldowned keys on subsequent requests', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({ data: { id: 'chatcmpl-ok', choices: [] } });
    mockClient(provider, { request: requestMock });
    provider.getKeyManager().markCooldown(0);

    const result = await provider.chatCompletion({ model: 'm', messages: [] });

    expect(result.id).toBe('chatcmpl-ok');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].headers['Authorization']).toBe('Bearer test-key-2');
  });

  it('throws the last error after every key has been tried', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockRejectedValue({ response: { status: 403 } });
    mockClient(provider, { request: requestMock });

    await expect(provider.chatCompletion({ model: 'm', messages: [] })).rejects.toMatchObject({ status: 403 });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('throws a rate limit error when all keys are in cooldown', async () => {
    const provider = makeProvider();
    const km = provider.getKeyManager();
    km.markCooldown(0);
    km.markCooldown(1);

    await expect(provider.chatCompletion({ model: 'm', messages: [] })).rejects.toMatchObject({ status: 429 });
  });

  it('createEmbedding is unsupported', async () => {
    const provider = makeProvider();
    await expect(provider.createEmbedding({})).rejects.toMatchObject({ status: 400 });
  });
});

describe.skip('GoRouter key loading priority', () => {
  const GOROUTER_ENV_KEYS = [
    'GOROUTER_API_KEY_1', 'GOROUTER_API_KEY_2', 'GOROUTER_API_KEY_3',
    'GOROUTER_API_KEY_4', 'GOROUTER_API_KEY_5', 'GOROUTER_API_KEY_6',
    'GOROUTER_API_KEYS', 'GOROUTER_API_KEY',
  ];
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of GOROUTER_ENV_KEYS) original.set(key, process.env[key]);
    // Set to empty string (not delete) so dotenv does not repopulate them from
    // .env when ../src/config is imported.
    for (const key of GOROUTER_ENV_KEYS) process.env[key] = '';
  });

  afterEach(() => {
    for (const key of GOROUTER_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original.clear();
  });

  it('prioritizes GOROUTER_API_KEY_1..N over comma list and single key', async () => {
    process.env.GOROUTER_API_KEY_1 = 'vertical-1';
    process.env.GOROUTER_API_KEY_2 = '';
    process.env.GOROUTER_API_KEY_3 = 'vertical-3';
    process.env.GOROUTER_API_KEYS = 'csv-1,csv-2';
    process.env.GOROUTER_API_KEY = 'single';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.gorouterApiKeys).toEqual(['vertical-1', 'vertical-3']);
  });

  it('falls back to GOROUTER_API_KEYS (comma) when no numbered keys are set', async () => {
    process.env.GOROUTER_API_KEYS = 'csv-1, csv-2';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.gorouterApiKeys).toEqual(['csv-1', 'csv-2']);
  });

  it('falls back to GOROUTER_API_KEY when neither numbered nor comma keys are set', async () => {
    process.env.GOROUTER_API_KEY = 'single-key';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.gorouterApiKeys).toEqual(['single-key']);
  });
});
