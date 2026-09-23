/* ============================================================================
 * Kie.ai runtime wiring — mock/contract tests (no network, no credentials).
 * Serial-safe: every test cleans the global registries it touches.
 * ========================================================================== */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import { registry } from '../src/providers/registry';
import { modelRegistry } from '../src/lib/model-registry';
import { providerRefreshCooldown } from '../src/lib/provider-refresh-cooldown';
import { discoveryStore } from '../src/lib/discovery';
import { KeyManager } from '../src/lib/key-manager';
import { runWithComboContext } from '../src/lib/combo-context';
import {
  clearProviderRoutes,
  hasRoutes,
  setRouteEnabled,
  getRoutesForProvider,
} from '../src/lib/provider-routes';
import { KIE_PROVIDER_ID, KIE_BASE_URL } from '../src/lib/kie-routes';
import { KieProvider, createKieKeyManager, __resetKieModelCache, KIE_MAX_ATTEMPTS, KIE_RETRY_DELAY_MS, isTransientKieError } from '../src/providers/kie';
import { ClineProvider } from '../src/providers/cline';
import { toResponsesTools, toResponsesToolChoice } from '../src/lib/adapters/openai-responses';

const BASE = 'https://api.kie.ai';

function makeProvider(keys = ['kie-test-key-1', 'kie-test-key-2', 'kie-test-key-3']): KieProvider {
  const km = createKieKeyManager(keys);
  return new KieProvider(km, BASE, 10000);
}

function stubClient(provider: KieProvider, client: any): void {
  (provider as any).client = client;
}

beforeEach(() => {
  registry.reset();
  modelRegistry.clear();
  providerRefreshCooldown.reset();
  discoveryStore.reset();
  clearProviderRoutes();
  __resetKieModelCache();
});

afterEach(() => {
  registry.reset();
  modelRegistry.clear();
  providerRefreshCooldown.reset();
  discoveryStore.reset();
  clearProviderRoutes();
  __resetKieModelCache();
  vi.restoreAllMocks();
});

function collectStream(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (d: any) => { out += d.toString(); });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

/* Shared hermetic helpers (no upstream, no credentials). */
function httpError(status: number, message: string): any {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { error: { message } } };
  return err;
}

