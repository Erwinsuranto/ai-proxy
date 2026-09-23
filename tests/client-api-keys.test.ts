/* Client API Keys ("Create API Key" feature) — E2E through the REAL request
 * path with a mock upstream provider.
 *
 * Covers the required scenarios:
 *  1. Create API key with provider NVIDIA (registry-validated).
 *  2. Create API key with provider Empero.
 *  3. Model catalog changes per provider (dynamic registry-driven).
 *  4. Models of OTHER providers never appear in a provider's catalog.
 *  5. A client key can only be used for its own provider's models.
 *  6. Models outside allowedModels are rejected (403, clear error).
 *  7. A newly registered provider appears in the catalog without frontend
 *     changes (dynamic registration → catalog).
 *  8. Existing provider-key functionality keeps working (regression).
 *
 * The client key is bound  API Key → Provider → Allowed Models; routing rules
 * (model → fixed provider → multi-key rotation within that provider) are
 * untouched — no cross-provider fallback is introduced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, request, configFile, getBaseUrl } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const CLIENT_KEYS_FILE = configFile('client-api-keys.json');

const NV_MODEL = 'nv-client-model';
const EMP_MODEL_A = 'glm-4';
const EMP_MODEL_B = 'glm-4.5';
const OTHER_MODEL = 'other-provider-model';

const receivedAuth: string[] = [];
const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    receivedAuth.push(String(req.headers['authorization'] || ''));
    const upstreamKey = String(req.headers['authorization'] || '').replace('Bearer ', '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: `MOCK_OK_${upstreamKey}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  /* NVIDIA keeps its fake env key (fails upstream); Empero is pointed at the
   * mock upstream so allowed-model requests succeed end-to-end. */
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    EMPERO_API_KEY: 'empero-upstream-key',
    EMPERO_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENROUTER_API_KEY: 'orkey1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  /* Register models per provider in the model registry (source of truth). */
  await request('POST', '/admin/models', { model: NV_MODEL, providerId: 'nvidia', priority: 10 });
  await request('POST', '/admin/models', { model: EMP_MODEL_A, providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: EMP_MODEL_B, providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: OTHER_MODEL, providerId: 'nvidia', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER.close();
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** request() with an explicit bearer token. */
function authedRequest(method: string, reqPath: string, token: string, body?: any):
  Promise<{ status: number; data: any }> {
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
          try { parsed = JSON.parse(data); } catch { /* raw text */ }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createClientKey(providerId: string, allowedModels: string[], label?: string) {
  const res = await request('POST', '/admin/client-keys', { providerId, allowedModels, label });
  expect(res.status).toBe(201);
  expect(res.data.success).toBe(true);
  /* Raw key appears exactly once, masked metadata alongside. */
  expect(typeof res.data.apiKey).toBe('string');
  expect(res.data.apiKey.startsWith('sk-')).toBe(true);
  expect(JSON.stringify(res.data.key)).not.toContain(res.data.apiKey);
  expect(res.data.key.maskedKey).toBe(res.data.apiKey.slice(0, 4) + '***' + res.data.apiKey.slice(-4));
  return res.data;
}

describe('Admin Client API Keys — catalog (dynamic, registry-driven)', () => {

  it('catalog lists registered providers with ONLY their own models', async () => {
    const res = await request('GET', '/admin/client-keys/catalog');
    expect(res.status).toBe(200);
    const empero = res.data.providers.find((p: any) => p.id === 'empero');
    const nvidia = res.data.providers.find((p: any) => p.id === 'nvidia');
    expect(empero).toBeDefined();
    expect(nvidia).toBeDefined();

    /* Empero shows ONLY Empero models — no nvidia/openrouter models. */
    expect(empero.models).toContain(EMP_MODEL_A);
    expect(empero.models).toContain(EMP_MODEL_B);
    expect(empero.models).not.toContain(NV_MODEL);
    expect(empero.models).not.toContain(OTHER_MODEL);

    /* NVIDIA shows ONLY NVIDIA models — no Empero models. */
    expect(nvidia.models).toContain(NV_MODEL);
    expect(nvidia.models).not.toContain(EMP_MODEL_A);
    expect(nvidia.models).not.toContain(EMP_MODEL_B);
  });

  it('a newly registered provider/model appears in the catalog automatically', async () => {
    const before = await request('GET', '/admin/client-keys/catalog');
    const orBefore = before.data.providers.find((p: any) => p.id === 'openrouter');
    expect(orBefore?.models || []).not.toContain('or-client-model');

    /* Register one model and it shows up without any frontend change —
     * the catalog is driven by the live model registry, not hardcoded. */
    const reg = await request('POST', '/admin/models', { model: 'or-client-model', providerId: 'openrouter', priority: 10 });
    expect([200, 201]).toContain(reg.status);
    const after = await request('GET', '/admin/client-keys/catalog');
    const or = after.data.providers.find((p: any) => p.id === 'openrouter');
    expect(or).toBeDefined();
    expect(or.models).toContain('or-client-model');
  });
});

describe('Admin Client API Keys — create', () => {

  it('creates a key for provider NVIDIA (201, masked metadata, no raw persistence)', async () => {
    const data = await createClientKey('nvidia', [NV_MODEL], 'nv-test');
    expect(data.key.providerId).toBe('nvidia');
    expect(data.key.allowedModels).toEqual([NV_MODEL]);
    expect(data.key.label).toBe('nv-test');
    expect(data.key.status).toBe('active');

    /* Only a SHA-256 hash is persisted — the raw secret must not exist on disk. */
    const raw = JSON.parse(fs.readFileSync(CLIENT_KEYS_FILE, 'utf-8'));
    expect(JSON.stringify(raw)).not.toContain(data.apiKey);
    const stored = raw.keys.find((k: any) => k.id === data.key.id);
    expect(stored.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates a key for provider Empero with multiple allowed models', async () => {
    const data = await createClientKey('empero', [EMP_MODEL_A, EMP_MODEL_B], 'empero-test');
    expect(data.key.providerId).toBe('empero');
    expect(data.key.allowedModels).toEqual([EMP_MODEL_A, EMP_MODEL_B]);
  });

  it('rejects models not registered for the selected provider', async () => {
    const res = await request('POST', '/admin/client-keys', {
      providerId: 'empero',
      allowedModels: [EMP_MODEL_A, NV_MODEL],
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain(NV_MODEL);
  });

  it('rejects unknown providers and empty model lists', async () => {
    const unknown = await request('POST', '/admin/client-keys', {
      providerId: 'does-not-exist',
      allowedModels: [EMP_MODEL_A],
    });
    expect(unknown.status).toBe(404);

    const empty = await request('POST', '/admin/client-keys', {
      providerId: 'empero',
      allowedModels: [],
    });
    expect(empty.status).toBe(400);
  });
});

describe('Client key request enforcement (API Key → Provider → Allowed Models)', () => {

  let emperoKeyId = '';
  let emperoRawKey = '';
  let nvidiaRawKey = '';

  beforeAll(async () => {
    const emp = await createClientKey('empero', [EMP_MODEL_A, EMP_MODEL_B], 'enforce-emp');
    emperoKeyId = emp.key.id;
    emperoRawKey = emp.apiKey;
    const nv = await createClientKey('nvidia', [NV_MODEL], 'enforce-nv');
    nvidiaRawKey = nv.apiKey;
  });

  it('allows a request for an allowed model of its own provider (E2E success)', async () => {
    receivedAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: EMP_MODEL_A,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.data.choices?.[0]?.message?.content).toBe('MOCK_OK_empero-upstream-key');
    /* Routing unchanged: the request went to the Empero upstream with the
     * provider's OWN multi-key credential — not any other provider. */
    expect(receivedAuth).toEqual(['Bearer empero-upstream-key']);
  });

  it('rejects a model outside allowedModels with a clear 403 error', async () => {
    receivedAuth.length = 0;
    await request('POST', '/admin/models', { model: 'glm-5.3-flash', providerId: 'empero', priority: 10 });
    const res = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
    expect(res.data.error?.message).toContain('glm-5.3-flash');
    expect(res.data.error?.type).toBe('permission_error');
  });

  it('rejects requests that would route to ANOTHER provider', async () => {
    /* NV_MODEL is registered only for nvidia — the empero key must never
     * reach it, even though the model exists in the system. */
    const res = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: NV_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
    /* No upstream was contacted. */
    expect(receivedAuth.length).toBe(0);
  });

  it('allows an own-provider prefixed model like "empero/<model>"', async () => {
    receivedAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: `empero/${EMP_MODEL_A}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('rejects foreign provider prefixes like "nvidia/<model>"', async () => {
    const res = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: `nvidia/${NV_MODEL}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
    /* The denial must NOT reveal the key's bound internal provider. */
    expect(res.data.error?.message).not.toContain('empero');
  });

  it('lists only allowed models on /v1/models for the client key', async () => {
    const res = await authedRequest('GET', '/v1/models', emperoRawKey);
    expect(res.status).toBe(200);
    const ids = res.data.data.map((m: any) => m.id);
    expect(ids).toContain(EMP_MODEL_A);
    expect(ids).toContain(EMP_MODEL_B);
    expect(ids).not.toContain(NV_MODEL);
    expect(ids).not.toContain(OTHER_MODEL);
  });

  it('works on /v1/embeddings too (403 outside allowlist)', async () => {
    const res = await authedRequest('POST', '/v1/embeddings', emperoRawKey, {
      model: NV_MODEL,
      input: 'hello',
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
  });

  it('rejects disabled keys with 401 and re-enables them', async () => {
    const off = await request('PATCH', `/admin/client-keys/${emperoKeyId}`, { enabled: false });
    expect(off.status).toBe(200);
    const denied = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: EMP_MODEL_A,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(denied.status).toBe(401);

    const on = await request('PATCH', `/admin/client-keys/${emperoKeyId}`, { enabled: true });
    expect(on.status).toBe(200);
    const ok = await authedRequest('POST', '/v1/chat/completions', emperoRawKey, {
      model: EMP_MODEL_B,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ok.status).toBe(200);
  });

  it('records blocked attempts in usage logs attributed to the key', async () => {
    const logs = await request('GET', '/admin/logs?limit=100');
    expect(logs.status).toBe(200);
    const blocked = logs.data.logs.filter((l: any) => l.status === 'blocked' && l.apiKeyMasked);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].apiKeyMasked).toMatch(/^.{4}\*\*\*.{4}$/);
    expect(blocked[0].provider).toBe('empero');
  });

  it('a different client key for another provider cannot use the first key\'s models', async () => {
    /* The nvidia key must NOT be able to use Empero's models. */
    const res = await authedRequest('POST', '/v1/chat/completions', nvidiaRawKey, {
      model: EMP_MODEL_A,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
  });
});

describe('Existing functionality unaffected', () => {

  it('master env API_KEY behavior unchanged (still accepted on /v1)', async () => {
    /* Tests run with API_KEY cleared → `Bearer anything` still works. */
    const res = await request('POST', '/v1/chat/completions', {
      model: EMP_MODEL_A,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('provider API key CRUD still works (regression)', async () => {
    const add = await request('POST', '/admin/providers/empero/api-keys', {
      apiKey: 'extra-provider-key-1',
    });
    expect(add.status).toBe(201);
    const list = await request('GET', '/admin/providers/empero/api-keys');
    expect(list.status).toBe(200);
    expect(list.data.keys.some((k: any) => k.maskedKey === 'extr***ey-1')).toBe(true);
    const del = await request('DELETE', `/admin/providers/empero/api-keys/${add.data.key.id}`);
    expect(del.status).toBe(200);
  });

  it('client key list/toggle/delete lifecycle works', async () => {
    const list = await request('GET', '/admin/client-keys');
    expect(list.status).toBe(200);
    expect(list.data.keys.length).toBeGreaterThanOrEqual(3);

    /* The enforce-emp key was used for successful requests → usage metadata. */
    const target = list.data.keys.find((k: any) => k.label === 'enforce-emp');
    expect(target).toBeDefined();
    expect(target.lastUsedAt).toBeTruthy();
    expect(target.requestCount).toBeGreaterThan(0);
  });
});

/* ── Prompt: DELETE must work exactly like the fixed Admin UI sends it,
 *    and the raw key must stay one-time (never recoverable, never stored) ── */
describe('Client API Keys — DELETE request shape & raw-key one-timeness', () => {
  let keyId: string;
  let rawKey: string;
  const sentinelLabel = `sentinel-${Date.now()}`;
  let sentinelId: string;
  let sentinelRaw = '';

  it('a body-less request that still declares Content-Type: application/json is rejected by Fastify BEFORE the handler (FST_ERR_CTP_EMPTY_JSON_BODY) — this is what broke UI deletes; backend validation stays intact', async () => {
    const created = await createClientKey('nvidia', [NV_MODEL], 'delete-contract');
    keyId = created.key.id;
    rawKey = created.apiKey;
    const kept = await createClientKey('empero', [EMP_MODEL_A], sentinelLabel);
    sentinelId = kept.key.id;
    sentinelRaw = kept.apiKey;

    /* Raw key must NOT appear in any list response (metadata masked only). */
    const list = await request('GET', '/admin/client-keys');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toContain(rawKey);

    const url = new URL(`/admin/client-keys/${encodeURIComponent(keyId)}`, getBaseUrl());
    const bad = await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    const badBody = await bad.json() as any;
    expect(String(badBody.error || '').toLowerCase()).toContain('body cannot be empty');
    /* The route handler never ran — the key is still there. */
    expect((await request('GET', '/admin/client-keys')).data.keys.some((k: any) => k.id === keyId)).toBe(true);
  });

  it('DELETE without a Content-Type/empty-body combination (the way the admin UI now sends it) succeeds', async () => {
    const url = new URL(`/admin/client-keys/${encodeURIComponent(keyId)}`, getBaseUrl());
    const res = await fetch(url, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.keyId).toBe(keyId);
  });

  it('the deleted key is gone from list + storage, cannot authenticate, other keys survive', async () => {
    const list = await request('GET', '/admin/client-keys');
    expect(list.data.keys.some((k: any) => k.id === keyId)).toBe(false);
    expect(fs.readFileSync(CLIENT_KEYS_FILE, 'utf-8')).not.toContain(keyId);
    expect(fs.readFileSync(CLIENT_KEYS_FILE, 'utf-8')).toContain(sentinelId);

    /* This suite runs with a cleared master API_KEY (permissive), so the 401
       proof for the deleted raw key lives in client-key-delete-auth.test.ts.
       The surviving key can still serve its own model E2E here: */
    const kept = await authedRequest('POST', '/v1/chat/completions', sentinelRaw, {
      model: EMP_MODEL_A, messages: [{ role: 'user', content: 'x' }],
    });
    expect(kept.status).toBe(200);
  });

  it('repeated DELETE of a vanished key respects the existing contract (404 + error)', async () => {
    const res = await request('DELETE', `/admin/client-keys/${encodeURIComponent(keyId)}`);
    expect(res.status).toBe(404);
    expect(res.data.error).toContain(keyId);
    /* and the other key is STILL intact after double deletes */
    expect((await request('GET', '/admin/client-keys')).data.keys.some((k: any) => k.id === sentinelId)).toBe(true);
  });
});
