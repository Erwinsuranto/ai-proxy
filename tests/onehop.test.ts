import { describe, it, expect, vi } from 'vitest';
import { OneHopProvider, createOneHopKeyManager } from '../src/providers/onehop';

const BASE_URL = 'https://api.onehop.ai/v1';

function makeProvider(): OneHopProvider {
  const km = createOneHopKeyManager(['test-key-1', 'test-key-2']);
  return new OneHopProvider(km, BASE_URL, 10000);
}

function mockClient(provider: OneHopProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('OneHopProvider', () => {
  it('getProviderInfo returns onehop identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'onehop', providerName: 'OneHop' });
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

  it('listModels uses dynamic GET /models when upstream is reachable', async () => {
    const provider = makeProvider();
    const getMock = vi.fn().mockResolvedValue({
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

  it('listModels falls back to empty catalog when upstream fails', async () => {
    vi.resetModules();
    const { OneHopProvider, createOneHopKeyManager } = await import('../src/providers/onehop');
    const km = createOneHopKeyManager(['test-key-1', 'test-key-2']);
    const provider = new OneHopProvider(km, BASE_URL, 10000);
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await provider.listModels();

    expect(result.source).toBe('fallback');
    expect(result.data).toEqual([]);
  });

  it('healthCheck reports ok with model count when GET /models succeeds', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockResolvedValue({ status: 200, data: { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }),
    });

    const health = await provider.healthCheck();

    expect(health.provider).toBe('onehop');
    expect(health.ok).toBe(true);
    expect(health.status).toBe(200);
    expect(health.models).toBe(3);
    expect(typeof health.latency).toBe('number');
  });

  it('healthCheck reports failure when GET /models fails', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 502 }, message: 'bad gateway' }),
    });

    const health = await provider.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.status).toBe(502);
    expect(health.models).toBe(0);
  });

  it('createEmbedding is unsupported', async () => {
    const provider = makeProvider();
    await expect(provider.createEmbedding({})).rejects.toMatchObject({ status: 400 });
  });

  it('fails over to the next key when the first key is cooldowned', async () => {
    const provider = makeProvider();
    const requestMock = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: { id: 'chatcmpl-ok', choices: [] } });
    mockClient(provider, { request: requestMock });

    await expect(provider.chatCompletion({ model: 'm', messages: [] })).rejects.toMatchObject({ status: 429 });
    expect(provider.getKeyManager().availableKeys()).toEqual([1]);

    const result = await provider.chatCompletion({ model: 'm', messages: [] });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('chatcmpl-ok');
    expect(requestMock.mock.calls[1][0].headers['Authorization']).toBe('Bearer test-key-2');
  });
});