function transportError(code: string, message: string): any {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

function codexOkBody(text = 'recovered'): any {
  return {
    id: 'resp_r', model: 'gpt-6-astra', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/* setTimeout delays (ms) scheduled while `fn` runs — verifies the fixed
 * KIE_RETRY_DELAY_MS deterministically under fake timers. */
function scheduledDelays(): { spy: any; delays: () => number[] } {
  const spy = vi.spyOn(globalThis, 'setTimeout');
  return { spy, delays: () => spy.mock.calls.map((c) => c[1] as number) };
}

describe('kie.ai provider registration', () => {
  it('registers providerId kie.ai with base https://api.kie.ai and three routes', () => {
    const provider = makeProvider();
    expect(provider.getProviderInfo()).toMatchObject({ providerId: 'kie.ai' });
    expect(provider.getBaseUrl()).toBe('https://api.kie.ai');
    registry.register(provider.getProviderInfo(), provider);
    expect(registry.getProviderById('kie.ai')).toBeDefined();
    expect(hasRoutes(KIE_PROVIDER_ID)).toBe(true);
    expect(getRoutesForProvider(KIE_PROVIDER_ID).map((r) => r.id).sort())
      .toEqual(['kie-claude', 'kie-codex', 'kie-gemini']);
    // Backward compat: existing providers have no explicit routes.
    expect(hasRoutes('nvidia')).toBe(false);
    expect(hasRoutes('openrouter')).toBe(false);
  });
});

describe('kie model -> route -> URL', () => {
  it('gemini model builds the streamGenerateContent URL with gemini body', () => {
    const provider = makeProvider();
    const call = provider.buildUpstreamCall(
      { model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'hi' }] },
      'gemini-3-8-flash',
    );
    expect(call.routeId).toBe('kie-gemini');
    expect(call.protocol).toBe('gemini');
    expect(call.url).toBe(`${KIE_BASE_URL}/gemini/v1/models/gemini-3-8-flash:streamGenerateContent`);
    expect(call.body.contents[0].parts[0]).toMatchObject({ text: 'hi' });
  });

  it('claude model builds the messages URL with anthropic body', () => {
    const provider = makeProvider();
    const call = provider.buildUpstreamCall(
      { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
      'claude-opus-5',
    );
    expect(call.routeId).toBe('kie-claude');
    expect(call.protocol).toBe('anthropic-messages');
    expect(call.url).toBe(`${KIE_BASE_URL}/claude/v1/messages`);
    expect(call.body.messages[0]).toMatchObject({ role: 'user' });
    expect(call.body.max_tokens).toBe(16);
  });

  it('codex model builds the responses URL verbatim with responses body', () => {
    const provider = makeProvider();
    const call = provider.buildUpstreamCall(
      { model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }] },
      'gpt-5-5',
    );
    expect(call.routeId).toBe('kie-codex');
    expect(call.protocol).toBe('openai-responses');
    expect(call.url).toBe(`${KIE_BASE_URL}/codex/v1/responses`);
    expect(call.body.model).toBe('gpt-5-5');
    expect(Array.isArray(call.body.input)).toBe(true);
  });

  it('codex non-stream request always sends an explicit stream:false (KIE defaults to SSE)', () => {
    const provider = makeProvider();
    const call = provider.buildUpstreamCall(
      { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] },
      'gpt-6-astra',
    );
    /* KIE's /codex/v1/responses returns an SSE body when `stream` is OMITTED,
     * which a non-streaming call cannot parse. It must be explicitly false. */
    expect(call.body.stream).toBe(false);

    const streamCall = provider.buildUpstreamCall(
      { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }], stream: true },
      'gpt-6-astra',
    );
    expect(streamCall.body.stream).toBe(true);
  });

  it('unknown model fails clearly without cross-provider fallback', () => {
    const provider = makeProvider();
    expect(() => provider.buildUpstreamCall({ model: 'llama-3-3-70b' }, 'llama-3-3-70b'))
      .toThrowError(/no enabled route/);
  });

  it('codex request flattens chat-format tools and drops tool_choice (KIE 500s on any value)', () => {
    const provider = makeProvider();
    const call = provider.buildUpstreamCall(
      {
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Get time', parameters: { type: 'object', properties: {} } } }],
        tool_choice: { type: 'function', function: { name: 'get_time' } },
      },
      'gpt-6-astra',
    );
    expect(call.body.tools).toEqual([
      { type: 'function', name: 'get_time', description: 'Get time', parameters: { type: 'object', properties: {} } },
    ]);
    // Verified live: /codex/v1/responses 500s on string "auto" AND object
    // tool_choice, while the identical request without the field is 200.
    expect('tool_choice' in call.body).toBe(false);

    // Already-flat tools still pass through untouched.
    const passthrough = provider.buildUpstreamCall(
      {
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'web_search' }],
      },
      'gpt-6-astra',
    );
    expect(passthrough.body.tools).toEqual([{ type: 'web_search' }]);
  });

  it('adapter tool converters keep Responses shape correct for other consumers', () => {
    expect(toResponsesTools([{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]))
      .toEqual([{ type: 'function', name: 'f', parameters: { type: 'object' } }]);
    expect(toResponsesTools('not-an-array')).toBe('not-an-array');
    expect(toResponsesToolChoice({ type: 'function', function: { name: 'f' } }))
      .toEqual({ type: 'function', name: 'f' });
    expect(toResponsesToolChoice('auto')).toBe('auto');
  });
});

describe('kie chatCompletion per protocol (mocked upstream)', () => {
  it('gemini response normalizes to chat completion with usage', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: {
          responseId: 'r1',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '4' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        },
      }),
    });
    const res = await provider.chatCompletion({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: '2+2?' }] });
    expect(res.choices[0].message.content).toBe('4');
    expect(res.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('claude response normalizes to chat completion', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: {
          id: 'msg_1', type: 'message', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 6, output_tokens: 2 },
        },
      }),
    });
    const res = await provider.chatCompletion({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
    expect(res.choices[0].message.content).toBe('Hello');
    expect(res.usage).toMatchObject({ prompt_tokens: 6, completion_tokens: 2 });
  });

  it('codex response normalizes to chat completion', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: {
          id: 'resp_1', model: 'gpt-5-5', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] }],
          usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
        },
      }),
    });
    const res = await provider.chatCompletion({ model: 'gpt-5-5', messages: [{ role: 'user', content: '2+2?' }] });
    expect(res.choices[0].message.content).toBe('4');
    expect(res.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 1 });
  });

  it('chatCompletionRaw returns the normalized chat JSON string', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: {
          id: 'resp_2', model: 'gpt-5-5', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
      }),
    });
    const raw = await provider.chatCompletionRaw({ model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(raw).choices[0].message.content).toBe('ok');
  });
});

