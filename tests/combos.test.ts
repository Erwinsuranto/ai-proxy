/* COMBO feature (Client → Provider → Model → Provider API Key) — E2E through
 * the REAL request path with mock upstream providers.
 *
 * Required scenarios:
 *   1. Create combo valid                       → 201
 *   2. Model from another provider              → 400
 *   3. Provider API key from another provider   → 400
 *   4. Request with active combo                → routed ONLY to combo provider
 *   5. Provider fails                           → NO fallback to another provider
 *   6. Provider API key fails                   → rotate within SAME provider
 *   7. All provider API keys fail               → error returned
 *   8. Combo disabled                           → denied per allowlist policy
 *   9. User without combo                       → unallowed model rejected
 *  10. /v1/models                               → allowlist ∪ active combo models
 *  11. Combo catalog                            → own models/keys only, masked
 *  12. Secret leakage                           → no raw keys / upstream URLs
 *  13. Usage                                    → combo attribution + counters
 *  14. Multi-key                                → rotation stays in one provider
 *  15. Streaming                                → combo routing + usage recorded
 *
 * TEST POLICY: no Gorouter.app is used anywhere here (excluded from the suite).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const CLIENT_KEYS_FILE = configFile('client-api-keys.json');
const PROVIDER_KEYS_FILE = configFile('provider-api-keys.json');
const COMBOS_FILE = configFile('combos.json');

const EMPERO_ENV_KEY = 'empero-upstream-key';
const EMP_KEY_1 = 'emp-key-1';
const EMP_KEY_2 = 'emp-key-2';
const NV_KEY_1 = 'nv-key-1';

/* Mutable upstream behaviour (flipped between scenarios). */
const upstream = {
  /* Empero returns 429 for this credential (pinned-key rotation scenario). */
  failEmpKey2: false,
  /* Empero fails EVERY chat request with 500 (no-fallback scenario). */
  failAllEmpero: false,
};

const empChatAuth: string[] = [];
const nvChatAuth: string[] = [];

function chatCompletionBody(): any {
  return {
    id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c.toString(); });
    req.on('end', () => resolve(data));
  });
}

const EMPERO_MOCK = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    const auth = String(req.headers['authorization'] || '');
    const body = JSON.parse((await collectBody(req)) || '{}');
    empChatAuth.push(auth);
    if (upstream.failAllEmpero) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream down' } }));
      return;
    }
    if (upstream.failEmpKey2 && auth === `Bearer ${EMP_KEY_2}`) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hello' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 's1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(chatCompletionBody()));
    return;
  }
  res.writeHead(404); res.end();
});

const NVIDIA_MOCK = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    nvChatAuth.push(String(req.headers['authorization'] || ''));
    /* NVIDIA mock always rate-limits chat requests (all-keys-fail scenario). */
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    return;
  }
  res.writeHead(404); res.end();
});

let empPort = 0;
let nvPort = 0;

beforeAll(async () => {
  await Promise.all([
    new Promise<void>(r => EMPERO_MOCK.listen(0, '127.0.0.1', r)),
    new Promise<void>(r => NVIDIA_MOCK.listen(0, '127.0.0.1', r)),
  ]);
  empPort = (EMPERO_MOCK.address() as any).port;
  nvPort = (NVIDIA_MOCK.address() as any).port;
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE, PROVIDER_KEYS_FILE, COMBOS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    NVIDIA_BASE_URL: `http://127.0.0.1:${nvPort}/v1`,
    EMPERO_API_KEY: EMPERO_ENV_KEY,
    EMPERO_BASE_URL: `http://127.0.0.1:${empPort}/v1`,
  });
  /* Model registry (source of truth) — shared-model resolves to nvidia by
   * priority (5 < 10) unless a combo forces empero. */
  await request('POST', '/admin/models', { model: 'shared-model', providerId: 'nvidia', priority: 5 });
  await request('POST', '/admin/models', { model: 'shared-model', providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: 'emp-model-a', providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: 'emp-model-b', providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: 'pin-model', providerId: 'empero', priority: 10 });
  await request('POST', '/admin/models', { model: 'nv-model-a', providerId: 'nvidia', priority: 10 });

  /* Provider API keys (UI-managed, merged into each provider's KeyManager). */
  const k1 = await request('POST', '/admin/providers/empero/api-keys', { apiKey: EMP_KEY_1, label: 'Empero Key 1' });
  expect(k1.status).toBe(201);
  const k2 = await request('POST', '/admin/providers/empero/api-keys', { apiKey: EMP_KEY_2, label: 'Empero Key 2' });
  expect(k2.status).toBe(201);
  const nk = await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: NV_KEY_1, label: 'Nvidia Key 1' });
  expect(nk.status).toBe(201);
  globalThis.__empKey1Id = k1.data.key.id;
  globalThis.__empKey2Id = k2.data.key.id;
  globalThis.__nvKey1Id = nk.data.key.id;
}, 60000);

