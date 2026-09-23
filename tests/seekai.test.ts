import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { SeekAIProvider, createSeekAIKeyManager } from '../src/providers/seekai';
import { detectInlineUpstreamError, getStreamVerdict } from '../src/lib/inline-error';

const BASE_URL = 'https://seekai.cc/v1';

function makeProvider(): SeekAIProvider {
  const km = createSeekAIKeyManager(['test-key-1', 'test-key-2']);
  return new SeekAIProvider(km, BASE_URL, 10000);
}

function mockClient(provider: SeekAIProvider, overrides: Record<string, any> = {}): void {
  (provider as any).client = {
    request: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

/** Builds a SeekAIProvider whose axios client is fully mocked. */
function providerWithRequest(requestMock: any, postMock?: any): SeekAIProvider {
  const km = createSeekAIKeyManager(['test-key-1', 'test-key-2']);
  const provider = new SeekAIProvider(km, BASE_URL, 10000);
  (provider as any).client = {
    request: requestMock,
    post: postMock ?? requestMock,
    get: vi.fn(),
  };
  return provider;
}

describe('SeekAIProvider', () => {
  it('getProviderInfo returns seekai identity', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toEqual({ providerId: 'seekai', providerName: 'SeekAI' });
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
  });

  it('listModels falls back to manual catalog when upstream fails', async () => {
    vi.resetModules();
    const { SeekAIProvider, createSeekAIKeyManager } = await import('../src/providers/seekai');
    const km = createSeekAIKeyManager(['test-key-1', 'test-key-2']);
    const provider = new SeekAIProvider(km, BASE_URL, 10000);
    mockClient(provider, {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await provider.listModels();

    expect(result.source).toBe('fallback');
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].id).toBe('deepseek-v4-flash');
  });

  it('healthCheck reports ok with model count when GET /models succeeds', async () => {
    const provider = makeProvider();
    mockClient(provider, {
      get: vi.fn().mockResolvedValue({ status: 200, data: { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }),
    });

    const health = await provider.healthCheck();

    expect(health.provider).toBe('seekai');
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

describe('SeekAI key loading priority', () => {
  const SEEKAI_ENV_KEYS = [
    ...Array.from({ length: 100 }, (_, i) => `SEEKAI_API_KEY_${i + 1}`),
    'SEEKAI_API_KEYS', 'SEEKAI_API_KEY',
  ];
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of SEEKAI_ENV_KEYS) original.set(key, process.env[key]);
    // Set to empty string (not delete) so dotenv does not repopulate them from
    // .env when ../src/config is imported.
    for (const key of SEEKAI_ENV_KEYS) process.env[key] = '';
  });

  afterEach(() => {
    for (const key of SEEKAI_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original.clear();
  });

  it('prioritizes SEEKAI_API_KEY_1..5 over comma list and single key', async () => {
    process.env.SEEKAI_API_KEY_1 = 'vertical-1';
    process.env.SEEKAI_API_KEY_2 = '';
    process.env.SEEKAI_API_KEY_3 = 'vertical-3';
    process.env.SEEKAI_API_KEYS = 'csv-1,csv-2';
    process.env.SEEKAI_API_KEY = 'single';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.seekaiApiKeys).toEqual(['vertical-1', 'vertical-3']);
  });

  it('falls back to SEEKAI_API_KEYS (comma) when no numbered keys are set', async () => {
    process.env.SEEKAI_API_KEYS = 'csv-1, csv-2';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.seekaiApiKeys).toEqual(['csv-1', 'csv-2']);
  });

  it('falls back to SEEKAI_API_KEY when neither numbered nor comma keys are set', async () => {
    process.env.SEEKAI_API_KEY = 'single-key';
    vi.resetModules();
    const { config } = await import('../src/config');
    expect(config.seekaiApiKeys).toEqual(['single-key']);
  });
});

/* ===========================================================================
 * Regression tests — Fix #1: inline upstream errors on HTTP 200 responses
 * (both normal + streaming) must become real upstream failures so the
 * existing fallback / key-rotation path can act on them.
 * =========================================================================== */
describe('SeekAI inline upstream error detection (Fix #1)', () => {
  it('flags [error] Service temporarily unavailable inside choices content', () => {
    const r = detectInlineUpstreamError({
      choices: [{ message: { content: '[error] Service temporarily unavailable' } }],
    });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(502);
  });

  it('flags a top-level JSON error envelope on HTTP 200', () => {
    const r = detectInlineUpstreamError({ error: { message: 'Service temporarily unavailable', code: 503 } });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(503);
  });

  it('flags a raw [error] string body on HTTP 200', () => {
    const r = detectInlineUpstreamError('[error] Service temporarily unavailable');
    expect(r).not.toBeNull();
  });

  it('does NOT flag genuine content that merely contains the word "[error]"', () => {
    const r = detectInlineUpstreamError({
      choices: [{ message: { content: 'I saw [error] in your code and fixed it.' } }],
    });
    expect(r).toBeNull();
  });

  it('does NOT flag a normal completion', () => {
    const r = detectInlineUpstreamError({
      id: 'x', object: 'chat.completion', choices: [{ message: { content: 'Hello world' } }], usage: {},
    });
    expect(r).toBeNull();
  });
});

describe('SeekAI streaming inline error detection (Fix #1)', () => {
  it('detects inline error SSE event', () => {
    const v = getStreamVerdict(
      'data: {"choices":[{"delta":{"content":"[error] Service temporarily unavailable"}}]}\n\n',
      '',
      false,
    );
    expect(v).toBe('error');
  });

  it('detects JSON error envelope inside SSE', () => {
    const v = getStreamVerdict(
      'data: {"error":{"message":"Service temporarily unavailable"}}\n\n',
      '',
      false,
    );
    expect(v).toBe('error');
  });

  it('keeps buffering a split "[error]" tag (no premature legit)', () => {
    // first token of a real error, '[error]' split mid-tag; content.buf is still
    // empty because it is accumulated *after* the verdict is computed.
    const v = getStreamVerdict(
      'data: {"choices":[{"delta":{"content":"[erro"}}]}\n\n',
      '',
      false,
    );
    expect(v).toBeNull();
  });

  it('returns legit for a genuine first token', () => {
    const v = getStreamVerdict(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'Hel',
      true,
    );
    expect(v).toBe('legit');
  });
});

describe('SeekAIProvider rejects inline errors (Fix #1)', () => {
  it('chatCompletion throws on HTTP 200 + inline [error] content', async () => {
    const requestMock = vi.fn().mockResolvedValue({
      data: {
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '[error] Service temporarily unavailable' } }],
        usage: {},
      },
    });
    const provider = providerWithRequest(requestMock);
    await expect(provider.chatCompletion({ model: 'm', messages: [] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it('chatCompletionRaw throws on HTTP 200 + raw [error] text', async () => {
    const requestMock = vi.fn().mockResolvedValue({ data: '[error] Service temporarily unavailable' });
    const provider = providerWithRequest(requestMock);
    await expect(provider.chatCompletionRaw({ model: 'm', messages: [] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it('does NOT treat genuine content containing "[error]" as an error', async () => {
    const requestMock = vi.fn().mockResolvedValue({
      data: {
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'I saw [error] in your code and fixed it.' } }],
        usage: {},
      },
    });
    const provider = providerWithRequest(requestMock);
    const res = await provider.chatCompletion({ model: 'm', messages: [] });
    expect(res.choices[0].message.content).toContain('[error]');
  });

  it('chatCompletionStream rejects when the first SSE event is an inline error', async () => {
    const upstream = new PassThrough();
    const postMock = vi.fn().mockResolvedValue({ data: upstream });
    const provider = providerWithRequest(vi.fn(), postMock);

    const p = provider.chatCompletionStream({ model: 'm', messages: [] });
    // let the provider attach its stream listeners
    await new Promise((r) => setImmediate(r));
    upstream.write('data: {"choices":[{"delta":{"content":"[error] Service temporarily unavailable"}}]}\n\n');
    upstream.write('data: [DONE]\n\n');
    upstream.end();
    await expect(p).rejects.toMatchObject({ status: 502 });
  });

  it('chatCompletionStream forwards genuine SSE content (no false positive)', async () => {
    const upstream = new PassThrough();
    const postMock = vi.fn().mockResolvedValue({ data: upstream });
    const provider = providerWithRequest(vi.fn(), postMock);

    const p = provider.chatCompletionStream({ model: 'm', messages: [] });
    await new Promise((r) => setImmediate(r));
    upstream.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    upstream.write('data: [DONE]\n\n');
    upstream.end();
    const result = await p;
    expect(result.stream).toBeDefined();
    expect(postMock).toHaveBeenCalled();
  });
});

/* ===========================================================================
 * Regression tests — Fix Opus: empty Claude Opus response is retried across keys
 * =========================================================================== */
describe('SeekAI Claude Opus empty retry (Opus Fix)', () => {
  it('retries claude-opus-5 when first key returns empty content (502) and succeeds on second key', async () => {
    const km = createSeekAIKeyManager(['k1', 'k2', 'k3']);
    const provider = new SeekAIProvider(km, BASE_URL, 10000);
    const empty = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: {} };
    const valid = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello opus' }, finish_reason: 'stop' }], usage: {} };
    const requestMock = vi.fn()
      .mockResolvedValueOnce({ data: empty })
      .mockResolvedValueOnce({ data: valid });
    (provider as any).client = { request: requestMock, post: vi.fn(), get: vi.fn() };

    const result = await provider.chatCompletion({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.choices[0].message.content).toBe('Hello opus');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry empty for non-opus model (deepseek)', async () => {
    const km = createSeekAIKeyManager(['k1', 'k2']);
    const provider = new SeekAIProvider(km, BASE_URL, 10000);
    const empty = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: {} };
    const requestMock = vi.fn().mockResolvedValue({ data: empty });
    (provider as any).client = { request: requestMock, post: vi.fn(), get: vi.fn() };

    const result = await provider.chatCompletion({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] });
    // non-opus empty is returned as-is (no retry)
    expect(result.choices[0].message.content).toBe('');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat tool_calls with empty content as empty (valid)', async () => {
    const km = createSeekAIKeyManager(['k1', 'k2']);
    const provider = new SeekAIProvider(km, BASE_URL, 10000);
    const toolCall = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: {} };
    const requestMock = vi.fn().mockResolvedValue({ data: toolCall });
    (provider as any).client = { request: requestMock, post: vi.fn(), get: vi.fn() };

    const result = await provider.chatCompletion({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.choices[0].message.tool_calls.length).toBe(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('retries claude-opus stream on 502 from first key', async () => {
    const km = createSeekAIKeyManager(['k1', 'k2']);
    const provider = new SeekAIProvider(km, BASE_URL, 10000);
    const streamObj = new PassThrough();
    let call = 0;
    (provider as any).client = {
      request: vi.fn(),
      get: vi.fn(),
      post: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) return Promise.reject({ response: { status: 502, data: {} }, message: 'bad gateway' });
        return Promise.resolve({ data: streamObj });
      }),
    };

    const p = provider.chatCompletionStream({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((r) => setImmediate(r));
    streamObj.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    streamObj.end();
    const result = await p;
    expect(result.stream).toBeDefined();
    expect(call).toBe(2);
  });
});

/* ===========================================================================
 * Regression tests — Fix #2: SeekAI timeout is raised to 120000ms and applied
 * consistently to normal + streaming requests, while other providers keep the
 * global timeout.
 * =========================================================================== */
describe('SeekAI timeout (Fix #2)', () => {
  it('config.seekaiTimeout defaults to 120000ms', async () => {
    const { config } = await import('../src/config');
    expect(config.seekaiTimeout).toBe(120000);
  });

  it('SeekAI timeout is independent from the global timeout', async () => {
    const { config } = await import('../src/config');
    /* The guarantee: SeekAI has its OWN timeout knob (SEEKAI_TIMEOUT, default
     * 120000) — it is never derived from the global TIMEOUT env. The raw
     * numeric values may coincide in some environments, so we assert the
     * dedicated knob exists with its documented default. */
    expect(config.seekaiTimeout).toBe(120000);
    expect(typeof config.timeout).toBe('number');
    expect(config.timeout).toBeGreaterThan(0);
  });

  it('streaming requests apply the SeekAI timeout (not timeout:0)', async () => {
    const km = createSeekAIKeyManager(['k1']);
    const provider = new SeekAIProvider(km, BASE_URL, 120000);
    const streamObj = new PassThrough();
    (provider as any).client = { request: vi.fn(), get: vi.fn(), post: vi.fn().mockResolvedValue({ data: streamObj }) };

    const p = provider.chatCompletionStream({ model: 'm', messages: [] });
    await new Promise((r) => setImmediate(r));
    streamObj.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    streamObj.end();
    await p;

    const cfg = (provider as any).client.post.mock.calls[0][2];
    expect(cfg.timeout).toBe(120000);
  });
});