describe('kie same-provider key rotation, no cross-provider fallback', () => {
  it('429 on key 1 cools it down; the next request rotates to key 2 within kie.ai only', async () => {
    const provider = makeProvider(['kie-k1', 'kie-k2', 'kie-k3']);
    const calls: string[] = [];
    const okBody = {
      id: 'resp_x', model: 'gpt-5-5', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    };
    const post = vi.fn().mockImplementation((_url: string, _body: any, cfg: any) => {
      const auth = cfg?.headers?.Authorization ?? '';
      calls.push(auth);
      if (auth.includes('kie-k1')) {
        return Promise.reject({ response: { status: 429, data: { error: { message: 'Rate limit exceeded' } } } });
      }
      return Promise.resolve({ data: okBody });
    });
    stubClient(provider, { post });
    const payload = { model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }] };
    // Request 1 hits key 1 -> 429 -> key 1 cools down (single-attempt pattern,
    // same as other providers; rotation continues on the next request).
    await expect(provider.chatCompletion(payload)).rejects.toMatchObject({ status: 429 });
    // Request 2 skips the cooling key and succeeds on key 2 — still kie.ai.
    const res = await provider.chatCompletion(payload);
    expect(res.choices[0].message.content).toBe('done');
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('kie-k1');
    expect(calls[1]).toContain('kie-k2');
    expect(calls.every((c) => c.startsWith('Bearer kie-k'))).toBe(true);
  });

  it('upstream errors keep status, prefix provider, and never leak the raw key', async () => {
    const provider = makeProvider(['kie-secret-key']);
    stubClient(provider, {
      post: vi.fn().mockRejectedValue({ response: { status: 401, data: { error: { message: 'Unauthorized' } } } }),
    });
    const err = await provider.chatCompletion({ model: 'gpt-5-5', messages: [] }).catch((e: any) => e);
    expect(err.status).toBe(401);
    expect(String(err.message)).toContain('Kie.ai');
    expect(String(err.message)).not.toContain('kie-secret-key');
    expect(JSON.stringify(err)).not.toContain('kie-secret-key');
  });
});

/* ============================================================================
 * kie transient retry policy — FIXED contract (measured 2026-09-13):
 *   MAX 3 TOTAL attempts per request, fixed 1500ms delay between attempts,
 *   SAME key for every attempt, retry ONLY transient errors (500/502/503,
 *   timeout, network). Every 4xx fails fast on attempt 1.
 * Serial + hermetic: stubbed client (no upstream), fake timers so the 1500ms
 * delay is verified deterministically without slow tests.
 * ========================================================================== */
