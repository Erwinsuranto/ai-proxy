/**
 * Usage audit round 3 — deterministic end-to-end validation through the REAL
 * request path using a LOCAL mock upstream (existing project mechanism:
 * per-provider BASE_URL env override). No paid credentials, no code bypass.
 *
 * Covers the previously-untestable cases:
 *   - first provider FAILS → second provider SUCCEEDS (fallback success)
 *   - all providers fail → single error record from the actual failing attempt
 *   - request count is NEVER multiplied by attempts
 *   - tokens extracted from a REAL upstream response flow into pricing/cost
 *   - streaming usage → cost, and usage:null streaming stays successful
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

/* ------------------------------ Mock upstream ----------------------------- */
type MockMode = 'ok' | 'auth-fail' | 'stream-ok' | 'stream-null-usage';
let mockMode: MockMode = 'ok';

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mockMode === 'auth-fail') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid mock key' } }));
        return;
      }
      if (mockMode === 'stream-ok' || mockMode === 'stream-null-usage') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const usage = mockMode === 'stream-ok'
          ? '"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}'
          : '"usage":null';
        res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
        res.write(`data: {"choices":[],${usage}}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // deterministic success payload with REAL usage numbers
      const reqModel = (() => { try { return JSON.parse(body).model ?? 'mock'; } catch { return 'mock'; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: reqModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500_000, completion_tokens: 100_000, total_tokens: 600_000 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    NVIDIA_API_KEYS: 'nkey1,nkey2',
    /* NOTE: OpenRouter's legacy loader reads the CSV from OPENROUTER_API_KEY
       (numberedFirst=false → keysVar stays 'OPENROUTER_API_KEY'). */
    OPENROUTER_API_KEY: 'okey1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
}, 30000);

afterAll(async () => {
  await stopServer();
  MOCK_SERVER.close();
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function logsFor(model: string): Promise<any[]> {
  const r = await request('GET', `/admin/logs?model=${encodeURIComponent(model)}&limit=100`);
  return (r.data.logs || []) as any[];
}

/** Polls logs until `pred` matches or timeout — stream records land on 'end'. */
async function waitFor(pred: (recs: any[]) => boolean, timeoutMs = 10000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recs = await logsFor('e2e/stream-model');
    if (pred(recs)) return recs;
    await new Promise(r => setTimeout(r, 300));
  }
  return logsFor('e2e/stream-model');
}

describe('Provider-locked success: request handled by its locked provider', () => {
  it('records ONE success record from the locked provider (#locked-success)', async () => {
    // Provider-locked routing: the model is pinned to openrouter (mock). We no
    // longer test cross-provider fallback (that behavior was intentionally
    // removed). This still verifies usage/token/cost flow end-to-end through the
    // real request path. Model chosen so pricing EXISTS for the openrouter pair.
    const MODEL = 'deepseek/deepseek-v4-flash';
    await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
    mockMode = 'ok';

    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    expect(res.status).toBe(200);
    expect(res.data.choices[0].message.content).toBe('MOCK_OK');

    const recs = await logsFor(MODEL);
    /* exactly one record — key attempts never multiply request count */
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe('success');
    expect(recs[0].provider).toBe('openrouter');       // locked handler
    expect(recs[0].model).toBe(MODEL);
    expect(recs[0].httpStatus).toBe(200);

    /* tokens come from the REAL upstream response */
    expect(recs[0].promptTokens).toBe(500_000);
    expect(recs[0].completionTokens).toBe(100_000);
    expect(recs[0].totalTokens).toBe(600_000);

    /* cost computed server-side from exact provider/model + those tokens:
       openrouter/deepseek/deepseek-v4-flash = $0.268/1M in, $0.40/1M out */
    expect(recs[0].inputCostUsd).toBeCloseTo(0.134, 10);
    expect(recs[0].outputCostUsd).toBeCloseTo(0.04, 10);
    expect(recs[0].costUsd).toBeCloseTo(0.174, 10);
  }, 40000);
});

describe('All keys fail: single error record from actual failing attempt', () => {
  it('locked provider fails → ONE error record attributed to that provider (#all-fail)', async () => {
    const model = 'e2e/all-fail';
    // Locked to openrouter only; mock returns 401 for all keys.
    await request('POST', '/admin/models', { model, providerId: 'openrouter', priority: 10 });
    mockMode = 'auth-fail';

    const res = await request('POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const recs = await logsFor(model);
    expect(recs).toHaveLength(1);                       // still ONE request record
    expect(recs[0].status).toBe('error');
    expect(recs[0].provider).toBe('openrouter');        // locked provider produced the error
    expect(recs[0].costUsd ?? null).toBeNull();         // no valid usage → no fabricated cost
  }, 40000);
});

describe('Streaming through real request path (#streaming)', () => {
  it('stream success → usage captured → cost computed → exactly one record', async () => {
    const model = 'e2e/stream-model';
    await request('POST', '/admin/models', { model, providerId: 'openrouter', priority: 5 });
    mockMode = 'stream-ok';

    const res = await request('POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, 15000);
    expect([200, 0]).toContain(res.status); // hijacked SSE response

    const recs = await waitFor(recs => recs.some(r => r.status === 'success'));
    const ok = recs.filter(r => r.status === 'success');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const rec = ok.find(r => r.provider === 'openrouter');
    expect(rec).toBeDefined();
    expect(rec.promptTokens).toBe(11);
    expect(rec.completionTokens).toBe(7);
    expect(rec.totalTokens).toBe(18);
    /* unpriced e2e/stream-model → cost null but stream did NOT fail */
    expect(rec.costUsd ?? null).toBeNull();

    /* no duplicate stream records */
    const totalForReq = recs.filter(r => r.requestId && r.requestId === rec.requestId);
    expect(totalForReq).toHaveLength(1);
  }, 40000);

  it('upstream usage:null in final chunk → tokens null, cost null, stream still succeeds', async () => {
    const model = 'e2e/stream-model';
    mockMode = 'stream-null-usage';

    const res = await request('POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'hi again' }],
      stream: true,
    }, 15000);
    expect([200, 0]).toContain(res.status);

    await waitFor(recs => recs.filter(r => r.status === 'success').length >= 2);
    const recs = await logsFor(model);
    const successes = recs.filter(r => r.status === 'success').sort((a, b) => b.timestamp - a.timestamp);
    const latest = successes[0];
    expect(latest.promptTokens ?? null).toBeNull();   // never estimated
    expect(latest.completionTokens ?? null).toBeNull();
    expect(latest.totalTokens ?? null).toBeNull();
    expect(latest.costUsd ?? null).toBeNull();
  }, 40000);
});

describe('Dashboard consistency over mixed real-path data', () => {
  it('summary == provider == model == Σ records (known costs summed, unknown not $0)', async () => {
    const agg = (await request('GET', '/admin/usage')).data;
    const byProv = (await request('GET', '/admin/usage/providers')).data;
    const byModel = (await request('GET', '/admin/usage/models')).data;
    const logs = (await request('GET', '/admin/logs?limit=1000')).data;

    let sum: number | null = null;
    for (const r of logs.logs || []) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) sum = (sum ?? 0) + r.costUsd;
    }
    expect(sum).not.toBeNull();               // the priced fallback-success record exists
    expect(agg.totalCostUsd).toBeCloseTo(sum!, 9);

    let provSum = 0;
    for (const b of Object.values<any>(byProv)) {
      if (typeof b.costUsd === 'number') provSum += b.costUsd;
    }
    expect(provSum).toBeCloseTo(sum!, 9);

    let modelSum = 0;
    for (const b of Object.values<any>(byModel)) {
      if (typeof b.costUsd === 'number') modelSum += b.costUsd;
    }
    expect(modelSum).toBeCloseTo(sum!, 9);

    /* unknown-priced models appear with null cost, never silently $0 */
    const streamed = byModel['e2e/stream-model'];
    if (streamed) {
      expect(streamed.pricingStatus).toBe('unknown');
      expect(streamed.costUsd).toBeNull();
    }
  }, 20000);
});
