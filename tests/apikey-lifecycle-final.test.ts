/**
 * FINAL end-to-end lifecycle: add → delete-during-rotation + disable-key →
 * re-enable → restart persistence (add/delete/disable state) → backup safety.
 *
 * Scenario (spec #7): pool = env 'okey1' + managed A/B/C.
 *   - delete A  (gone forever, even across restart)
 *   - disable B (stored & counted, but never selected)
 *   - C (+env) keeps serving; re-enabling B returns it to rotation instantly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile, TEST_CONFIG_DIR } from './setup';

const CONFIG_DIR = TEST_CONFIG_DIR;
const KEYS_FILE = configFile('provider-api-keys.json');
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

const MODEL = 'e2e/final-model';
const KEY_A = 'fin-key-aaaa';
const KEY_B = 'fin-key-bbbb';
const KEY_C = 'fin-key-cccc';

const receivedAuth: string[] = [];

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    receivedAuth.push(String(req.headers['authorization'] || '').replace(/^Bearer /, ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;
const ENV = {
  NVIDIA_API_KEYS: 'nkey1',
  OPENROUTER_API_KEY: 'okey1',
};

async function chat(): Promise<number> {
  const res = await request('POST', '/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
  });
  return res.status;
}

async function keysSnapshot() {
  return (await request('GET', '/admin/providers/openrouter/api-keys')).data;
}

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({ ...ENV, OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1` });
  await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER.close();
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('Lifecycle: delete + disable inside a live rotation (#3,#4,#7)', () => {
  let idA = '';
  let idB = '';

  it('setup: 3 managed keys added, all masked in list', async () => {
    for (const k of [KEY_A, KEY_B, KEY_C]) {
      expect((await request('POST', '/admin/providers/openrouter/api-keys', { apiKey: k })).status).toBe(201);
    }
    const s = await keysSnapshot();
    expect(s.keys.length).toBe(3);
    idA = s.keys.find((k: any) => k.maskedKey.endsWith('aaaa')).id;
    idB = s.keys.find((k: any) => k.maskedKey.endsWith('bbbb')).id;
  });

  it('delete A + disable B: counts respect semantics (#5)', async () => {
    expect((await request('DELETE', `/admin/providers/openrouter/api-keys/${encodeURIComponent(idA)}`)).status).toBe(200);
    expect((await request('PATCH', `/admin/providers/openrouter/api-keys/${encodeURIComponent(idB)}`, { enabled: false })).status).toBe(200);

    const s = await keysSnapshot();
    /* deleted key gone from storage… */
    expect(s.keys.some((k: any) => k.id === idA)).toBe(false);
    /* …disabled key STILL stored AND still counted as managed (#5) */
    expect(s.keys.length).toBe(2);
    const providers = (await request('GET', '/admin/providers')).data;
    expect(providers.find((p: any) => p.id === 'openrouter').apiKeyCount).toBe(2);
    const disabledRow = s.keys.find((k: any) => k.id === idB);
    expect(disabledRow.status).toBe('disabled');
  });

  it('requests only ever use env key or C — never the deleted nor the disabled key', async () => {
    receivedAuth.length = 0;
    for (let i = 0; i < 6; i++) expect(await chat()).toBe(200);
    expect(receivedAuth.length).toBe(6);
    for (const k of receivedAuth) {
      expect(k === 'okey1' || k === KEY_C).toBe(true); // no stale/deleted/disabled key
    }
    expect(new Set(receivedAuth)).toEqual(new Set(['okey1', KEY_C]));
  }, 30000);

  it('re-enable B → back into rotation instantly, no restart (#4)', async () => {
    await request('PATCH', `/admin/providers/openrouter/api-keys/${encodeURIComponent(idB)}`, { enabled: true });
    receivedAuth.length = 0;
    for (let i = 0; i < 6; i++) expect(await chat()).toBe(200);
    expect(new Set(receivedAuth)).toEqual(new Set(['okey1', KEY_B, KEY_C])); // A stays dead
  }, 30000);
});

describe('Restart persistence incl. delete + enabled state (#8)', () => {
  it('after reboot: A stays deleted, B stays enabled, C intact, raw never exposed', async () => {
    await stopServer();
    await startServer({ ...ENV, OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1` });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });

    const s = await keysSnapshot();
    expect(s.keys.length).toBe(2); // deletion persisted
    expect(s.keys.map((k: any) => k.status).sort()).toEqual(['active', 'active']);
    const blob = JSON.stringify(s);
    for (const secret of [KEY_A, KEY_B, KEY_C, 'okey1']) expect(blob).not.toContain(secret);

    // rotation functional after reboot and still excludes the long-deleted A
    receivedAuth.length = 0;
    for (let i = 0; i < 6; i++) expect(await chat()).toBe(200);
    for (const k of receivedAuth) expect(k === 'okey1' || k === KEY_B || k === KEY_C).toBe(true);
    expect(receivedAuth).not.toContain(KEY_A);
  }, 40000);

  it('DELETE persists across restart too — key does not resurrect (#8)', async () => {
    // delete B now, restart, verify still gone
    const s = await keysSnapshot();
    const idB2 = s.keys.find((k: any) => k.maskedKey.endsWith('bbbb')).id;
    await request('DELETE', `/admin/providers/openrouter/api-keys/${encodeURIComponent(idB2)}`);
    await stopServer();
    await startServer({ ...ENV, OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1` });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });

    const after = await keysSnapshot();
    expect(after.keys.length).toBe(1);
    expect(after.keys[0].maskedKey.endsWith('cccc')).toBe(true);
  }, 40000);
});

describe('Backup compatibility (#10)', () => {
  it('backup contains NO raw key material; restore does not fabricate credentials', async () => {
    const bk = await request('POST', '/admin/backup');
    expect([200, 201]).toContain(bk.status);
    const bdir = configFile('backups');
    const files = fs.readdirSync(bdir).map(f => path.join(bdir, f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const body = fs.readFileSync(f, 'utf-8');
      for (const secret of [KEY_A, KEY_B, KEY_C, 'okey1', 'nkey1']) {
        expect(body).not.toContain(secret);
      }
      // restore endpoint accepts the backup without inventing keys
      const restore = await request('POST', `/admin/backup/restore/${encodeURIComponent(bk.data.backupId)}`);
      expect([200, 201]).toContain(restore.status);
      break; // newest file only is enough for restore round-trip
    }
    // managed keys unchanged by restore (restore does not touch key store)
    const s = await keysSnapshot();
    expect(s.keys.length).toBe(1);
    // UI-primary contract: UI records exist → env seed retired from rotation
    expect(s.envKeyCount).toBe(0);
  }, 20000);
});