describe('kie transient retry policy (3 attempts / 1500ms / same key)', () => {
  const okBody = codexOkBody();
  const payload = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('exports the fixed policy constants (3 attempts total, 1500ms delay)', () => {
    expect(KIE_MAX_ATTEMPTS).toBe(3);
    expect(KIE_RETRY_DELAY_MS).toBe(1500);
  });

  it('classifies transient vs permanent errors without touching upstream', () => {
    expect(isTransientKieError(httpError(500, 'Server exception'))).toBe(true);
    expect(isTransientKieError(httpError(502, 'bad gateway'))).toBe(true);
    expect(isTransientKieError(httpError(503, 'maintenance'))).toBe(true);
    expect(isTransientKieError(httpError(504, 'gateway timeout'))).toBe(true);
    expect(isTransientKieError(transportError('ECONNABORTED', 'timeout of 10000ms exceeded'))).toBe(true);
    expect(isTransientKieError(transportError('ECONNRESET', 'socket hang up'))).toBe(true);
    expect(isTransientKieError(transportError('', 'Network Error'))).toBe(true);
    expect(isTransientKieError(httpError(400, 'bad request'))).toBe(false);
    expect(isTransientKieError(httpError(401, 'unauthorized'))).toBe(false);
    expect(isTransientKieError(httpError(403, 'forbidden'))).toBe(false);
    expect(isTransientKieError(httpError(404, 'not found'))).toBe(false);
    expect(isTransientKieError(httpError(409, 'conflict'))).toBe(false);
    expect(isTransientKieError(httpError(422, 'validation failed'))).toBe(false);
    expect(isTransientKieError(httpError(429, 'rate limit'))).toBe(false);
    // A 400 whose text merely mentions timeout must still fail fast.
    expect(isTransientKieError(httpError(400, 'request timeout: bad input'))).toBe(false);
  });

  it('1. 500 attempt-1 -> 1500ms delay -> 200 attempt-2', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(500, 'Server exception, please try again later'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const t = scheduledDelays();
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
    expect(t.delays()).toEqual([1500]);
    t.spy.mockRestore();
  });

  it('2. 500 -> 500 -> 200 uses 3 attempts with 1500ms between each', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(500, 'boom 1'))
      .mockRejectedValueOnce(httpError(500, 'boom 2'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const t = scheduledDelays();
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(3);
    expect(t.delays()).toEqual([1500, 1500]);
    t.spy.mockRestore();
  });

  it('3. 500 -> 500 -> 500 stops at exactly 3 attempts, final error stays 500', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn().mockRejectedValue(httpError(500, 'always down'));
    stubClient(provider, { post });
    const t = scheduledDelays();
    // Attach the settlement handler immediately so the rejection is never
    // unhandled while fake timers are advanced below.
    const settled = provider.chatCompletion(payload).then(
      (value) => ({ ok: true as const, value }),
      (error: any) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(500);
    expect(post).toHaveBeenCalledTimes(3);
    expect(t.delays()).toEqual([1500, 1500]);
    // No 4th attempt no matter how much longer we wait.
    await vi.advanceTimersByTimeAsync(10000);
    expect(post).toHaveBeenCalledTimes(3);
    t.spy.mockRestore();
  });

  it('4. 502 -> 200 retries', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(502, 'bad gateway'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('5. 503 -> 200 retries', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(503, 'maintenance'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('6. timeout (no HTTP status) -> 200 retries', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(transportError('ECONNABORTED', 'timeout of 10000ms exceeded'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('7. network error (no HTTP status) -> 200 retries', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn()
      .mockRejectedValueOnce(transportError('ECONNRESET', 'socket hang up'))
      .mockResolvedValueOnce({ data: okBody });
    stubClient(provider, { post });
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('8-12. HTTP %i fails fast with exactly 1 attempt', async (status) => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn().mockRejectedValue(httpError(status, 'client problem'));
    stubClient(provider, { post });
    const err = await provider.chatCompletion(payload).catch((e: any) => e);
    expect(err.status).toBe(status);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('13. 200 on attempt-1 performs exactly 1 attempt with no delay', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn().mockResolvedValue({ data: okBody });
    stubClient(provider, { post });
    const t = scheduledDelays();
    const res = await provider.chatCompletion(payload);
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(1);
    expect(t.delays()).toEqual([]);
    t.spy.mockRestore();
  });

  it('14. retries reuse the SAME Kie.ai key (no mid-retry rotation)', async () => {
    const provider = makeProvider(['kie-kA', 'kie-kB']);
    const km = provider.getKeyManager();
    const nextSpy = vi.spyOn(km, 'getNextKey');
    const auths: string[] = [];
    const post = vi.fn().mockImplementation((_url: string, _body: any, cfg: any) => {
      auths.push(cfg?.headers?.Authorization ?? '');
      if (auths.length === 1) return Promise.reject(httpError(500, 'flaky'));
      return Promise.resolve({ data: okBody });
    });
    stubClient(provider, { post });
    const pending = provider.chatCompletion(payload);
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('recovered');
    expect(post).toHaveBeenCalledTimes(2);
    // Key rotation queried once; both attempts carry the identical key.
    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(auths).toEqual(['Bearer kie-kA', 'Bearer kie-kA']);
  });

  it('15. other providers are untouched by the Kie.ai retry (cline 500 = 1 attempt)', async () => {
    const km = new KeyManager(['cline-k1'], 'Cline-test');
    const cline = new ClineProvider(km, 'https://api.cline.bot/api/v1', 10000);
    // Cline posts via client.request (not client.post) and rotates keys on
    // retryable errors — with a single key that means exactly 1 upstream call.
    const request = vi.fn().mockRejectedValue(httpError(500, 'cline down'));
    (cline as any).client = { request };
    const err = await cline.chatCompletion({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }).catch((e: any) => e);
    expect(err.status).toBe(500);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('17. exhausted retries never leak the raw key in the final error', async () => {
    const provider = makeProvider(['kie-secret-key']);
    const post = vi.fn().mockRejectedValue(httpError(500, 'down'));
    stubClient(provider, { post });
    const t = scheduledDelays();
    // Settlement handler attached immediately: the rejection is never
    // unhandled while fake timers are advanced below.
    const settled = provider.chatCompletion(payload).then(
      (value) => ({ ok: true as const, value }),
      (error: any) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(500);
      expect(String(result.error.message)).not.toContain('kie-secret-key');
      expect(JSON.stringify(result.error)).not.toContain('kie-secret-key');
    }
    t.spy.mockRestore();
  });

  it('does NOT retry a 429 quota error (cooldown path owns it)', async () => {
    const provider = makeProvider(['kie-solo-key']);
    const post = vi.fn().mockRejectedValue({ response: { status: 429, data: { error: { message: 'rate limit' } } } });
    stubClient(provider, { post });
    const err = await provider.chatCompletion(payload).catch((e: any) => e);
    expect(err.status).toBe(429);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('gemini route shares the same transient policy (500 -> 200)', async () => {
    const provider = makeProvider(['kie-k1']);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(500, 'flaky'))
      .mockResolvedValueOnce({
        data: {
          responseId: 'r9',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '9' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      });
    stubClient(provider, { post });
    const pending = provider.chatCompletion({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'hi' }] });
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.choices[0].message.content).toBe('9');
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('kie streaming transcode (mocked SSE)', () => {
  it('codex SSE becomes openai chat SSE ending with [DONE]', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: Readable.from([
          'event: response.output_text.delta\ndata: {"delta":"hel"}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"lo"}\n\n',
          'event: response.completed\ndata: {"response":{}}\n\n',
        ]),
      }),
    });
    const { stream } = await provider.chatCompletionStream({ model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }] });
    const out = await collectStream(stream);
    expect(out).toContain('chat.completion.chunk');
    expect(out).toContain('hel');
    expect(out).toContain('data: [DONE]');
  });

  it('gemini SSE becomes openai chat SSE ending with [DONE]', async () => {
    const provider = makeProvider(['kie-k1']);
    const chunk = JSON.stringify({ responseId: 'g1', candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({ data: Readable.from([`data: ${chunk}\n\n`]) }),
    });
    const { stream } = await provider.chatCompletionStream({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'hi' }] });
    const out = await collectStream(stream);
    expect(out).toContain('chat.completion.chunk');
    expect(out).toContain('hi');
    expect(out).toContain('data: [DONE]');
  });

  it('claude SSE becomes openai chat SSE ending with [DONE]', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      post: vi.fn().mockResolvedValue({
        data: Readable.from([
          'event: message_start\ndata: {"type":"message_start"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hey"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      }),
    });
    const { stream } = await provider.chatCompletionStream({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
    const out = await collectStream(stream);
    expect(out).toContain('hey');
    expect(out).toContain('data: [DONE]');
  });
});

describe('kie-codex buffered stream fallback (mocked, fake timers)', () => {
  /* KIE's /codex/v1/responses answers HTTP 500 to `stream: true` while
   * non-streaming works. Establishment shares the fixed retry policy first
   * (max 3 attempts, 1500ms); only then does chatCompletionStream replay a
   * buffered completion as SSE for kie-codex ONLY — never for 4xx, never for
   * gemini/claude routes. */
  const responsesBody = {
    id: 'resp_fallback_1',
    status: 'completed',
    model: 'gpt-6-astra',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'buffered OK' }] }],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  };
  function stream500(): any {
    const err: any = new Error('Request failed with status code 500');
    err.response = { status: 500, data: { error: { message: 'internal' } } };
    return err;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('16a. stream establishment 500 -> 1500ms -> 200 SSE (no fallback involved)', async () => {
    const provider = makeProvider(['kie-k1']);
    const post = vi.fn()
      .mockRejectedValueOnce(stream500())
      .mockResolvedValueOnce({
        data: Readable.from([
          'event: response.output_text.delta\ndata: {"delta":"hel"}\n\n',
          'event: response.completed\ndata: {"response":{}}\n\n',
        ]),
      });
    stubClient(provider, { post });
    const t = scheduledDelays();
    const pending = provider.chatCompletionStream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] });
    await vi.advanceTimersByTimeAsync(1500);
    const { stream } = await pending;
    const out = await collectStream(stream);
    expect(post).toHaveBeenCalledTimes(2);
    expect(t.delays()).toEqual([1500]);
    expect(out).toContain('chat.completion.chunk');
    expect(out).toContain('hel');
    expect(out).toContain('data: [DONE]');
    t.spy.mockRestore();
  });

  it('16b. no retry after the stream started (mid-stream failure = 1 upstream call)', async () => {
    const provider = makeProvider(['kie-k1']);
    const src = new Readable({ read() { /* pushed manually below */ } });
    const post = vi.fn().mockResolvedValue({ data: src });
    stubClient(provider, { post });
    const { stream } = await provider.chatCompletionStream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] });
    const chunks: string[] = [];
    stream.on('data', (d: any) => chunks.push(d.toString()));
    src.push('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n');
    await new Promise((resolve) => process.nextTick(resolve));
    // Swallow the source error locally (no provider retry path observes it);
    // the point is the provider never issues another upstream call for it.
    src.on('error', () => { /* intentionally swallowed for the assertion below */ });
    src.destroy(new Error('socket hang up'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(chunks.join('')).toContain('hi');
  });

  it('codex stream 500 x3 exhausts establishment, then replays buffered SSE', async () => {
    const provider = makeProvider(['kie-k1']);
    const post = vi.fn()
      .mockRejectedValueOnce(stream500())
      .mockRejectedValueOnce(stream500())
      .mockRejectedValueOnce(stream500())
      .mockResolvedValueOnce({ data: responsesBody });
    stubClient(provider, { post });
    const t = scheduledDelays();
    const pending = provider.chatCompletionStream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const { stream } = await pending;
    const out = await collectStream(stream);
    // 3 establishment attempts + 1 distinct non-streaming fallback request.
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[3][1].stream).toBe(false);
    expect(t.delays()).toEqual([1500, 1500]);
    expect(out).toContain('chat.completion.chunk');
    expect(out).toContain('buffered OK');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":10');
    expect(out).toContain('data: [DONE]');
    t.spy.mockRestore();
  });

  it('codex stream 500 x3 + failed fallback surfaces the fallback error', async () => {
    const provider = makeProvider(['kie-k1']);
    const err401: any = new Error('Request failed with status code 401');
    err401.response = { status: 401, data: { error: { message: 'bad key' } } };
    const post = vi.fn()
      .mockRejectedValueOnce(stream500())
      .mockRejectedValueOnce(stream500())
      .mockRejectedValueOnce(stream500())
      .mockRejectedValueOnce(err401);
    stubClient(provider, { post });
    const settled = provider.chatCompletionStream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] }).then(
      (value) => ({ ok: true as const, value }),
      (error: any) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(post).toHaveBeenCalledTimes(4);
      expect(result.error.status).toBe(401);
      expect(String(result.error.message)).toContain('Kie.ai');
    }
  });

  it('codex stream 401 does NOT fall back (auth errors stay visible)', async () => {
    const provider = makeProvider(['kie-k1']);
    const err401: any = new Error('Request failed with status code 401');
    err401.response = { status: 401, data: { error: { message: 'bad key' } } };
    const post = vi.fn().mockRejectedValue(err401);
    stubClient(provider, { post });
    const err = await provider.chatCompletionStream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] }).catch((e: any) => e);
    expect(post).toHaveBeenCalledTimes(1);
    expect(err.status).toBe(401);
  });

  it('gemini stream 500 retries establishment (max 3) but never falls back (codex-only)', async () => {
    const provider = makeProvider(['kie-k1']);
    const post = vi.fn().mockRejectedValue(stream500());
    stubClient(provider, { post });
    const settled = provider.chatCompletionStream({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'hi' }] }).then(
      (value) => ({ ok: true as const, value }),
      (error: any) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(500);
    expect(post).toHaveBeenCalledTimes(3);
  });
});

