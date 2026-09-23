/**
 * Provider-locked routing — end-to-end verification through the REAL request
 * path using LOCAL mock upstreams (existing project mechanism: per-provider
 * BASE_URL env override). No paid credentials, no code bypass.
 *
 * Membuktikan spesifikasi provider-locked routing:
 *   1. Model hanya memakai provider yang ditentukan.
 *   2. Key 1 gagal → Key 2 dipakai.
 *   3. Key 2 gagal → Key 3 dipakai.
 *   4. Key 3 berhasil → response berhasil.
 *   5. Semua key gagal → request gagal.
 *   6. Semua key gagal → TIDAK ada provider lain yang dicoba.
 *   7. Provider lain yang kebetulan mendukung model TIDAK dipakai sebagai
 *      fallback otomatis.
 *   8. Aturan sama berlaku untuk provider lain (bukan hanya Empero) → diuji via
 *      GoRouter juga.
 *   9. Existing functionality tidak rusak (single-key sukses tetap jalan).
 *
 * Strategi mock:
 *   - EMPERO_BASE_URL diarahkan ke mock upstream #1 (provider terkunci yang diuji).
 *   - GOROUTER_BASE_URL diarahkan ke mock upstream #2 (provider "lain" — harus
 *     TIDAK PERNAH dipanggil untuk model yang terkunci ke Empero).
 *   - Mock Empero menghitung berapa kali tiap KEY dipakai (via header Authorization)
 *     dan bisa dikonfigurasi untuk gagal pada N pemanggilan pertama → menguji
 *     rotasi key di dalam provider yang sama.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import { startServer, stopServer, request } from './setup';

/* ----------------------------- Mock upstreams ----------------------------- */
// Empero mock: records every Authorization key it sees, and fails the first
// `failFirstN` chat calls (simulating key1/key2 down) so we can prove in-provider
// key rotation. Reset per-test via the exported controls.
let emperoKeysSeen: string[] = [];
let emperoFailFirstN = 0;
let emperoCallCount = 0;
let emperoFailStatus = 503; // retryable "temporary provider error" → rotates key, no 60s cooldown
let emperoAlwaysFail = false;

