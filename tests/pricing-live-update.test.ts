/**
 * Pricing as the SINGLE source of cost — live-update verification through the
 * REAL request path (local mock upstream via existing OPENROUTER_BASE_URL env
 * override mechanism).
 *
 * Proves:
 *   pricing A -> request -> cost A   (stored, immutable afterwards)
 *   update to B (NO server restart) -> new request -> cost B
 *   disable -> new request SUCCEEDS with costUsd null (unknown, never $0)
 *   enable  -> new request -> cost B again
 *   dashboard totals == SUM(record costs) at every stage
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const PRICING_FILE = configFile('model-pricing.json');
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

const MODEL = 'e2e/live-model';

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
      /* deterministic REAL token numbers from upstream */
      usage: { prompt_tokens: 500_000, completion_tokens: 100_000, total_tokens: 600_000 },
    }));
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [PRICING_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    OPENROUTER_API_KEY: 'okey1', // legacy loader reads this var (numberedFirst=false)
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
}, 30000);

afterAll(async () => {
  await stopServer();
  MOCK_SERVER.close();
  for (const f of [PRICING_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function chat(): Promise<void> {
  const res = await request('POST', '/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
  });
  expect(res.status).toBe(200); // inference NEVER fails because of pricing
}

async function lastRecord(): Promise<any> {
  const r = await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=10`);
  return (r.data.logs || [])[0];
}

beforeAll(async () => {
  // Provider-locked routing: the model is pinned to openrouter (mock upstream).
  // (Previously this test relied on nvidia→openrouter cross-provider fallback,
  // which was intentionally removed. Registering only the mock provider keeps
  // the pricing/usage assertions valid under provider-locked routing.)
  await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
}, 30000);

describe('Pricing live updates drive cost of subsequent REAL requests (#11/#14)', () => {
  it('A ($1/$2): input=$0.50 output=$0.20 total=$0.70', async () => {
    const post = await request('POST', '/admin/pricing', {
      providerId: 'openrouter', model: MODEL, inputPerM: 1, outputPerM: 2,
    });
    expect(post.status).toBe(201);

    await chat();
    const rec = await lastRecord();
    expect(rec.provider).toBe('openrouter');
    expect(rec.model).toBe(MODEL);
    expect(rec.promptTokens).toBe(500_000);
    expect(rec.completionTokens).toBe(100_000);
    expect(rec.totalTokens).toBe(600_000);
    expect(rec.inputCostUsd).toBeCloseTo(0.5, 9);
    expect(rec.outputCostUsd).toBeCloseTo(0.2, 9);
    expect(rec.costUsd).toBeCloseTo(0.7, 9);
  }, 20000);

  it('B ($3/$4): NEW request uses the UPDATED price without restart; old record keeps cost A', async () => {
    const upd = await request('POST', '/admin/pricing', {
      providerId: 'openrouter', model: MODEL, inputPerM: 3, outputPerM: 4,
    });
    expect(upd.status).toBe(200);
    expect(upd.data.created).toBe(false);

    await chat();
    const fresh = await lastRecord();
    expect(fresh.costUsd).toBeCloseTo(1.9, 9); // 1.5 + 0.4 — NOT stale price A
    expect(fresh.inputCostUsd).toBeCloseTo(1.5, 9);
    expect(fresh.outputCostUsd).toBeCloseTo(0.4, 9);

    // Historical record is immutable: still priced with A even though B is active.
    const all = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=10`)).data.logs;
    const oldest = all[all.length - 1];
    expect(oldest.costUsd).toBeCloseTo(0.7, 9);
  }, 20000);

  it('disable: request SUCCEEDS, tokens stored, costUsd null (unknown ≠ free)', async () => {
    const patch = await request('PATCH', `/admin/pricing/${encodeURIComponent(`openrouter/${MODEL}`)}`, { enabled: false });
    expect(patch.status).toBe(200);

    await chat();
    const rec = await lastRecord();
    expect(rec.promptTokens).toBe(500_000);
    expect(rec.costUsd ?? null).toBeNull();     // N/A semantics preserved
    expect(rec.inputCostUsd ?? null).toBeNull();

    const agg = (await request('GET', '/admin/usage')).data;
    /* SUM(valid costUsd) = 0.70 + 1.90 + 0(null excluded) */
    expect(agg.totalCostUsd).toBeCloseTo(2.6, 9);
    expect(agg.totalTokens).toBe(3 * 600_000);
  }, 20000);

  it('re-enable: new request uses B again; dashboard total stays consistent', async () => {
    await request('PATCH', `/admin/pricing/${encodeURIComponent(`openrouter/${MODEL}`)}`, { enabled: true });

    await chat();
    const rec = await lastRecord();
    expect(rec.costUsd).toBeCloseTo(1.9, 9);

    const agg = (await request('GET', '/admin/usage')).data;
    expect(agg.totalCostUsd).toBeCloseTo(2.6 + 1.9, 9);

    const byProv = (await request('GET', '/admin/usage/providers')).data;
    expect(byProv.openrouter.costUsd).toBeCloseTo(0.7 + 1.9 + 1.9, 9);

    const byModel = (await request('GET', '/admin/usage/models')).data;
    expect(byModel[`openrouter/${MODEL}`].costUsd).toBeCloseTo(0.7 + 1.9 + 1.9, 9);
    expect(byModel[`openrouter/${MODEL}`].pricingStatus).toBe('known');
  }, 20000);
});