describe('kie listModels + health (mocked)', () => {
  it('merges codex discovery with static gemini/claude catalog incl. route metadata', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      get: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { data: [{ id: 'gpt-5-5' }] } }),
    });
    const list = await provider.listModels();
    const byId = new Map(list.data.map((m: any) => [m.id, m]));
    expect(byId.get('gpt-5-5')).toMatchObject({ routeId: 'kie-codex' });
    expect(byId.get('gemini-3-8-flash')).toMatchObject({ routeId: 'kie-gemini', protocol: 'gemini' });
    expect(byId.get('claude-opus-5')).toMatchObject({ routeId: 'kie-claude', protocol: 'anthropic-messages' });
  });

  it('falls back to the static catalog when discovery fails', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, { get: vi.fn().mockRejectedValue(new Error('down')) });
    const list = await provider.listModels();
    expect(list.source).toBe('fallback');
    expect(list.data.length).toBeGreaterThan(10);
  });

  it('healthCheck reports per-route status without raw keys', async () => {
    const provider = makeProvider(['kie-k1']);
    stubClient(provider, {
      get: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { data: [{ id: 'gpt-5-5' }] } }),
    });
    const health = await provider.healthCheck();
    expect(health.provider).toBe('kie.ai');
    expect(health.baseUrl).toBe('https://api.kie.ai');
    const ids = health.routes.map((r: any) => r.id).sort();
    expect(ids).toEqual(['kie-claude', 'kie-codex', 'kie-gemini']);
    expect(health.routes.find((r: any) => r.id === 'kie-codex').checked).toBe('live');
    expect(JSON.stringify(health)).not.toContain('kie-k1');
  });
});

