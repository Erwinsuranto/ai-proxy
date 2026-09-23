import { describe, it, expect, vi } from 'vitest';
import { HCNSecProvider, createHCNSecKeyManager } from '../src/providers/hcnsec';

const BASE_URL = 'https://api.hcnsec.cn/v1';

function makeProvider(): HCNSecProvider {
  const km = createHCNSecKeyManager(['test-key-1', 'test-key-2']);
  return new HCNSecProvider(km, BASE_URL, 10000);
}

function mockClient(provider: HCNSecProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('HCNSecProvider', () => {
  it('getProviderInfo returns hcnsec identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'hcnsec', providerName: 'HCNSec' });
  });

  it('getBaseUrl trims trailing slashes and uses default base URL', () => {
    const provider = makeProvider();
    expect(provider.getBaseUrl()).toBe(BASE_URL);
  });

  it('chatCompletion posts to OpenAI-compatible /chat/completions with Bearer auth', async () => {
    const provider = makeProvider();
    const requestMock = vi.fn().mockResolvedValue({
      data: { id: 'chatcmpl-1', object: 'chat.completion', choices: [], usage: {} },
    });
    mockClient(provider, { request: requestMock });

    const payload = { model: 'qwen2.5-72b-instruct', messages: [{ role: 'user', content: 'hi' }] };
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
      data: { data: [{ id: 'qwen2.5-72b-instruct' }, { id: 'deepseek-chat' }] },
    });
    mockClient(provider, { get: getMock });

    const result = await provider.listModels();

    expect(getMock).toHaveBeenCalledWith(
      '/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key-1' }) }),
    );
    expect(result.source).toBe('api');
    expect(result.data.map((m: any) => m.id)).toEqual(['qwen2.5-72b-instruct', 'deepseek-chat']);
  });

  it('listModels falls back to manual catalog when upstream fails', async () => {
    vi.resetModules();
    const { HCNSecProvider, createHCNSecKeyManager } = await import('../src/providers/hcnsec');
    const km = createHCNSecKeyManager(['test-key-1', 'test-key-2']);
    const provider = new HCNSecProvider(km, BASE_URL, 10000);
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await provider.listModels();

    expect(result.source).toBe('fallback');
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].id).toBe('qwen2.5-72b-instruct');
  });

  it('healthCheck reports ok with model count when GET /models succeeds', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockResolvedValue({ status: 200, data: { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }),
    });

    const health = await provider.healthCheck();

    expect(health.provider).toBe('hcnsec');
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
});

describe('HCNSec key loading priority', () => {
  const HCNSEC_ENV_KEYS = [
    'HCNSEC_API_KEY_1', 'HCNSEC_API_KEY_2', 'HCNSEC_API_KEY_3',
    'HCNSEC_API_KEY_4', 'HCNSEC_API_KEY_5', 'HCNSEC_API_KEYS', 'HCNSEC_API_KEY',
  ];
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of HCNSEC_ENV_KEYS) original.set(key, process.env[key]);
    // Set to empty string (not delete) so dotenv does not repopulate them from
    // .env when ../src/config is imported.
    for (const key of HCNSEC_ENV_KEYS) process.env[key] = '';
  });

  afterEach(() => {
    for (const key of HCNSEC_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original.clear();
  });

  it('prioritizes HCNSEC_API_KEY_1..5 over comma list and single key', async () => {
    process.env.HCNSEC_API_KEY_1 = 'vertical-1';
    process.env.HCNSEC_API_KEY_2 = '';
    process.env.HCNSEC_API_KEY_3 = 'vertical-3';
    process.env.HCNSEC_API_KEYS = 'csv-1,csv-2';
    process.env.HCNSEC_API_KEY = 'single';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.hcnsecApiKeys).toEqual(['vertical-1', 'vertical-3']);
  });

  it('falls back to HCNSEC_API_KEYS (comma) when no numbered keys are set', async () => {
    process.env.HCNSEC_API_KEYS = 'csv-1, csv-2';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.hcnsecApiKeys).toEqual(['csv-1', 'csv-2']);
  });

  it('falls back to HCNSEC_API_KEY when neither numbered nor comma keys are set', async () => {
    process.env.HCNSEC_API_KEY = 'single-key';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.hcnsecApiKeys).toEqual(['single-key']);
  });
});