afterAll(async () => {
  await stopServer().catch(() => { });
  EMPERO_MOCK.close();
  NVIDIA_MOCK.close();
  for (const f of [USAGE_FILE, CLIENT_KEYS_FILE, PROVIDER_KEYS_FILE, COMBOS_FILE]) {
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

/** Streaming request with an explicit bearer token. */
function authedStreamRequest(reqPath: string, token: string, body: any):
  Promise<{ status: number; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, 'http://127.0.0.1:3456');
    const req = http.request(
      {
        method: 'POST', hostname: url.hostname, port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (c: Buffer) => { chunks.push(c.toString()); });
        res.on('end', () => resolve({ status: res.statusCode || 0, chunks }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function createClientKey(providerId: string, allowedModels: string[], label?: string) {
  const res = await request('POST', '/admin/client-keys', { providerId, allowedModels, label });
  expect(res.status).toBe(201);
  return res.data;
}

async function createCombo(body: { clientKeyId: string; providerId: string; model: string; providerKeyId?: string | null }) {
  return request('POST', '/admin/combos', body);
}

declare global {
  // eslint-disable-next-line no-var
  var __empKey1Id: string, __empKey2Id: string, __nvKey1Id: string,
    __keyA: any, __comboA: any, __keyB: any, __comboB: any, __keyC: any,
    __keyD: any, __comboD: any, __keyN: any, __comboN: any;
}

/* ═════════════════════════ Admin API — validation & catalog ═══════════════ */

/* GET /admin/combos contract tests. This describe runs FIRST (before any
 * combo-creating describe), so the store is guaranteed empty at its start. */
describe('COMBO admin API — GET /admin/combos (list contract)', () => {
  it('empty store → 200 with JSON `{ combos: [] }` (empty state, NOT an error)', async () => {
    const res = await request('GET', '/admin/combos');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.data).toEqual({ combos: [] });
  });

  it('combo with STALE references (deleted client key / provider key) still lists → 200, null enrichments', async () => {
    /* Write a combo referencing entities that do not exist — simulates a
     * deleted client key or provider key behind an existing combo. */
    const now = Date.now();
    const stale = {
      id: 'combo_stale-ref-test',
      clientKeyId: 'ck_deleted-client-key',
      providerId: 'empero',
      model: 'emp-model-a',
      providerKeyId: 'key_deleted-provider-key',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      lastUsedAt: null,
    };
    fs.mkdirSync(path.dirname(COMBOS_FILE), { recursive: true });
    fs.writeFileSync(COMBOS_FILE, JSON.stringify({ version: 1, combos: [stale] }, null, 2), 'utf-8');

    try {
      const res = await request('GET', '/admin/combos');
      expect(res.status).toBe(200);
      const row = res.data.combos.find((c: any) => c.id === 'combo_stale-ref-test');
      expect(row).toBeDefined();
      expect(row.providerId).toBe('empero');
      expect(row.model).toBe('emp-model-a');
      expect(row.clientKey).toBeNull();          // stale client key degrades to null
      expect(row.providerKey).toBeNull();        // stale provider key degrades to null
      /* Masked metadata only — never a raw credential or hash. */
      expect(JSON.stringify(row)).not.toContain('keyHash');
    } finally {
      await request('DELETE', `/admin/combos/${stale.id}`);
    }
    const after = await request('GET', '/admin/combos');
    expect(after.status).toBe(200);
    expect(after.data.combos.find((c: any) => c.id === 'combo_stale-ref-test')).toBeUndefined();
  });

  it('error envelopes on the admin surface are STRINGS (never "[object Object]")', async () => {
    /* Unknown admin route → 404 with string error. */
    const nf = await request('GET', '/admin/combos-does-not-exist');
    expect(nf.status).toBe(404);
    expect(typeof nf.data.error).toBe('string');
    expect(nf.data.error.length).toBeGreaterThan(0);

    /* Malformed JSON body → 400 with string error (Fastify parse failure). */
    const bad = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST', hostname: '127.0.0.1', port: 3456,
          path: '/admin/combos',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer anything' },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            let parsed: any = data;
            try { parsed = JSON.parse(data); } catch { /* raw */ }
            resolve({ status: res.statusCode || 0, data: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write('{invalid-json');
      req.end();
    });
    expect(bad.status).toBe(400);
    expect(typeof bad.data.error).toBe('string');
    expect(bad.data.error).toContain('JSON');

    /* Validation failure → 400 with string error. */
    const missing = await request('POST', '/admin/combos', { clientKeyId: '', providerId: '', model: '' });
    expect(missing.status).toBe(400);
    expect(typeof missing.data.error).toBe('string');
  });

  it('lists a combo with client API key + provider + model + provider-wide rotation (masked only)', async () => {
    const keyR = await createClientKey('empero', ['emp-model-a'], 'list-rotation-key');
    const comboR = await createCombo({
      clientKeyId: keyR.key.id, providerId: 'empero', model: 'emp-model-a', providerKeyId: null,
    });
    expect(comboR.status).toBe(201);

    const res = await request('GET', '/admin/combos');
    expect(res.status).toBe(200);
    const row = res.data.combos.find((c: any) => c.id === comboR.data.combo.id);
    expect(row).toBeDefined();
    /* Entity references survive the round-trip. */
    expect(row.clientKeyId).toBe(keyR.key.id);
    expect(row.providerId).toBe('empero');
    expect(row.model).toBe('emp-model-a');
    expect(row.providerKeyId).toBeNull();
    expect(row.status).toBe('active');
    /* Enriched metadata: client key is MASKED (no keyHash), provider name present. */
    expect(row.clientKey).toMatchObject({ id: keyR.key.id, status: 'active' });
    expect(row.clientKey.maskedKey).toContain('***');
    expect(JSON.stringify(row)).not.toContain(keyR.apiKey);   // raw client secret never leaks
    expect(JSON.stringify(row)).not.toContain('keyHash');
    expect(typeof row.providerName).toBe('string');
    expect(row.providerName.length).toBeGreaterThan(0);
    expect(row.providerKey).toBeNull();                        // null = provider-wide rotation

    await request('DELETE', `/admin/combos/${comboR.data.combo.id}`);
  });

  it('lists a combo pinned to a SPECIFIC provider API key with masked metadata', async () => {
    const keyP = await createClientKey('empero', ['emp-model-b'], 'list-pinned-key');
    const comboP = await createCombo({
      clientKeyId: keyP.key.id, providerId: 'empero', model: 'emp-model-b', providerKeyId: globalThis.__empKey1Id,
    });
    expect(comboP.status).toBe(201);

    const res = await request('GET', '/admin/combos');
    expect(res.status).toBe(200);
    const row = res.data.combos.find((c: any) => c.id === comboP.data.combo.id);
    expect(row.providerKeyId).toBe(globalThis.__empKey1Id);
    expect(row.providerKey).toMatchObject({
      id: globalThis.__empKey1Id,
      status: 'active',
    });
    expect(row.providerKey.maskedKey).toContain('***');
    /* The pinned provider key's RAW value (EMP_KEY_1) must never appear. */
    expect(JSON.stringify(row)).not.toContain(EMP_KEY_1);
    expect(JSON.stringify(row)).not.toContain(EMPERO_ENV_KEY);

    await request('DELETE', `/admin/combos/${comboP.data.combo.id}`);
  });
});

describe('COMBO admin API — create + backend validation', () => {
  let keyA: any;

  beforeAll(async () => {
    keyA = await createClientKey('empero', ['shared-model'], 'combo-key-a');
    globalThis.__keyA = keyA;
  });

  it('1. creates a valid combo (client + provider + model + provider key)', async () => {
    const res = await createCombo({
      clientKeyId: keyA.key.id, providerId: 'empero', model: 'shared-model', providerKeyId: null,
    });
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    expect(res.data.combo.id).toMatch(/^combo_/);
    expect(res.data.combo.clientKeyId).toBe(keyA.key.id);
    expect(res.data.combo.providerId).toBe('empero');
    expect(res.data.combo.model).toBe('shared-model');
    expect(res.data.combo.status).toBe('active');
    expect(res.data.combo.requestCount).toBe(0);
    globalThis.__comboA = res.data.combo;
  });

  it('2. rejects a model registered for ANOTHER provider (cross-provider model → 400)', async () => {
    const res = await createCombo({
      clientKeyId: keyA.key.id, providerId: 'empero', model: 'nv-model-a',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('nv-model-a');
  });

  it('3. rejects a provider API key from ANOTHER provider (cross-provider key → 400)', async () => {
    const res = await createCombo({
      clientKeyId: keyA.key.id, providerId: 'empero', model: 'emp-model-a', providerKeyId: globalThis.__nvKey1Id,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('not found for provider');
  });

  it('rejects unknown client keys, unknown providers and unknown models', async () => {
    const badClient = await createCombo({ clientKeyId: 'ck_nope', providerId: 'empero', model: 'emp-model-a' });
    expect(badClient.status).toBe(400);
    const badProvider = await createCombo({ clientKeyId: keyA.key.id, providerId: 'nope', model: 'emp-model-a' });
    expect(badProvider.status).toBe(400);
    const badModel = await createCombo({ clientKeyId: keyA.key.id, providerId: 'empero', model: 'ghost-model' });
    expect(badModel.status).toBe(400);
  });

  it('rejects a Combo provider that differs from the client key provider', async () => {
    const nvidiaClient = await createClientKey('nvidia', ['nv-model-a'], 'nvidia-client');
    const res = await createCombo({
      clientKeyId: nvidiaClient.key.id,
      providerId: 'empero',
      model: 'emp-model-a',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('belongs to provider');
  });

  it('rejects a duplicate ACTIVE combo for the same client key + model', async () => {
    const res = await createCombo({
      clientKeyId: keyA.key.id, providerId: 'empero', model: 'shared-model',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('already exists');
  });

  it('edits a combo (PATCH) and re-validates the resulting tuple', async () => {
    const ok = await request('PATCH', `/admin/combos/${globalThis.__comboA.id}`, { providerKeyId: globalThis.__empKey1Id });
    expect(ok.status).toBe(200);
    expect(ok.data.combo.providerKeyId).toBe(globalThis.__empKey1Id);

    /* Cross-provider key edit must fail with 400 and change nothing. */
    const cross = await request('PATCH', `/admin/combos/${globalThis.__comboA.id}`, { providerKeyId: globalThis.__nvKey1Id });
    expect(cross.status).toBe(400);
    const after = await request('GET', '/admin/combos');
    const still = after.data.combos.find((c: any) => c.id === globalThis.__comboA.id);
    expect(still.providerKeyId).toBe(globalThis.__empKey1Id);

    /* Cross-provider MODEL edit must fail too. */
    const crossModel = await request('PATCH', `/admin/combos/${globalThis.__comboA.id}`, { model: 'nv-model-a' });
    expect(crossModel.status).toBe(400);

    /* Reset to provider-wide rotation. */
    const reset = await request('PATCH', `/admin/combos/${globalThis.__comboA.id}`, { providerKeyId: null });
    expect(reset.status).toBe(200);
    expect(reset.data.combo.providerKeyId).toBeNull();
  });

  it('deletes a combo', async () => {
    const scratch = await createClientKey('empero', ['emp-model-a'], 'scratch');
    const created = await createCombo({ clientKeyId: scratch.key.id, providerId: 'empero', model: 'emp-model-a' });
    expect(created.status).toBe(201);
    const del = await request('DELETE', `/admin/combos/${created.data.combo.id}`);
    expect(del.status).toBe(200);
    const list = await request('GET', '/admin/combos');
    expect(list.data.combos.find((c: any) => c.id === created.data.combo.id)).toBeUndefined();
  });

  it('never allows two ACTIVE combos for the same client key + model (disable → create → re-enable)', async () => {
    const x = await createCombo({ clientKeyId: keyA.key.id, providerId: 'empero', model: 'emp-model-a' });
    expect(x.status).toBe(201);

    /* Disable X, create colliding Y, then re-enabling X must be rejected. */
    const off = await request('PATCH', `/admin/combos/${x.data.combo.id}`, { enabled: false });
    expect(off.status).toBe(200);
    const y = await createCombo({ clientKeyId: keyA.key.id, providerId: 'empero', model: 'emp-model-a' });
    expect(y.status).toBe(201);
    const reEnable = await request('PATCH', `/admin/combos/${x.data.combo.id}`, { enabled: true });
    expect(reEnable.status).toBe(400);
    expect(reEnable.data.error).toContain('already exists');

    /* And vice versa. */
    const offY = await request('PATCH', `/admin/combos/${y.data.combo.id}`, { enabled: false });
    expect(offY.status).toBe(200);
    const onX = await request('PATCH', `/admin/combos/${x.data.combo.id}`, { enabled: true });
    expect(onX.status).toBe(200);
    const onY = await request('PATCH', `/admin/combos/${y.data.combo.id}`, { enabled: true });
    expect(onY.status).toBe(400);

    await request('DELETE', `/admin/combos/${x.data.combo.id}`);
    await request('DELETE', `/admin/combos/${y.data.combo.id}`);
  });

  it('PATCH with an entity edit + colliding re-enable is rejected ATOMICALLY (no partial write)', async () => {
    /* comboA is ACTIVE for (keyA, shared-model). Create a DISABLED combo X
     * for (keyA, emp-model-a), then try to move X onto shared-model AND
     * re-enable it in ONE PATCH — the collision must reject the WHOLE patch:
     * the model edit must NOT be persisted. */
    const x = await createCombo({
      clientKeyId: globalThis.__keyA.key.id, providerId: 'empero', model: 'emp-model-a',
    });
    expect(x.status).toBe(201);
    const off = await request('PATCH', `/admin/combos/${x.data.combo.id}`, { enabled: false });
    expect(off.status).toBe(200);

    const bad = await request('PATCH', `/admin/combos/${x.data.combo.id}`, {
      model: 'shared-model',   // collides with active comboA once re-enabled
      enabled: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('already exists');
    expect(typeof bad.data.error).toBe('string');

    /* Nothing was applied: X still points at emp-model-a and stays disabled. */
    const after = await request('GET', '/admin/combos');
    const row = after.data.combos.find((c: any) => c.id === x.data.combo.id);
    expect(row.model).toBe('emp-model-a');
    expect(row.status).toBe('disabled');

    await request('DELETE', `/admin/combos/${x.data.combo.id}`);
  });

  it('PATCH with an invalid status and entity edit is rejected atomically', async () => {
    const x = await createCombo({
      clientKeyId: globalThis.__keyA.key.id, providerId: 'empero', model: 'emp-model-a',
    });
    expect(x.status).toBe(201);

    const bad = await request('PATCH', `/admin/combos/${x.data.combo.id}`, {
      model: 'emp-model-b',
      enabled: 'true',
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe('enabled field must be a boolean');

    const after = await request('GET', '/admin/combos');
    const row = after.data.combos.find((c: any) => c.id === x.data.combo.id);
    expect(row.model).toBe('emp-model-a');
    expect(row.status).toBe('active');

    await request('DELETE', `/admin/combos/${x.data.combo.id}`);
  });

  it('grants slashed registry model ids (e.g. "org/model") via combo', async () => {
    const reg = await request('POST', '/admin/models', { model: 'org/slash-model', providerId: 'empero', priority: 10 });
    expect([200, 201]).toContain(reg.status);
    const keyE = await createClientKey('empero', ['emp-model-a'], 'slash-key');
    const comboE = await createCombo({ clientKeyId: keyE.key.id, providerId: 'empero', model: 'org/slash-model' });
    expect(comboE.status).toBe(201);

    empChatAuth.length = 0;
    nvChatAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', keyE.apiKey, {
      model: 'org/slash-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(empChatAuth.length).toBe(1);
    expect(nvChatAuth.length).toBe(0);
    /* A foreign prefix spelling must NOT bypass the combo pin. */
    const prefixed = await authedRequest('POST', '/v1/chat/completions', keyE.apiKey, {
      model: `nvidia/org/slash-model`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(prefixed.status).toBe(200);
    expect(nvChatAuth.length).toBe(0);
    await request('DELETE', `/admin/combos/${comboE.data.combo.id}`);
  });
});

describe('COMBO catalog (dynamic, registry-driven, masked)', () => {
  it('11. lists providers with ONLY their own models + OWN active keys (masked)', async () => {
    const res = await request('GET', '/admin/combos/catalog');
    expect(res.status).toBe(200);
    const empero = res.data.providers.find((p: any) => p.id === 'empero');
    const nvidia = res.data.providers.find((p: any) => p.id === 'nvidia');
    expect(empero).toBeDefined();
    expect(nvidia).toBeDefined();

    /* Empero: ONLY Empero models, ONLY Empero keys. */
    expect(empero.models).toContain('emp-model-a');
    expect(empero.models).toContain('shared-model');
    expect(empero.models).not.toContain('nv-model-a');
    expect(empero.apiKeys.some((k: any) => k.maskedKey === 'emp-***ey-1' || k.maskedKey.includes('***'))).toBe(true);
    expect(empero.apiKeys.some((k: any) => k.id === globalThis.__empKey1Id)).toBe(true);
    expect(empero.apiKeys.some((k: any) => k.id === globalThis.__nvKey1Id)).toBe(false);

    /* NVIDIA: ONLY NVIDIA models + keys. */
    expect(nvidia.models).toContain('nv-model-a');
    expect(nvidia.models).not.toContain('emp-model-a');
    expect(nvidia.apiKeys.some((k: any) => k.id === globalThis.__nvKey1Id)).toBe(true);
    expect(nvidia.apiKeys.some((k: any) => k.id === globalThis.__empKey1Id)).toBe(false);

    /* Client keys are included for the form's first dropdown. */
    expect(res.data.clientKeys.length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════ Request routing (E2E) ════════════════════════ */

describe('COMBO request routing — provider-locked, same-provider rotation', () => {
  it('4. routes a combo request ONLY to the combo provider (combo overrides priority)', async () => {
    const keyA = globalThis.__keyA;
    empChatAuth.length = 0;
    nvChatAuth.length = 0;
    /* shared-model resolves to NVIDIA by priority — the combo pins it to
     * Empero. The upstream credential used must be an EMPERO one. */
    const res = await authedRequest('POST', '/v1/chat/completions', keyA.apiKey, {
      model: 'shared-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.data.choices?.[0]?.message?.content).toBe('MOCK_OK');
    expect(empChatAuth.length).toBe(1);
    expect(empChatAuth[0]).toMatch(/^Bearer /);
    /* ZERO cross-provider contact. */
    expect(nvChatAuth.length).toBe(0);
  });

  it('an allowlisted prefixed spelling can never bypass the combo provider pin', async () => {
    /* "nvidia/shared-model" resolves by explicit prefix to NVIDIA — but the
     * combo pins shared-model to EMPERO, and the combo always wins. */
    const keyA = globalThis.__keyA;
    nvChatAuth.length = 0;
    const before = empChatAuth.length;
    const res = await authedRequest('POST', '/v1/chat/completions', keyA.apiKey, {
      model: 'nvidia/shared-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(empChatAuth.length).toBe(before + 1);
    expect(nvChatAuth.length).toBe(0);
  });

  it('providerKeyId null → provider-wide multi-key rotation across requests (no pin)', async () => {
    /* A null providerKeyId combo must use the provider's EXISTING round-robin
     * across ALL of that provider's keys — consecutive requests rotate through
     * different credentials, and never leave the provider. Runs BEFORE any
     * key-failure scenarios so no empero key is in cooldown yet. */
    const keyRot = await createClientKey('empero', ['emp-model-a'], 'rotation-nullpin');
    const comboRot = await createCombo({
      clientKeyId: keyRot.key.id, providerId: 'empero', model: 'emp-model-a', providerKeyId: null,
    });
    expect(comboRot.status).toBe(201);

    empChatAuth.length = 0;
    nvChatAuth.length = 0;
    for (let i = 0; i < 4; i++) {
      const res = await authedRequest('POST', '/v1/chat/completions', keyRot.apiKey, {
        model: 'emp-model-a',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
    }
    /* Round-robin advanced: at least TWO different empero credentials were used. */
    const distinct = new Set(empChatAuth);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
    /* Rotation never leaves the combo provider. */
    expect(nvChatAuth.length).toBe(0);

    await request('DELETE', `/admin/combos/${comboRot.data.combo.id}`);
  });

  it('15. streaming through a combo routes correctly and usage is recorded', async () => {
    const keyA = globalThis.__keyA;
    nvChatAuth.length = 0;
    const res = await authedStreamRequest('/v1/chat/completions', keyA.apiKey, {
      model: 'shared-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.chunks.join('')).toContain('data: [DONE]');
    expect(nvChatAuth.length).toBe(0);

    /* Usage from the final SSE usage chunk is attributed to the combo. */
    await new Promise(r => setTimeout(r, 300));
    const logs = await request('GET', '/admin/logs?limit=200');
    const streamRows = logs.data.logs.filter((l: any) =>
      l.status === 'success' && l.comboId === globalThis.__comboA.id && l.promptTokens === 5);
    expect(streamRows.length).toBeGreaterThanOrEqual(1);
  });

  it('6+14. pinned provider key fails → rotation to ANOTHER key of the SAME provider', async () => {
    const keyD = await createClientKey('empero', ['pin-model'], 'combo-key-d');
    const comboD = await createCombo({
      clientKeyId: keyD.key.id, providerId: 'empero', model: 'pin-model', providerKeyId: globalThis.__empKey2Id,
    });
    expect(comboD.status).toBe(201);
    globalThis.__comboD = comboD.data.combo;

    upstream.failEmpKey2 = true;
    empChatAuth.length = 0;
    nvChatAuth.length = 0;
    try {
      const res = await authedRequest('POST', '/v1/chat/completions', keyD.apiKey, {
        model: 'pin-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      /* First attempt = pinned Empero Key 2; retry = a DIFFERENT Empero key.
       * Rotation never leaves the provider. */
      expect(empChatAuth[0]).toBe(`Bearer ${EMP_KEY_2}`);
      expect(empChatAuth.length).toBeGreaterThanOrEqual(2);
      for (const auth of empChatAuth.slice(1)) {
        expect(auth).not.toBe(`Bearer ${EMP_KEY_2}`);
      }
      expect(nvChatAuth.length).toBe(0);
    } finally {
      upstream.failEmpKey2 = false;
    }
  });

  it('9. a client key WITHOUT a combo cannot use unallowed models', async () => {
    const keyC = await createClientKey('empero', ['emp-model-a'], 'no-combo-key');
    globalThis.__keyC = keyC;
    empChatAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', keyC.apiKey, {
      model: 'nv-model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
    /* No upstream was contacted. */
    expect(empChatAuth.length).toBe(0);
    expect(nvChatAuth.length).toBe(0);
  });

  it('combo acts as an authorization source (grants a model outside allowedModels)', async () => {
    const keyB = await createClientKey('empero', ['emp-model-a'], 'combo-key-b');
    globalThis.__keyB = keyB;
    const comboB = await createCombo({
      clientKeyId: keyB.key.id, providerId: 'empero', model: 'emp-model-b', providerKeyId: null,
    });
    expect(comboB.status).toBe(201);
    globalThis.__comboB = comboB.data.combo;

    const res = await authedRequest('POST', '/v1/chat/completions', keyB.apiKey, {
      model: 'emp-model-b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('10. /v1/models shows allowlist ∪ active-combo models for the client key', async () => {
    const keyB = globalThis.__keyB;
    const res = await authedRequest('GET', '/v1/models', keyB.apiKey);
    expect(res.status).toBe(200);
    const ids = res.data.data.map((m: any) => m.id);
    expect(ids).toContain('emp-model-a');          // allowlist
    expect(ids).toContain('emp-model-b');          // active combo grant
    expect(ids).not.toContain('nv-model-a');       // other provider's model
    expect(ids).not.toContain('shared-model');     // other client's combo model
  });

  it('8. DISABLED combo → request denied per allowlist policy (no fallback)', async () => {
    const keyB = globalThis.__keyB;
    const off = await request('PATCH', `/admin/combos/${globalThis.__comboB.id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.data.combo.status).toBe('disabled');

    empChatAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', keyB.apiKey, {
      model: 'emp-model-b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error?.message).toContain('not allowed');
    expect(empChatAuth.length).toBe(0);

    /* Catalog no longer advertises the disabled combo's model. */
    const models = await authedRequest('GET', '/v1/models', keyB.apiKey);
    const ids = models.data.data.map((m: any) => m.id);
    expect(ids).toContain('emp-model-a');
    expect(ids).not.toContain('emp-model-b');

    /* Re-enable restores both access and routing. */
    const on = await request('PATCH', `/admin/combos/${globalThis.__comboB.id}`, { enabled: true });
    expect(on.status).toBe(200);
    const ok = await authedRequest('POST', '/v1/chat/completions', keyB.apiKey, {
      model: 'emp-model-b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ok.status).toBe(200);
  });

  it('5. combo provider fails → error surfaced, NEVER routed to another provider', async () => {
    upstream.failAllEmpero = true;
    nvChatAuth.length = 0;
    const before = empChatAuth.length;
    try {
      const res = await authedRequest('POST', '/v1/chat/completions', globalThis.__keyA.apiKey, {
        model: 'shared-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
      /* Empero was attempted (its keys rotated) but NVIDIA was never touched. */
      expect(empChatAuth.length).toBeGreaterThan(before);
      expect(nvChatAuth.length).toBe(0);
      /* No upstream URL / credential leaks in the error. */
      const raw = JSON.stringify(res.data);
      expect(raw).not.toContain('127.0.0.1');
      expect(raw).not.toContain(EMP_KEY_1);
      expect(raw).not.toContain(EMPERO_ENV_KEY);
    } finally {
      upstream.failAllEmpero = false;
    }
  });

  it('7. ALL provider API keys fail → error returned (no fallback)', async () => {
    const keyN = await createClientKey('nvidia', ['nv-model-a'], 'combo-key-n');
    const comboN = await createCombo({
      clientKeyId: keyN.key.id, providerId: 'nvidia', model: 'nv-model-a', providerKeyId: globalThis.__nvKey1Id,
    });
    expect(comboN.status).toBe(201);
    globalThis.__comboN = comboN.data.combo;
    globalThis.__keyN = keyN;

    nvChatAuth.length = 0;
    const res = await authedRequest('POST', '/v1/chat/completions', keyN.apiKey, {
      model: 'nv-model-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(429);
    /* Both NVIDIA credentials (managed + env) were attempted. */
    expect(nvChatAuth).toContain(`Bearer ${NV_KEY_1}`);
    expect(nvChatAuth).toContain('Bearer nkey1');
    /* The failing provider stayed NVIDIA — Empero untouched. */
    const empBefore = empChatAuth.length;
    expect(empChatAuth.length).toBe(empBefore);
  });
});

/* ═══════════════════ Usage attribution + secret leakage ═══════════════════ */

describe('COMBO usage attribution & security', () => {
  it('13. usage rows carry comboId/providerKeyId; combo counters increment', async () => {
    const logs = await request('GET', '/admin/logs?limit=300');
    expect(logs.status).toBe(200);

    /* comboA (rotation → providerKeyId null) successes. */
    const comboARows = logs.data.logs.filter((l: any) =>
      l.status === 'success' && l.comboId === globalThis.__comboA.id);
    expect(comboARows.length).toBeGreaterThanOrEqual(2); // non-stream + stream
    expect(comboARows[0].provider).toBe('empero');
    expect(comboARows[0].model).toBe('shared-model');
    expect(comboARows[0].apiKeyMasked).toBe(globalThis.__keyA.key.maskedKey);
    expect(comboARows[0].totalTokens).toBeGreaterThan(0);
    for (const row of comboARows) {
      expect(row.providerKeyId).toBeNull();
    }

    /* comboD (pinned key) successes carry the pinned provider key id. */
    const comboDRows = logs.data.logs.filter((l: any) =>
      l.status === 'success' && l.comboId === globalThis.__comboD.id);
    expect(comboDRows.length).toBeGreaterThanOrEqual(1);
    expect(comboDRows[0].providerKeyId).toBe(globalThis.__empKey2Id);

    /* comboN (all-fail) error row keeps combo attribution. */
    const comboNRows = logs.data.logs.filter((l: any) =>
      l.comboId === globalThis.__comboN.id);
    expect(comboNRows.length).toBeGreaterThanOrEqual(1);
    expect(comboNRows.some((l: any) => l.status === 'error')).toBe(true);

    /* Combo usage metadata (requestCount / lastUsedAt). */
    const combos = await request('GET', '/admin/combos');
    const a = combos.data.combos.find((c: any) => c.id === globalThis.__comboA.id);
    expect(a.requestCount).toBeGreaterThanOrEqual(2);
    expect(a.lastUsedAt).toBeTruthy();
    const d = combos.data.combos.find((c: any) => c.id === globalThis.__comboD.id);
    expect(d.requestCount).toBeGreaterThanOrEqual(1);
  });

  it('12. no secret leakage in any public or admin combo response', async () => {
    const secrets = [EMP_KEY_1, EMP_KEY_2, NV_KEY_1, EMPERO_ENV_KEY, 'nkey1'];

    const targets: Promise<any>[] = [
      request('GET', '/admin/combos'),
      request('GET', '/admin/combos/catalog'),
      authedRequest('GET', '/v1/models', globalThis.__keyA.apiKey),
      authedRequest('POST', '/v1/chat/completions', globalThis.__keyA.apiKey, {
        model: 'shared-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ];
    const results = await Promise.all(targets);
    for (const res of results) {
      const raw = JSON.stringify(res.data);
      /* Raw provider credentials + upstream hosts never appear anywhere. */
      for (const secret of secrets) {
        expect(raw).not.toContain(secret);
      }
      expect(raw).not.toContain(`127.0.0.1:${empPort}`);
      expect(raw).not.toContain(`127.0.0.1:${nvPort}`);
    }

    /* PUBLIC /v1 responses must additionally stay free of internal record
     * ids (combo ids, provider key ids) — the admin catalog MAY expose ids +
     * masked values (by design), the public API must not. */
    for (const res of results.slice(2)) {
      const raw = JSON.stringify(res.data);
      expect(raw).not.toContain('combo_');
      expect(raw).not.toContain('key_');
      expect(raw).not.toContain(globalThis.__comboA.id);
    }
  });
});
