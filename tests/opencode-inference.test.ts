/* ============================================================================
 * OpenCode Inference provider (opencode-inference) — serial contract tests.
 *
 * READ-ONLY with respect to upstreams: every request goes to a LOCAL mock HTTP
 * server. No OpenCode production endpoint is contacted, no Zen key is used.
 * ========================================================================== */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { InferenceProvider } from '../src/providers/inference';
import { registry } from '../src/providers/registry';
import { modelRegistry } from '../src/lib/model-registry';
import { providerRefreshCooldown } from '../src/lib/provider-refresh-cooldown';
import { runWithInferenceSession, extractInferenceSessionId } from '../src/lib/inference-session';
import { getEndpointForProvider, getBaseUrlForProvider } from '../src/services/provider';
import { config } from '../src/config';

/* ----------------------------- Mock upstream ----------------------------- */
let seenAuthHeaders: Array<string | string[] | undefined> = [];
let seenPaths: string[] = [];
let lastRequestBody: any = null;
/* Every inbound upstream header set, so privacy tests can assert what was NOT
 * forwarded. */
let seenHeaders: http.IncomingHttpHeaders[] = [];

const mock = http.createServer((req, res) => {
  seenAuthHeaders.push(req.headers['authorization']);
  seenPaths.push(req.url || '');
  seenHeaders.push({ ...req.headers });

  if (req.url?.startsWith('/missing')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
    return;
  }

  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'big-pickle', object: 'model' },
        { id: 'mimo-v2.5-free', object: 'model' },
        { id: 'nemotron-3-super-free', object: 'model' },
      ],
    }));
    return;
  }

  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = body; }
      const model = lastRequestBody?.model ?? 'mock';
      if (lastRequestBody?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-inference-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'INFERENCE_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const { port } = mock.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

beforeEach(() => {
  seenAuthHeaders = [];
  seenPaths = [];
  seenHeaders = [];
  lastRequestBody = null;
});

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (c: Buffer) => { out += c.toString(); });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

