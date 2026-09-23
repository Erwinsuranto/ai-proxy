/**
 * FULL INTEGRATION: Key Management → KeyManager rotation → Provider Request
 * → Usage → Pricing/Cost → Aggregation → Dashboard — plus live key deletion
 * during rotation, all-keys-removed fallback to env keys, and restart.
 *
 * Deterministic reconciliation dataset (spec #11):
 *   Request A: input=100  output=50   → tokens 150
 *   Request B: input=200  output=100  → tokens 300
 *   Totals:    input=300 output=150  total=450
 *   Pricing (set via admin API): $1/1M in · $2/1M out →
 *     A: $0.0001 + $0.0001 = $0.0002
 *     B: $0.0002 + $0.0002 = $0.0004
 *     SUM  = $0.0006  (must equal aggregation AND dashboard totals)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const KEYS_FILE = configFile('provider-api-keys.json');
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');
const PRICING_FILE = configFile('model-pricing.json');

const MODEL = 'e2e/int-model';
const KEY_A = 'int-key-aaaa';
const KEY_B = 'int-key-bbbb';
const KEY_C = 'int-key-cccc';
/* exact prices for the reconciliation dataset */
const PRICE_IN = 1; // $ / 1M input tokens
const PRICE_OUT = 2; // $ / 1M output tokens

let mockUsage = { prompt_tokens: 100, completion_tokens: 50 };
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
      usage: mockUsage,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