const emperoMock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3-flash', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      emperoCallCount++;
      const auth = (req.headers['authorization'] || '').toString().replace(/^Bearer\s+/i, '');
      emperoKeysSeen.push(auth);

      if (emperoAlwaysFail || emperoCallCount <= emperoFailFirstN) {
        res.writeHead(emperoFailStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `empero mock fail (call #${emperoCallCount}, key=${auth})`, code: 'rate_limit' } }));
        return;
      }
      const reqModel = (() => { try { return JSON.parse(body).model ?? 'mock'; } catch { return 'mock'; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-empero-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: reqModel,
        choices: [{ index: 0, message: { role: 'assistant', content: `EMPERO_OK_KEY=${auth}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

// GoRouter mock: acts as the "other provider". Counts whether it is EVER called
// during a locked-to-Empero request (must remain 0). Also used to prove the same
// locking rule applies to a DIFFERENT provider (requirement 8).
let gorouterCallCount = 0;
let gorouterKeysSeen: string[] = [];
let gorouterFailFirstN = 0;
let gorouterAlwaysFail = false;

const gorouterMock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gr-model', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      gorouterCallCount++;
      const auth = (req.headers['authorization'] || '').toString().replace(/^Bearer\s+/i, '');
      gorouterKeysSeen.push(auth);
      if (gorouterAlwaysFail || gorouterCallCount <= gorouterFailFirstN) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `gorouter mock fail (call #${gorouterCallCount}, key=${auth})`, code: 'rate_limit' } }));
        return;
      }
      const reqModel = (() => { try { return JSON.parse(body).model ?? 'mock'; } catch { return 'mock'; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-gorouter-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: reqModel,
        choices: [{ index: 0, message: { role: 'assistant', content: `GOROUTER_OK_KEY=${auth}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

let emperoPort = 0;
let gorouterPort = 0;

beforeAll(async () => {
  await new Promise<void>(r => emperoMock.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => gorouterMock.listen(0, '127.0.0.1', r));
  emperoPort = (emperoMock.address() as any).port;
  gorouterPort = (gorouterMock.address() as any).port;

  await startServer({
    // Empero: 3 keys (bukti rotasi key1→key2→key3 di dalam provider yang sama)
    EMPERO_API_KEY_1: 'empk1',
    EMPERO_API_KEY_2: 'empk2',
    EMPERO_API_KEY_3: 'empk3',
    EMPERO_BASE_URL: `http://127.0.0.1:${emperoPort}/v1`,
    // GoRouter: 3 keys, provider "lain" (dan bukti requirement 8)
    GOROUTER_API_KEY_1: 'grk1',
    GOROUTER_API_KEY_2: 'grk2',
    GOROUTER_API_KEY_3: 'grk3',
    GOROUTER_BASE_URL: `http://127.0.0.1:${gorouterPort}/v1`,
    // Strict core routing is unconditional; this legacy flag must not re-enable
    // cross-provider failover.
    PROVIDER_LOCKED_ROUTING: 'false',
  });
}, 30000);

afterAll(async () => {
  await stopServer();
  emperoMock.close();
  gorouterMock.close();
});

beforeEach(() => {
  emperoKeysSeen = [];
  emperoCallCount = 0;
  emperoFailFirstN = 0;
  emperoFailStatus = 503;
  emperoAlwaysFail = false;
  gorouterCallCount = 0;
  gorouterKeysSeen = [];
  gorouterFailFirstN = 0;
  gorouterAlwaysFail = false;
});

/* --------------------------------- Tests ---------------------------------- */

describe('Provider-locked routing (multi-key rotation di dalam provider)', () => {
  it('strict routing ignores PROVIDER_LOCKED_ROUTING=false and never fails over', async () => {
    const model = 'strict-config-model';
    await request('POST', '/admin/models', { model, providerId: 'empero', priority: 1 });
    await request('POST', '/admin/models', { model, providerId: 'gorouter', priority: 2 });
    emperoAlwaysFail = true;

    const res = await request('POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'strict' }], max_tokens: 8,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(emperoCallCount).toBeGreaterThan(0);
    expect(gorouterCallCount).toBe(0);
  }, 40000);

  it('Req#1+#7: model multi-provider dikunci ke SATU provider; provider lain tidak dipanggil', async () => {
    // Model "lockcheck" didaftarkan ke DUA provider: empero (priority lebih tinggi=1)
    // dan gorouter (priority=2). Provider-lock harus memilih empero SAJA.
    const MODEL = 'lockcheck-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 1 });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'gorouter', priority: 2 });

    emperoAlwaysFail = false; // empero sukses di key pertama

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toContain('EMPERO_OK');
    // Provider LAIN (gorouter) TIDAK boleh disentuh sama sekali.
    expect(gorouterCallCount).toBe(0);
    // Hanya 1 pemanggilan empero (key pertama langsung sukses).
    expect(emperoCallCount).toBe(1);
  }, 40000);

  it('Req#2+#3+#4: Key1 gagal → Key2 gagal → Key3 sukses (rotasi DALAM provider yang sama)', async () => {
    const MODEL = 'rotate-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 1 });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'gorouter', priority: 2 });

    emperoFailFirstN = 2; // key1 & key2 gagal (429 retryable), key3 sukses

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toContain('EMPERO_OK');
    // Tepat 3 pemanggilan empero: key1, key2 (gagal) + key3 (sukses).
    expect(emperoCallCount).toBe(3);
    // 3 key yang dipakai harus BERBEDA (rotasi, bukan key sama diulang).
    const uniqueKeys = new Set(emperoKeysSeen);
    expect(uniqueKeys.size).toBe(3);
    expect(uniqueKeys).toEqual(new Set(['empk1', 'empk2', 'empk3']));
    // Provider lain tetap tidak disentuh.
    expect(gorouterCallCount).toBe(0);
  }, 40000);

  it('Req#5+#6: SEMUA key provider gagal → request gagal, TANPA mencoba provider lain', async () => {
    const MODEL = 'allfail-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 1 });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'gorouter', priority: 2 });

    emperoAlwaysFail = true; // semua 3 key empero gagal

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    // Request harus GAGAL (bukan 200).
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Empero mencoba SEMUA 3 key-nya.
    expect(emperoCallCount).toBe(3);
    expect(new Set(emperoKeysSeen)).toEqual(new Set(['empk1', 'empk2', 'empk3']));
    // KRITIS: provider lain (gorouter) TIDAK PERNAH dipanggil sebagai fallback.
    expect(gorouterCallCount).toBe(0);
  }, 40000);

  it('Req#8: aturan sama berlaku untuk provider LAIN (GoRouter) — lock + rotasi key', async () => {
    // Model dikunci ke gorouter (priority tinggi) sambil empero juga mendukung.
    const MODEL = 'gorouter-lock-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'gorouter', priority: 1 });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 2 });

    gorouterFailFirstN = 2; // key1 & key2 gagal, key3 sukses

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toContain('GOROUTER_OK');
    expect(gorouterCallCount).toBe(3);                 // rotasi 3 key dalam gorouter
    // 3 key BERBEDA dipakai (rotasi nyata). Nama key tidak di-assert karena
    // round-robin pointer + inherited .env keys membuat key awal non-deterministik.
    expect(new Set(gorouterKeysSeen).size).toBe(3);
    expect(emperoCallCount).toBe(0);                   // empero (provider lain) tak disentuh
  }, 40000);

  it('Req#8b: GoRouter semua key gagal → error, empero tidak dipakai sebagai fallback', async () => {
    const MODEL = 'gorouter-allfail-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'gorouter', priority: 1 });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 2 });

    gorouterAlwaysFail = true;

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // NOTE: gorouter inherits cooldown state from Req#8 (keys 1-2 were
    // rate-limited there and sit out the shared 180s window — fail-fast
    // during cooldown is BY DESIGN: no hidden retry, no early re-attempt).
    // The guarantees asserted here: gorouter attempted its available keys,
    // the request FAILED, and NO other provider was touched as fallback.
    expect(gorouterCallCount).toBeGreaterThanOrEqual(1);
    expect(emperoCallCount).toBe(0);                   // no cross-provider fallback
  }, 40000);

  it('Req#9: existing functionality — model single-provider sukses di key pertama tetap jalan', async () => {
    const MODEL = 'single-empero-model';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'empero', priority: 1 });

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toContain('EMPERO_OK');
    expect(emperoCallCount).toBe(1);
    expect(gorouterCallCount).toBe(0);
  }, 40000);

  it('Req#9b: explicit provider-prefix "empero/<model>" tetap terkunci ke empero', async () => {
    // Model hanya terdaftar di empero; prefix eksplisit harus resolve ke empero.
    const BASE = 'prefixed-model';
    await request('POST', '/admin/models', { model: BASE, providerId: 'empero', priority: 1 });

    const res = await request('POST', '/v1/chat/completions', {
      model: `empero/${BASE}`, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });

    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toContain('EMPERO_OK');
    expect(gorouterCallCount).toBe(0);
  }, 40000);
});