/* ------------------------------- Provider -------------------------------- */
describe('opencode-inference provider', () => {
  it('exposes the correct provider identity and base URL', () => {
    const p = new InferenceProvider(baseUrl, 5000);
    expect(p.getProviderInfo()).toEqual({
      providerId: 'opencode-inference',
      providerName: 'OpenCode Inference',
    });
    expect(p.getBaseUrl()).toBe(baseUrl);
  });

  it('has NO KeyManager (free inference never touches Zen/other credentials)', () => {
    const p = new InferenceProvider(baseUrl, 5000) as any;
    expect(typeof p.getKeyManager).toBe('undefined');
    expect(p.keyManager).toBeUndefined();
  });

  it('sends NO Authorization header on chat completions', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const res = await p.chatCompletion({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.choices[0].message.content).toBe('INFERENCE_OK');
    expect(seenPaths[0]).toContain('/chat/completions');
    for (const auth of seenAuthHeaders) expect(auth).toBeUndefined();
  });

  it('A: forwards the incoming x-opencode-session value unchanged', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    /* The route extracts the header, binds it to the request context, and the
     * provider reads that context when building outbound headers. */
    expect(extractInferenceSessionId({ 'x-opencode-session': 'ses_test_123' })).toBe('ses_test_123');

    await runWithInferenceSession(
      () => p.chatCompletion({ model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'hi' }] }),
      extractInferenceSessionId({ 'x-opencode-session': 'ses_test_123' }),
    );

    expect(seenHeaders[0]?.['x-opencode-session']).toBe('ses_test_123');
  });

  it('A2: omits x-opencode-session when the request supplied none (never generated)', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    await p.chatCompletion({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] });
    expect(seenHeaders[0]?.['x-opencode-session']).toBeUndefined();
  });

  it('C: never forwards sensitive incoming headers', async () => {
    const p = new InferenceProvider(baseUrl, 5000);

    /* Simulate a hostile incoming header bag. Only the session header may be
     * extracted; every sensitive header must be ignored. */
    const incoming: Record<string, any> = {
      'x-opencode-session': 'ses_sensitive_999',
      'authorization': 'Bearer should-never-forward',
      'cookie': 'session=should-never-forward',
      'host': 'evil.example.com',
      'content-length': '12345',
      'x-api-key': 'should-never-forward',
      'x-opencode-api-key': 'should-never-forward',
      'x-org-id': 'should-never-forward',
    };
    const sessionId = extractInferenceSessionId(incoming);
    expect(sessionId).toBe('ses_sensitive_999');

    await runWithInferenceSession(
      () => p.chatCompletion({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      sessionId,
    );

    const out = seenHeaders[0] ?? {};
    expect(out['x-opencode-session']).toBe('ses_sensitive_999');
    expect(out['authorization']).toBeUndefined();
    expect(out['cookie']).toBeUndefined();
    expect(out['x-api-key']).toBeUndefined();
    expect(out['x-opencode-api-key']).toBeUndefined();
    expect(out['x-org-id']).toBeUndefined();
    /* The provider sets its own Host/Content-Length via the HTTP client, so the
     * client-supplied values (host=evil.example.com) are never forwarded. */
    expect(out['host']).not.toBe('evil.example.com');
  });

  it('H: never logs the session id plaintext', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runWithInferenceSession(
        () => p.chatCompletion({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
        'ses_log_secret_777',
      );
    } finally {
      logSpy.mockRestore();
    }
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('ses_log_secret_777');
  });

  it('preserves the OpenAI-compatible payload shape and usage', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const res = await p.chatCompletion({ model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'ping' }], temperature: 0.2 });
    expect(lastRequestBody.model).toBe('mimo-v2.5-free');
    expect(lastRequestBody.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(lastRequestBody.temperature).toBe(0.2);
    expect(res.usage).toEqual({ prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
  });

  it('surfaces the OpenAI-compatible SSE stream from chatCompletionStream', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const { stream, keyIndex, tag } = await p.chatCompletionStream({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] });
    const text = await readStream(stream);
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"content":"hello"');
    expect(keyIndex).toBe(-1);
    expect(tag).toBe('opencode-inference');
    for (const auth of seenAuthHeaders) expect(auth).toBeUndefined();
  });

  it('discovers models via GET /models without Authorization', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const list = await p.listModels();
    const ids = list.data.map((m: any) => m.id);
    expect(ids).toContain('big-pickle');
    expect(ids).toContain('mimo-v2.5-free');
    expect(ids).toContain('nemotron-3-super-free');
    for (const auth of seenAuthHeaders) expect(auth).toBeUndefined();
  });

  it('healthCheck uses GET /models and never performs inference', async () => {
    const p = new InferenceProvider(baseUrl, 5000);
    const health = await p.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe('opencode-inference');
    expect(seenPaths.some((u) => u.includes('/models'))).toBe(true);
    expect(seenPaths.some((u) => u.includes('/chat/completions'))).toBe(false);
  });

  it('maps upstream errors into a single client-safe error shape', async () => {
    const p = new InferenceProvider(`${baseUrl}/missing`, 5000);
    await expect(p.chatCompletion({ model: 'big-pickle', messages: [] })).rejects.toMatchObject({
      status: 404,
    });
  });
});

/* --------------------------- Registry / routing -------------------------- */
describe('opencode-inference registry isolation', () => {
  it('registers as its own provider without a KeyManager', () => {
    registry.reset();
    modelRegistry.clear();
    providerRefreshCooldown.reset();

    const p = new InferenceProvider(baseUrl, 5000);
    registry.register(p.getProviderInfo(), p);
    const rp = registry.getProviderById('opencode-inference');
    expect(rp?.identity.providerId).toBe('opencode-inference');
  });

  it('bare Zen free ids stay on Zen; Inference is reachable via its prefix', () => {
    registry.reset();
    modelRegistry.clear();

    // Zen owns the bare ids.
    modelRegistry.registerModel('big-pickle', 'zen', 60);
    modelRegistry.registerModel('mimo-v2.5-free', 'zen', 60);
    // Inference registers the same ids under its own provider.
    modelRegistry.registerModel('big-pickle', 'opencode-inference', 100);
    modelRegistry.registerModel('mimo-v2.5-free', 'opencode-inference', 100);

    // Bare id resolves to Zen first (spec: prefix-only, preserve Zen).
    const bare = modelRegistry.getProvidersForModel('big-pickle');
    expect(bare[0]?.providerId).toBe('zen');

    // Explicit prefix resolves the inference registration.
    expect(modelRegistry.hasModel('big-pickle', 'opencode-inference')).toBe(true);
    expect(modelRegistry.hasModel('mimo-v2.5-free', 'opencode-inference')).toBe(true);
    expect(modelRegistry.getBackendModel('big-pickle', 'opencode-inference')).toBeUndefined();
  });

  it('an inference-only model resolves exclusively to opencode-inference', () => {
    registry.reset();
    modelRegistry.clear();

    modelRegistry.registerModel('nemotron-3-super-free', 'opencode-inference', 100);
    const providers = modelRegistry.getProvidersForModel('nemotron-3-super-free');
    expect(providers.map((p) => p.providerId)).toEqual(['opencode-inference']);
  });

  it('has no cross-provider fallback (single locked provider per model)', () => {
    registry.reset();
    modelRegistry.clear();

    modelRegistry.registerModel('big-pickle', 'zen', 60);
    modelRegistry.registerModel('big-pickle', 'opencode-inference', 100);

    const providers = modelRegistry.getProvidersForModel('big-pickle');
    // Registry returns both, but routing locks to the first (Zen) — verified by
    // the service's strict-lock branch. Here we assert ordering is deterministic.
    expect(providers[0].providerId).toBe('zen');
    expect(providers[1].providerId).toBe('opencode-inference');
  });
});