async function chat(): Promise<number> {
  const res = await request('POST', '/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
  });
  return res.status;
}

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE, PRICING_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    OPENROUTER_API_KEY: 'okey1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
  const p = await request('POST', '/admin/pricing', {
    providerId: 'openrouter', model: MODEL, inputPerM: PRICE_IN, outputPerM: PRICE_OUT,
  });
  expect([200, 201]).toContain(p.status);
  for (const k of [KEY_A, KEY_B, KEY_C]) {
    const r = await request('POST', '/admin/providers/openrouter/api-keys', { apiKey: k });
    expect(r.status).toBe(201);
  }
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER.close();
  for (const f of [KEYS_FILE, USAGE_FILE, STATE_FILE, PRICING_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('Rotation → Usage → Cost → Dashboard reconciliation (#2,#7-#11)', () => {
  it('requests A & B succeed via rotated keys and produce correct usage records', async () => {
    receivedAuth.length = 0;
    mockUsage = { prompt_tokens: 100, completion_tokens: 50 };
    expect(await chat()).toBe(200);          // A
    mockUsage = { prompt_tokens: 200, completion_tokens: 100 };
    expect(await chat()).toBe(200);          // B

    // both requests were served by openrouter with DIFFERENT rotation keys,
    // every one of them belonging to this provider's pool
    expect(receivedAuth.length).toBe(2);
    expect(new Set(receivedAuth).size).toBe(2);
    const pool = new Set(['okey1', KEY_A, KEY_B, KEY_C]);
    for (const k of receivedAuth) expect(pool.has(k)).toBe(true);

    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=10`)).data.logs;
    const recA = logs.find((r: any) => r.promptTokens === 100 && r.completionTokens === 50);
    const recB = logs.find((r: any) => r.promptTokens === 200 && r.completionTokens === 100);
    for (const [rec, cost] of [[recA, 0.0002], [recB, 0.0004]] as const) {
      expect(rec).toBeDefined();
      expect(rec.provider).toBe('openrouter');
      expect(rec.model).toBe(MODEL);
      expect(rec.status).toBe('success');
      expect(rec.httpStatus).toBe(200);
      expect(rec.totalTokens).toBe(rec.promptTokens + rec.completionTokens); // no double count
      expect(rec.costUsd).toBeCloseTo(cost, 12);
      expect(rec.inputCostUsd).toBeCloseTo(cost / 2, 12);
      expect(rec.outputCostUsd).toBeCloseTo(cost / 2, 12);
      expect(typeof rec.timestamp).toBe('number');
    }
    /* no raw upstream key material anywhere in the log payload (#13) */
    const blob = JSON.stringify(logs);
    for (const secret of [KEY_A, KEY_B, KEY_C, 'okey1']) expect(blob).not.toContain(secret);
  }, 30000);

  it('aggregation == SUM(records): 300 in / 150 out / 450 total / $0.0006 (#11)', async () => {
    const agg = (await request('GET', '/admin/usage')).data;
    expect(agg.totalPromptTokens).toBe(300);
    expect(agg.totalCompletionTokens).toBe(150);
    expect(agg.totalTokens).toBe(450);
    expect(agg.totalSuccess).toBe(2);
    expect(agg.totalFailed + agg.totalBlocked).toBe(0);
    expect(agg.totalCostUsd).toBeCloseTo(0.0006, 12);
    expect(agg.totalInputCostUsd).toBeCloseTo(0.0003, 12);
    expect(agg.totalOutputCostUsd).toBeCloseTo(0.0003, 12);

    const byProv = (await request('GET', '/admin/usage/providers')).data.openrouter;
    expect(byProv.costUsd).toBeCloseTo(0.0006, 12);

    const byModel = (await request('GET', '/admin/usage/models')).data[`openrouter/${MODEL}`];
    expect(byModel.costUsd).toBeCloseTo(0.0006, 12);
    expect(byModel.pricingStatus).toBe('known'); // exact provider+model pricing used
  }, 20000);
});

describe('Delete a managed key while it is inside the rotation (#3)', () => {
  it('removed key disappears from store & rotation; requests keep succeeding', async () => {
    const list = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(list.keys.length).toBe(3);
    const victim = list.keys.find((k: any) => k.maskedKey.endsWith('aaaa'));
    const del = await request(
      'DELETE',
      `/admin/providers/openrouter/api-keys/${encodeURIComponent(victim.id)}`,
    );
    expect(del.status).toBe(200);

    // storage count dropped
    const after = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(after.keys.length).toBe(2);

    // 6 subsequent requests: never the deleted key, no crash, all succeed
    receivedAuth.length = 0;
    mockUsage = { prompt_tokens: 10, completion_tokens: 5 };
    for (let i = 0; i < 6; i++) expect(await chat()).toBe(200);
    expect(receivedAuth.length).toBe(6);
    for (const k of receivedAuth) {
      expect(k).not.toBe(KEY_A);
      expect(['okey1', KEY_B, KEY_C]).toContain(k);
    }
    expect(new Set(receivedAuth).size).toBe(3); // remaining pool fully cycled
  }, 30000);
});

describe('Delete ALL managed keys → env key behavior intact (#5)', () => {
  it('provider still works on env keys; counts stay separated', async () => {
    const list = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    for (const k of list.keys) {
      const d = await request('DELETE', `/admin/providers/openrouter/api-keys/${encodeURIComponent(k.id)}`);
      expect(d.status).toBe(200);
    }
    const empty = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(empty.keys.length).toBe(0);       // no managed keys left
    expect(empty.envKeyCount).toBe(1);       // env seed untouched — NOT merged into managed

    receivedAuth.length = 0;
    expect(await chat()).toBe(200);          // env key still serves requests
    expect(receivedAuth[receivedAuth.length - 1]).toBe('okey1');

    const providers = (await request('GET', '/admin/providers')).data;
    expect(providers.find((p: any) => p.id === 'openrouter').apiKeyCount).toBe(0);
  }, 20000);
});

describe('Restart persistence of the whole chain (#12)', () => {
  it('usage/cost/tokens survive; key state & provider state consistent after reboot', async () => {
    /* wait for the periodic flush so the disk copy is complete */
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (fs.existsSync(USAGE_FILE)) {
        const n = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))
          .filter((r: any) => r.model === MODEL).length;
        if (n >= 9) break; // 2 + 6 + 1 records
      }
      await new Promise(r => setTimeout(r, 500));
    }

    const before = {
      agg: (await request('GET', '/admin/usage')).data,
      keys: (await request('GET', '/admin/providers/openrouter/api-keys')).data,
    };
    await stopServer();
    await startServer({
      NVIDIA_API_KEYS: 'nkey1',
      OPENROUTER_API_KEY: 'okey1',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });

    const afterAgg = (await request('GET', '/admin/usage')).data;
    expect(afterAgg.totalPromptTokens).toBe(before.agg.totalPromptTokens);
    expect(afterAgg.totalCompletionTokens).toBe(before.agg.totalCompletionTokens);
    expect(afterAgg.totalTokens).toBe(before.agg.totalTokens);
    expect(afterAgg.totalRequests).toBe(before.agg.totalRequests);
    expect(afterAgg.totalCostUsd ?? null).toBe(before.agg.totalCostUsd ?? null);

    const afterKeys = (await request('GET', '/admin/providers/openrouter/api-keys')).data;
    expect(afterKeys.keys.length).toBe(before.keys.keys.length); // deleted keys stay deleted
    expect(afterKeys.envKeyCount).toBe(1);

    // rotation still functional after reboot (env key serves next request)
    receivedAuth.length = 0;
    expect(await chat()).toBe(200);
    expect(receivedAuth[0]).toBe('okey1');
  }, 40000);
});
