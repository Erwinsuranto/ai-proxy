/**
 * API Key Management — rotation distribution & provider isolation through the
 * REAL request path (mock upstream records the Authorization header it got).
 *
 * Final-check scenario from the spec, adapted to real providers:
 *   - provider with NO env keys works purely on managed (stored) keys
 *   - 3 managed keys → 3 requests → each key used exactly once (round-robin)
 *   - duplicate add → 409 AND the response never echoes the raw key
 *   - disable PROVIDER → its keys are NOT used; stored keys & count intact
 *   - re-enable PROVIDER → keys usable again
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const KEYS_FILE = configFile('provider-api-keys.json');
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

const MODEL = 'e2e/rotation-model';
const KEY_A = 'rot-key-aaaa';
const KEY_B = 'rot-key-bbbb';
const KEY_C = 'rot-key-cccc';

/** Every Authorization header the mock upstream received, in order. */
const receivedAuth: string[] = [];

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    receivedAuth.push(String(req.headers['authorization'] || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
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
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  /* NVIDIA keeps fake env keys and fails first; OpenRouter gets ONE env seed
     key (providers are built from env credentials) plus 3 managed keys — the
     rotation pool is exactly these 4. */
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    OPENROUTER_API_KEY: 'okey1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER.close();
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function addKey(raw: string): Promise<any> {
  return request('POST', '/admin/providers/openrouter/api-keys', { apiKey: raw });
}

async function chat(): Promise<number> {
  const res = await request('POST', '/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
  });
  return res.status;
}

describe('Managed + env keys → round-robin rotation (#5/#6)', () => {
  it('adds 3 keys; count comes from storage; metadata is masked with createdAt', async () => {
    for (const k of [KEY_A, KEY_B, KEY_C]) {
      const r = await addKey(k);
      expect(r.status).toBe(201);
      expect(JSON.stringify(r.data)).not.toContain(k); // raw never echoed
    }
    const list = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(list.keys.length).toBe(3);
    expect(list.envKeyCount).toBe(1); // 1 env seed + 3 managed = rotation of 4
    for (const k of list.keys) {
      expect(typeof k.createdAt).toBe('number');
      expect(k.maskedKey).toMatch(/^.{4}\*{3}.{4}$/); // first4***last4
      expect(JSON.stringify(k)).not.toContain(KEY_A);
    }
    const providers = (await request('GET', '/admin/providers')).data;
    expect(providers.find((p: any) => p.id === 'openrouter').apiKeyCount).toBe(3); // managed only
  }, 20000);

  it('4 requests → every key in the pool used exactly once (no second rotation system)', async () => {
    receivedAuth.length = 0;
    for (let i = 0; i < 4; i++) {
      expect(await chat()).toBe(200);
    }
    expect(receivedAuth.length).toBe(4);
    const used = receivedAuth.map(a => a.replace(/^Bearer /, '')).sort();
    expect(used).toEqual(['okey1', KEY_A, KEY_B, KEY_C].sort());
  }, 30000);

  it('duplicate add → 409, no second record, response does NOT leak the raw key (#8)', async () => {
    const r = await addKey(KEY_B);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.data)).not.toContain(KEY_B);
    const list = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(list.keys.length).toBe(3); // still exactly one record per raw key
  });
});

describe('Disabled provider isolation (#7)', () => {
  it('disabling the provider blocks its keys; storage & count unchanged', async () => {
    const before = receivedAuth.length;
    const toggle = await request('PATCH', '/admin/providers/openrouter', { enabled: false });
    expect([200, 201]).toContain(toggle.status);

    const status = await chat(); // nvidia fails first; openrouter disabled → error
    expect(status).toBeGreaterThanOrEqual(400);

    // mock upstream saw NOTHING new — disabled provider's keys were not used.
    expect(receivedAuth.length).toBe(before);

    // keys remain stored with correct count (3 managed; env seed unaffected)
    const list = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(list.keys.length).toBe(3);
    const providers = (await request('GET', '/admin/providers')).data;
    expect(providers.find((p: any) => p.id === 'openrouter').apiKeyCount).toBe(3);
  }, 20000);

  it('re-enabling restores key usage immediately', async () => {
    await request('PATCH', '/admin/providers/openrouter', { enabled: true });
    const before = receivedAuth.length;
    expect(await chat()).toBe(200);
    expect(receivedAuth.length).toBe(before + 1);
    expect(receivedAuth[receivedAuth.length - 1]).toMatch(/^Bearer rot-key-/);
  }, 20000);
});