/* --------------------- Session context isolation / routing ----------------- */
describe('opencode-inference session isolation', () => {
  it('D: the provider has no KeyManager and never resolves one', () => {
    const p = new InferenceProvider(baseUrl, 5000) as any;
    /* No getKeyManager method and no keyManager field — there is nothing to
     * call, so Zen/other credentials can never be reached. */
    expect(typeof p.getKeyManager).toBe('undefined');
    expect(p.keyManager).toBeUndefined();
    expect(p.client).toBeDefined(); // axios instance only
  });

  it('D2: extracting the session never touches credentials', () => {
    const headers = { 'x-opencode-session': 'ses_abc', 'authorization': 'Bearer zen-key-xyz' };
    expect(extractInferenceSessionId(headers)).toBe('ses_abc');
    expect(extractInferenceSessionId({})).toBeNull();
    expect(extractInferenceSessionId(undefined)).toBeNull();
    expect(extractInferenceSessionId({ 'x-opencode-session': '   ' })).toBeNull();
    expect(extractInferenceSessionId({ 'x-opencode-session': 'x'.repeat(300) })).toBeNull();
  });

  it('E: prefix resolution keeps bare ids on Zen and only namespaced ids on Inference', () => {
    registry.reset();
    modelRegistry.clear();

    modelRegistry.registerModel('big-pickle', 'zen', 60);
    modelRegistry.registerModel('mimo-v2.5-free', 'zen', 60);
    modelRegistry.registerModel('big-pickle', 'opencode-inference', 100);
    modelRegistry.registerModel('mimo-v2.5-free', 'opencode-inference', 100);
    modelRegistry.registerModel('nemotron-3-super-free', 'opencode-inference', 100);

    // Backward compatibility: bare ids stay Zen.
    expect(modelRegistry.getProvidersForModel('big-pickle')[0]?.providerId).toBe('zen');
    expect(modelRegistry.getProvidersForModel('mimo-v2.5-free')[0]?.providerId).toBe('zen');

    // Inference-only model resolves only to inference.
    const nemotron = modelRegistry.getProvidersForModel('nemotron-3-super-free');
    expect(nemotron.map((r) => r.providerId)).toEqual(['opencode-inference']);

    // Explicit prefix selectors resolve the inference registration for every model.
    for (const id of ['big-pickle', 'mimo-v2.5-free', 'nemotron-3-super-free']) {
      expect(modelRegistry.hasModel(id, 'opencode-inference')).toBe(true);
    }
  });

  it('F: endpoint/base URL locking — inference is its own endpoint, distinct from Zen', () => {
    registry.reset();
    modelRegistry.clear();

    const inference = new InferenceProvider(baseUrl, 5000);
    registry.register(inference.getProviderInfo(), inference);
    const rp = registry.getProviderById('opencode-inference')!;
    /* The service maps this provider to its OWN configured base URL — never to
     * the Zen endpoint. */
    expect(getBaseUrlForProvider(rp)).toBe(config.inferenceBaseUrl);
    expect(getBaseUrlForProvider(rp)).not.toBe(config.zenBaseUrl);
    expect(getBaseUrlForProvider(rp)).toContain('/inference/openai/v1');
    expect(getEndpointForProvider(rp)).toBe(
      config.inferenceBaseUrl.replace(/\/+$/, '') + '/chat/completions',
    );
    expect(getEndpointForProvider(rp)).not.toContain('/zen/');
  });

  it('G: no Combo record references opencode-inference automatically', async () => {
    const { listCombos } = await import('../src/lib/combo-store');
    const combos = listCombos();
    const mentions = combos.filter((c: any) => String(c.providerId) === 'opencode-inference');
    expect(mentions).toEqual([]);
  });
});
