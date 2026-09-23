import { describe, it, expect, vi } from 'vitest';
import { JijiProvider, createJijiKeyManager } from '../src/providers/jiji';
import { MODELS } from '../src/providers/jiji/models';

const BASE_URL = 'https://www.jiji.cc/v1';

function makeProvider(): JijiProvider {
  const km = createJijiKeyManager(['test-key-1']);
  return new JijiProvider(km, BASE_URL, 10000);
}

function mockClient(provider: JijiProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('JijiProvider', () => {
  it('getProviderInfo returns jiji identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'jiji', providerName: 'Jiji' });
  });

  it('chatCompletion posts to /chat/completions with Bearer auth', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = { model: 'deepseek-v4-pro-0813', messages: [{ role: 'user', content: 'hi' }] };
    await provider.chatCompletion(payload);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const config = requestMock.mock.calls[0][0];
    expect(config.method).toBe('post');
    expect(config.url).toBe('/chat/completions');
    expect(config.headers['Authorization']).toBe('Bearer test-key-1');
  });

  it('listModels falls back to the static free catalog when discovery fails', async () => {
    const provider = makeProvider();
    const getMock = vi.fn().mockRejectedValue({ response: { status: 403, data: 'blocked' } });
    mockClient(provider, { get: getMock });

    const res = await provider.listModels();
    expect(res.object).toBe('list');
    expect(res.data.map((m: any) => m.id)).toEqual(MODELS);
  });

  it('createEmbedding rejects with 400', async () => {
    const provider = makeProvider();
    await expect(provider.createEmbedding({ model: 'x', input: 'hi' })).rejects.toMatchObject({ status: 400 });
  });
});