describe('kie combo route pin', () => {
  function comboCtx(routeId: string | null) {
    return {
      comboId: 'combo_1',
      providerId: 'kie.ai',
      model: 'claude-opus-5',
      routeId,
      providerKeyId: null,
      providerRawKey: null,
    };
  }

  it('explicit kie-claude pin is honored, never rewritten', () => {
    const provider = makeProvider();
    const resolved = runWithComboContext(
      () => provider.resolveRouteFor('claude-opus-5'),
      comboCtx('kie-claude'),
    );
    expect(resolved.route.id).toBe('kie-claude');
  });

  it('pinned route that does not serve the model fails clearly', () => {
    const provider = makeProvider();
    expect(() => runWithComboContext(
      () => provider.resolveRouteFor('claude-opus-5'),
      comboCtx('kie-gemini'),
    )).toThrowError(/does not serve model/);
  });

  it('disabled pinned route fails clearly', () => {
    const provider = makeProvider();
    setRouteEnabled('kie.ai', 'kie-claude', false);
    expect(() => runWithComboContext(
      () => provider.resolveRouteFor('claude-opus-5'),
      comboCtx('kie-claude'),
    )).toThrowError(/disabled/);
  });

  it('legacy combo without routeId uses normal model resolution', () => {
    const provider = makeProvider();
    const resolved = runWithComboContext(
      () => provider.resolveRouteFor('gemini-3-8-flash'),
      comboCtx(null),
    );
    expect(resolved.route.id).toBe('kie-gemini');
  });
});

describe('kie provider interface compliance', () => {
  it('rejects missing model and unsupported embeddings like other providers', async () => {
    const provider = makeProvider(['kie-k1']);
    await expect(provider.chatCompletion({})).rejects.toMatchObject({ status: 400 });
    await expect(provider.createEmbedding({})).rejects.toMatchObject({ status: 400 });
  });

  it('exposes a KeyManager bound to kie.ai keys only', async () => {
    const km = new KeyManager(['kie-only-1', 'kie-only-2'], 'Kie.ai-test');
    const provider = new KieProvider(km, BASE, 10000);
    const k = await provider.getKeyManager().getNextKey();
    expect(k.key.startsWith('kie-only-')).toBe(true);
  });
});
