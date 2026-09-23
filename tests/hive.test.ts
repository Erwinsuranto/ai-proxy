import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { HiveProvider, createHiveKeyManager } from '../src/providers/hive';
import { MODELS } from '../src/providers/hive/models';

const BASE_URL = 'https://api-cdn.thehive.ai/api/v3';

function makeProvider(): HiveProvider {
  const km = createHiveKeyManager(['test-key-1', 'test-key-2']);
  return new HiveProvider(km, BASE_URL, 10000);
}

function mockClient(provider: HiveProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('HiveProvider', () => {
  it('getProviderInfo returns hive identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'hive', providerName: 'Hive' });
  });

  it('getBaseUrl trims trailing slashes', () => {
    const km = createHiveKeyManager(['k']);
    expect(new HiveProvider(km, BASE_URL + '///', 1000).getBaseUrl()).toBe(BASE_URL);
  });

  it('chatCompletion posts to /chat/completions (no /v1 prefix) with Bearer auth', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = { model: 'hive/vision-language-model', messages: [{ role: 'user', content: 'hi' }] };
    await provider.chatCompletion(payload);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const config = requestMock.mock.calls[0][0];
    expect(config.method).toBe('post');
    expect(config.url).toBe('/chat/completions');
    expect(config.data).toEqual(payload);
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
  });

  it('falls back to stream reassembly when a plain call 500s', async () => {
    const provider = makeProvider();
    const sse = 'data: {"id":"x","model":"m","choices":[{"delta":{"content":"he"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const requestMock = vi.fn().mockRejectedValue({ status: 500, response: { status: 500, data: 'err' } });
    const postMock = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: Readable.from([sse]) });
    mockClient(provider, { request: requestMock, post: postMock });

    const res = await provider.chatCompletion({ model: 'deepseek-ai/deepseek-v4.1-flash', messages: [] });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(res.choices[0].message.content).toBe('hello');
    expect(res.choices[0].finish_reason).toBe('stop');
  });

  it('listModels returns the static catalog without upstream calls', async () => {
    const provider = makeProvider();
    const getMock = vi.fn();
    mockClient(provider, { get: getMock });

    const res = await provider.listModels();
    expect(getMock).not.toHaveBeenCalled();
    expect(res.object).toBe('list');
    expect(res.data.map((m: any) => m.id)).toEqual(MODELS);
  });

  it('createEmbedding rejects with 400', async () => {
    const provider = makeProvider();
    await expect(provider.createEmbedding({ model: 'x', input: 'hi' })).rejects.toMatchObject({ status: 400 });
  });

  it('healthCheck reports key availability without upstream calls', async () => {
    const provider = makeProvider();
    const getMock = vi.fn();
    mockClient(provider, { get: getMock });

    const h = await provider.healthCheck();
    expect(getMock).not.toHaveBeenCalled();
    expect(h.provider).toBe('hive');
    expect(h.ok).toBe(true);
    expect(h.models).toBe(MODELS.length);
  });
});
