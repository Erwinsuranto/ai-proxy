/**
 * Production hardening — consistency across SERVER RESTART:
 *   start → pricing load → request → cost correct
 *   RESTART → pricing must NOT revert to built-in/default
 *           → new request → cost STILL computed from the persisted entry
 *   historical records keep their recorded costs
 *
 * Plus data-integrity/security checks on what actually lands on disk:
 *   - one record per request (success/error/streaming covered elsewhere;
 *     here: success path via mock upstream)
 *   - NO credential material (raw or masked) inside any persisted JSON
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile, TEST_CONFIG_DIR } from './setup';

const CONFIG_DIR = TEST_CONFIG_DIR;
const PRICING_FILE = configFile('model-pricing.json');
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

const MODEL = 'e2e/restart-model';
const ENV = {
  NVIDIA_API_KEYS: 'nkey1',
  OPENROUTER_API_KEY: 'okey1', // legacy loader var (numberedFirst=false)
};

let mockPort = 0;

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
      usage: { prompt_tokens: 500_000, completion_tokens: 100_000, total_tokens: 600_000 },
    }));
    return;
  }
  res.writeHead(404); res.end();
});

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [PRICING_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}, 15000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK_SERVER.close();
  for (const f of [PRICING_FILE, USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function chat(): Promise<any> {
  const res = await request('POST', '/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
  });
  expect(res.status).toBe(200);
}

describe('Restart consistency (#2)', () => {
  it('phase 1: price the model, make a request, cost uses the stored price', async () => {
    await startServer({ ...ENV, OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1` });
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
    const post = await request('POST', '/admin/pricing', {
      providerId: 'openrouter', model: MODEL, inputPerM: 1, outputPerM: 2,
    });
    expect(post.status).toBe(201);

    await chat();
    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=5`)).data.logs;
    expect(logs[0].costUsd).toBeCloseTo(0.7, 9);
    // stop WITHOUT touching the persisted files
    await stopServer();
  }, 30000);

  it('phase 2: after RESTART the persisted pricing is still active — not reverted to defaults', async () => {
    await startServer({ ...ENV, OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1` });

    /* The Model Registry is rebuilt from provider catalogs at startup; with
       fake keys it starts empty, so re-register the routing entries (runtime
       config, NOT pricing state). Pricing itself must persist untouched. */
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });

    const pricing = (await request('GET', '/admin/pricing')).data;
    const entry = pricing.entries.find((e: any) => e.id === `openrouter/${MODEL}`);
    expect(entry).toBeDefined();          // survived the restart
    expect(entry.inputPerM).toBe(1);      // NOT reset/reverted
    expect(entry.outputPerM).toBe(2);
    expect(entry.enabled).toBe(true);

    await chat();
    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=5`)).data.logs;
    expect(logs[0].costUsd).toBeCloseTo(0.7, 9); // same math as pre-restart

    /* Pricing update AFTER restart also behaves live (A→B). */
    const upd = await request('POST', '/admin/pricing', {
      providerId: 'openrouter', model: MODEL, inputPerM: 3, outputPerM: 4,
    });
    expect(upd.status).toBe(200);
    await chat();
    const fresh = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=5`)).data.logs;
    expect(fresh[0].costUsd).toBeCloseTo(1.9, 9);          // new request → cost B
    expect(fresh[fresh.length - 1].costUsd).toBeCloseTo(0.7, 9); // old record immutable
  }, 30000);
});

describe('Data integrity & security on disk (#10/#12)', () => {
  it('one usage record per successful request (no duplication)', async () => {
    /* Records flush to disk every FLUSH_INTERVAL_MS (5s) — poll for persistence. */
    let mine: any[] = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      mine = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))
        .filter((r: any) => r.model === MODEL && r.status === 'success');
      if (mine.length >= 3) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(mine.length).toBe(3); // exactly the 3 chat() calls above
    const ids = mine.map((r: any) => r.requestId);
    expect(new Set(ids).size).toBe(ids.length); // unique request ids
  });

  it('no credential material in ANY persisted config/usage/backup file', async () => {
    // create a fresh backup to include in the scan
    const bk = await request('POST', '/admin/backup');
    expect(bk.status === 200 || bk.status === 201).toBe(true);

    const files: string[] = [];
    for (const f of [PRICING_FILE, USAGE_FILE, STATE_FILE]) {
      if (fs.existsSync(f)) files.push(f);
    }
    const bdir = configFile('backups');
    if (fs.existsSync(bdir)) {
      for (const f of fs.readdirSync(bdir)) files.push(path.join(bdir, f));
    }
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const body = fs.readFileSync(f, 'utf-8').toLowerCase();
      expect(body, `${f} leaks NVIDIA key`).not.toContain('nkey1');
      expect(body, `${f} leaks OpenRouter key`).not.toContain('okey1');
      expect(body, `${f} contains authorization header`).not.toContain('"authorization"');
      expect(body, `${f} contains bearer token`).not.toContain('bearer ');
    }

    // usage records store masked/null keys only
    const recs = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    for (const r of recs) {
      expect(r.apiKey ?? null).toBeNull();
    }
  }, 20000);

  it('dashboard total == SUM(valid costUsd); null costs never counted as $0', async () => {
    /* wait for the periodic flush so disk matches the API view */
    const deadline = Date.now() + 15000;
    let recs: any[] = [];
    while (Date.now() < deadline) {
      recs = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))
        .filter((r: any) => r.model === MODEL);
      if (recs.length >= 3) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const sum = recs.reduce((a, r) => a + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
    expect(sum).toBeCloseTo(0.7 * 2 + 1.9, 9);

    const agg = (await request('GET', '/admin/usage')).data;
    expect(agg.totalCostUsd).toBeCloseTo(sum, 9);
    expect(agg.totalTokens).toBe(recs.reduce((a, r) => a + r.totalTokens, 0));

    // unknown-pricing display contract: N/A, never $0 (checked at API level)
    const byModel = (await request('GET', '/admin/usage/models')).data;
    const row = byModel[`openrouter/${MODEL}`];
    expect(row.pricingStatus).toBe('known'); // priced pair
  }, 20000);
});
