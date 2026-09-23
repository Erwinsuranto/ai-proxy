/* ============================================================================
 * Provider leak protection — E2E through the REAL request path with a MOCK
 * upstream (no production credentials).
 *
 * Proves that a client can NEVER learn which internal provider serves a
 * model through ANY /v1 surface:
 *
 *   1. Normal JSON responses: no provider name/id, no upstream URL/host,
 *      internal envelope keys stripped, `model` normalized to the
 *      client-requested id (not the backend model).
 *   2. Response headers: gateway-controlled set only — no upstream headers
 *      (server / x-powered-by / x-upstream-*) are forwarded.
 *   3. Error responses: upstream error bodies (with provider name, URL,
 *      path) never forwarded — generic [OI]-compatible envelope, status kept.
 *   4. Non-JSON upstream bodies (WAF pages) → generic 502, nothing echoed.
 *   5. Streaming: SSE chunks scrubbed (internal keys stripped, model
 *      normalized), mid-stream error events genericized.
 *   6. /v1/models: only whitelisted fields, gateway-owned `owned_by`.
 *   7. Client API key mapping: provider binding not probeable (prefix forms
 *      behave identically), /v1/models filtered to allowed models only.
 *   8. Provider-locked routing + multi-key rotation still intact; no
 *      cross-provider fallback.
 * ========================================================================== */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, request, streamRequest, configFile } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const CLIENT_KEYS_FILE = configFile('client-api-keys.json');

const CLIENT_MODEL = 'secretive-model';           // client-facing registry name
const BACKEND_MODEL = 'internal/upstream-real-model'; // what the mock upstream receives
const OTHER_PROVIDER_MODEL = 'other-provider-only-model';

const LEAK_STRINGS = [
  'SecretProvider', 'secretprovider',                 // provider name/id
  'upstream-secret.example.com', 'upstream-secret',  // upstream host
  'internal/upstream-real-model',                    // backend model mapping
];

/* --------------------------- Mock upstream -------------------------------- */
/* Emulates a leaky upstream: attaches provider metadata, echoes upstream
 * URLs in errors, sends WAF HTML bodies and leaky SSE error events. */
let mockChatBehavior: 'ok' | 'upstream-error' | 'waf-html' | 'leaky-metadata' = 'ok';
let mockStreamError = false;
const receivedAuth: string[] = [];

const MOCK = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'x-upstream-node': 'secret-provider-node-1',
      Server: 'upstream-secret/1.0',
    });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: BACKEND_MODEL, object: 'model', owned_by: 'SecretProvider' }],
    }));
    return;
  }

  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      receivedAuth.push((req.headers['authorization'] || '').toString());

      /* Streaming path */
      let isStreamReq = false;
      try { isStreamReq = JSON.parse(body).stream === true; } catch { isStreamReq = false; }
      if (isStreamReq) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mockStreamError) {
          res.write(`data: ${JSON.stringify({ error: { message: 'SecretProvider API request failed at https://upstream-secret.example.com/v1/chat/completions (internal path /secret/path)', code: 502 } })}\n\n`);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-str-1', object: 'chat.completion.chunk', created: 1,
          model: BACKEND_MODEL,
          provider: 'SecretProvider', upstream_url: 'https://upstream-secret.example.com/v1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-str-1', object: 'chat.completion.chunk', created: 1,
          model: BACKEND_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      /* Non-streaming behaviors */
      if (mockChatBehavior === 'upstream-error') {
        res.writeHead(502, {
          'Content-Type': 'application/json',
          Server: 'upstream-secret/1.0',
          'x-upstream-node': 'secret-provider-node-1',
        });
        res.end(JSON.stringify({
          error: {
            message: 'SecretProvider API request failed at https://upstream-secret.example.com/v1/chat/completions — internal trace /secret/path auth key sk-abcdef1234567890',
            provider: 'SecretProvider',
            stack: 'at SecretProvider.handle (upstream-secret.example.com:443)',
          },
        }));
        return;
      }
      if (mockChatBehavior === 'waf-html') {
        /* HTTP 200 with an HTML WAF body — the nastiest upstream failure:
         * no axios error, just garbage bytes. */
        res.writeHead(200, { 'Content-Type': 'text/html', Server: 'upstream-secret/1.0' });
        res.end('<html><body>Access denied — WAF challenge at upstream-secret.example.com/verify</body></html>');
        return;
      }
      if (mockChatBehavior === 'leaky-metadata') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Server: 'upstream-secret/1.0',
          'x-upstream-node': 'secret-provider-node-1',
          'X-Request-Id': 'upstream-req-123',
        });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: BACKEND_MODEL,
          provider: 'SecretProvider',
          providerId: 'secretprovider',
          upstream: 'https://upstream-secret.example.com/v1',
          upstreamUrl: 'https://upstream-secret.example.com/v1/chat/completions',
          baseUrl: 'https://upstream-secret.example.com/v1',
          backend: 'secret-backend-1',
          backendModel: BACKEND_MODEL,
          adapter: 'SecretAdapter',
          endpoint: 'https://upstream-secret.example.com/v1/chat/completions',
          credential: 'sk-abcdef1234567890',
          stack: 'at SecretProvider.handle',
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
        return;
      }
      /* default 'ok' */
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: BACKEND_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

