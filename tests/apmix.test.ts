import { describe, it, expect, vi } from 'vitest';
import { ApmixProvider, createApmixKeyManager } from '../src/providers/apmix';
import { MODELS } from '../src/providers/apmix/models';

const BASE_URL = 'https://api.apmix.ai/v1';

function makeProvider(): ApmixProvider {
  const km = createApmixKeyManager(['test-key-1']);
  return new ApmixProvider(km, BASE_URL, 10000);
}

function mockClient(provider: ApmixProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('ApmixProvider', () => {
  it('getProviderInfo returns apmix identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'apmix', providerName: 'Apmix' });
  });

  it('chatCompletion posts to /chat/completions with Bearer auth', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = { model: 'glm-5.2-free', messages: [{ role: 'user', content: 'hi' }] };
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

describe('ApmixProvider stream header timeout', () => {
  it('aborts when upstream never sends stream headers and surfaces a retryable timeout error', async () => {
    process.env.APMIX_STREAM_HEADER_TIMEOUT_MS = '150';
    vi.resetModules();
    const { ApmixProvider, createApmixKeyManager } = await import('../src/providers/apmix');
    const km = createApmixKeyManager(['k1']);
    const provider = new ApmixProvider(km, 'https://api.apmix.ai/v1', 10000);
    const postMock = vi.fn().mockImplementation((_u: string, _d: any, cfg: any) => {
      return new Promise((_resolve, reject) => {
        cfg.signal.addEventListener('abort', () => {
          const e: any = new Error('canceled'); e.code = 'ERR_CANCELED'; reject(e);
        });
      });
    });
    (provider as any).client = { request: vi.fn(), post: postMock, get: vi.fn() };

    const payload = { model: 'kimi-k3-free', messages: [{ role: 'user', content: 'hi' }] };
    const t0 = Date.now();
    const err = await provider.chatCompletionStream(payload).then(
      () => null,
      (e: any) => e,
    );
    const elapsed = Date.now() - t0;

    expect(err).toBeTruthy();
    expect(String(err.message)).toContain('timeout');
    expect(elapsed).toBeLessThan(2000);
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});