beforeAll(async () => {
  await new Promise<void>(r => MOCK.listen(0, '127.0.0.1', r));
  mockPort = (MOCK.address() as any).port;
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  /* Empero pointed at the mock upstream. NVIDIA gets a dummy env key (its
   * real upstream is never contacted in these tests). */
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    EMPERO_API_KEY: 'empero-upstream-key',
    EMPERO_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  /* Register client-facing models; the backend model mapping lives only in
   * the registry (client never sees BACKEND_MODEL). */
  await request('POST', '/admin/models', {
    model: CLIENT_MODEL, providerId: 'empero', priority: 10, backendModel: BACKEND_MODEL,
  });
  await request('POST', '/admin/models', { model: OTHER_PROVIDER_MODEL, providerId: 'nvidia', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER_CLOSE();
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function MOCK_SERVER_CLOSE(): void {
  MOCK.close();
}

/** request() with an explicit bearer token + raw header access. */
function authedRequest(method: string, reqPath: string, token: string, body?: any):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, 'http://127.0.0.1:3456');
    const headers: http.OutgoingHttpHeaders = { 'Authorization': `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: any = data;
          try { parsed = JSON.parse(data); } catch { /* raw */ }
          resolve({ status: res.statusCode || 0, headers: res.headers, data: parsed, raw: data });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createClientKey(providerId: string, allowedModels: string[]) {
  const res = await request('POST', '/admin/client-keys', { providerId, allowedModels });
  expect(res.status).toBe(201);
  return res.data.apiKey as string;
}

/** All leak assertions for a client-facing response body (raw text). */
function expectNoLeaks(raw: string): void {
  for (const s of LEAK_STRINGS) {
    expect(raw, `leak detected: "${s}" in: ${raw.slice(0, 400)}`).not.toContain(s);
  }
  expect(raw).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  expect(raw).not.toMatch(/sk-[a-f0-9]{16}/);
}

/* ========================================================================== */

describe('Response BODY leak protection (/v1/chat/completions)', () => {

  it('normal response: no provider name/id, no upstream URL, model normalized to client request', async () => {
    mockChatBehavior = 'ok';
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expectNoLeaks(res.raw);
    /* The upstream received the BACKEND model — the client sees its own. */
    expect(res.data.model).toBe(CLIENT_MODEL);
    expect(res.data.model).not.toBe(BACKEND_MODEL);
    expect(res.data.choices[0].message.content).toBe('MOCK_OK');
  });

  it('leaky metadata response: every internal envelope key is stripped', async () => {
    mockChatBehavior = 'leaky-metadata';
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expectNoLeaks(res.raw);
    for (const key of ['provider', 'providerId', 'upstream', 'upstreamUrl', 'baseUrl',
      'backend', 'backendModel', 'adapter', 'endpoint', 'credential', 'stack']) {
      expect(res.data).not.toHaveProperty(key);
    }
    expect(res.data.model).toBe(CLIENT_MODEL);
    mockChatBehavior = 'ok';
  });

  it('upstream error body is NEVER forwarded: generic [OI] envelope, status preserved', async () => {
    mockChatBehavior = 'upstream-error';
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect(res.data.error).toBeDefined();
    expect(res.data.error.type).toBe('bad_gateway');
    expect(res.data.error.message).not.toContain('SecretProvider');
    expectNoLeaks(res.raw);
    mockChatBehavior = 'ok';
  });

  it('non-JSON upstream body (WAF HTML) → generic 502, nothing echoed', async () => {
    mockChatBehavior = 'waf-html';
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect(res.data.error.type).toBe('bad_gateway');
    expectNoLeaks(res.raw);
    mockChatBehavior = 'ok';
  });
});

describe('Response HEADER leak protection', () => {

  it('gateway-controlled headers only — upstream headers never forwarded', async () => {
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const h = res.headers;
    /* Upstream's identity headers must not appear. */
    expect(h['server']).toBeUndefined();
    expect(h['x-upstream-node']).toBeUndefined();
    expect(h['x-powered-by']).toBeUndefined();
    /* Content type is gateway-controlled JSON. */
    expect(String(h['content-type'])).toContain('application/json');
  });

  it('CORS exposure: only gateway headers are exposed to browsers', async () => {
    const res = await authedRequest('GET', '/v1/models', 'Bearer anything');
    expect(res.status).toBe(200);
    const expose = res.headers['access-control-expose-headers'];
    if (expose) {
      const exposed = String(expose).toLowerCase();
      for (const banned of ['server', 'x-upstream', 'upstream', 'provider', 'authorization']) {
        expect(exposed).not.toContain(banned);
      }
    }
  });
});

describe('STREAMING / SSE leak protection', () => {

  it('SSE chunks: internal keys stripped, model normalized, usage intact, [DONE] kept', async () => {
    const res = await streamRequest('/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const full = res.chunks.join('');
    expectNoLeaks(full);
    expect(full).toContain('data: [DONE]');
    const dataLines = full.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
    expect(dataLines.length).toBeGreaterThanOrEqual(2);
    for (const line of dataLines) {
      const chunk = JSON.parse(line.slice(6));
      expect(chunk.model).toBe(CLIENT_MODEL);
      expect(chunk).not.toHaveProperty('provider');
      expect(chunk).not.toHaveProperty('upstream_url');
    }
  });

  it('mid-stream upstream error event is genericized (no provider name/URL)', async () => {
    mockStreamError = true;
    const res = await streamRequest('/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const full = res.chunks.join('');
    expect(full).not.toContain('SecretProvider');
    expect(full).not.toContain('upstream-secret.example.com');
    expect(full).not.toContain('/secret/path');
    expect(full).not.toMatch(/sk-[a-f0-9]{16}/);
    /* Client still receives a well-formed error event. */
    expect(full).toContain('"error"');
    const errLine = full.split('\n').find(l => l.startsWith('data: ') && l.includes('"error"'));
    expect(errLine).toBeDefined();
    const errObj = JSON.parse(errLine!.slice(6));
    expect(typeof errObj.error.message).toBe('string');
    expect(errObj.error.message).not.toContain('SecretProvider');
    mockStreamError = false;
  });
});

describe('/v1/models leak protection', () => {

  it('only whitelisted fields; owned_by is the gateway identity — never a provider', async () => {
    const res = await authedRequest('GET', '/v1/models', 'Bearer anything');
    expect(res.status).toBe(200);
    expectNoLeaks(res.raw);
    for (const m of res.data.data) {
      expect(Object.keys(m).sort()).toEqual(['created', 'id', 'object', 'owned_by']);
      expect(m.object).toBe('model');
      expect(m.owned_by).toBe('nvidia-api');
    }
    /* The internal backend model id must never appear in the catalog. */
    const ids = res.data.data.map((m: any) => m.id);
    expect(ids).not.toContain(BACKEND_MODEL);
    expect(ids).toContain(CLIENT_MODEL);
  });
});

describe('Client API key — provider mapping stays internal', () => {

  let emperoKey = '';

  beforeAll(async () => {
    emperoKey = await createClientKey('empero', [CLIENT_MODEL]);
  });

  it('key works for its allowed model (E2E success, routing untouched)', async () => {
    receivedAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', emperoKey, {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expectNoLeaks(res.raw);
    expect(res.data.model).toBe(CLIENT_MODEL);
    /* Rotation used the provider's own credential — mapping invisible to client. */
    expect(receivedAuth).toEqual(['Bearer empero-upstream-key']);
  });

  it('provider binding is NOT probeable: any prefix resolves identically to the base model', async () => {
    /* The key's provider is empero. A FOREIGN prefix behaves EXACTLY like the
     * own-provider prefix — no accept/reject difference to fingerprint. */
    for (const prefix of ['empero', 'nvidia', 'anythingelse']) {
      receivedAuth.length = 0;
      const res = await authedRequest('POST', '/v1/chat/completions', emperoKey, {
        model: `${prefix}/${CLIENT_MODEL}`,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expectNoLeaks(res.raw);
      /* Response reports the model the client asked for. */
      expect(res.data.model).toBe(`${prefix}/${CLIENT_MODEL}`);
      /* And it routed to the key's own provider every time. */
      expect(receivedAuth).toEqual(['Bearer empero-upstream-key']);
    }
  });

  it('models outside allowedModels are rejected WITHOUT revealing the bound provider', async () => {
    const res = await authedRequest('POST', '/v1/chat/completions', emperoKey, {
      model: OTHER_PROVIDER_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expectNoLeaks(res.raw);
    expect(res.data.error.message).not.toContain('empero');
    expect(res.data.error.message).not.toContain('nvidia');
  });

  it('/v1/models with a client key shows ONLY allowed models (no other provider catalog)', async () => {
    const res = await authedRequest('GET', '/v1/models', emperoKey);
    expect(res.status).toBe(200);
    expectNoLeaks(res.raw);
    const ids = res.data.data.map((m: any) => m.id);
    expect(ids).toContain(CLIENT_MODEL);
    expect(ids).not.toContain(OTHER_PROVIDER_MODEL);
    expect(ids).not.toContain(BACKEND_MODEL);
  });
});

describe('Provider-locked routing intact (no cross-provider fallback introduced)', () => {

  it('all-keys-failed → request fails with generic error; registered other-provider model untouched', async () => {
    mockChatBehavior = 'upstream-error';
    const res = await authedRequest('POST', '/v1/chat/completions', 'Bearer anything', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expectNoLeaks(res.raw);
    /* The nvidia-registered model was never attempted (no cross-provider fallback). */
    expect(receivedAuth.filter(a => a.includes('nkey1')).length).toBe(0);
    mockChatBehavior = 'ok';
  });
});

describe('Unknown endpoints and method errors on /v1 (consistent envelope)', () => {

  it('unknown /v1 path → 404 [OI]-style envelope, no internals', async () => {
    const res = await authedRequest('GET', '/v1/does-not-exist', 'Bearer anything');
    expect(res.status).toBe(404);
    expectNoLeaks(res.raw);
    expect(res.data.error.message).toBe('The requested endpoint was not found.');
  });

  it('malformed JSON body → 400 envelope without internals', async () => {
    const res = await new Promise<{ status: number; data: any; raw: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST', hostname: '127.0.0.1', port: 3456,
          path: '/v1/chat/completions',
          headers: { 'Authorization': 'Bearer anything', 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            let parsed: any = data;
            try { parsed = JSON.parse(data); } catch { /* raw */ }
            resolve({ status: res.statusCode || 0, data: parsed, raw: data });
          });
        },
      );
      req.on('error', reject);
      req.write('{ this is not valid json');
      req.end();
    });
    expect(res.status).toBe(400);
    expectNoLeaks(res.raw);
  });
});
