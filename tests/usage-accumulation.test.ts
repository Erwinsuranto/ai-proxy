/* ============================================================================
 * Usage accumulation — E2E PROOF that every new request actually INCREASES
 * the usage source data (aggregates + per-model breakdown + persisted file),
 * for streaming AND non-streaming, with pricing applied per request.
 *
 *   Request 1: prompt X1 / completion Y1  → aggregates += X1, Y1, X1+Y1, +1 req
 *   Request 2: prompt X2 / completion Y2  → aggregates accumulate on top
 *   Stream   : usage in the FINAL chunk    → recorded after stream completes
 *
 * Also proves: pricing uses the LATEST stored price (not a stale snapshot),
 * a provider that reports NO streamed usage is never fabricated, Anthropic-
 * style input_tokens/output_tokens usage is parsed, and the records reach
 * the PERSISTED usage file (not just memory).
 * ========================================================================== */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, request, streamRequest, configFile } from './setup';
import { extractUsage } from '../src/services/stream-usage';

const USAGE_FILE = configFile('usage-records.json');
const CLIENT_MODEL = 'usage-acc-model';               // client-facing registry name
const BACKEND_MODEL = 'internal/acc-backend-model';   // what the mock upstream receives

/* Pricing registered for empero/<CLIENT_MODEL> via the admin API (USD/1M). */
const PRICE_IN = 2;   // $2 per 1M prompt tokens
const PRICE_OUT = 3;  // $3 per 1M completion tokens

let mockChatBehavior: 'ok' | 'anthropic-usage' = 'ok';
let mockStreamBehavior: 'usage' | 'no-usage' = 'usage';
const receivedChatBodies: any[] = [];

const MOCK = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: BACKEND_MODEL, object: 'model', owned_by: 'MockProvider' }],
    }));
    return;
  }

  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      receivedChatBodies.push(parsed);

      if (parsed.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-str', object: 'chat.completion.chunk', created: 1, model: BACKEND_MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-str', object: 'chat.completion.chunk', created: 1, model: BACKEND_MODEL,
          choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-str', object: 'chat.completion.chunk', created: 1, model: BACKEND_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          /* include_usage-style final chunk; null for the no-usage variant. */
          usage: mockStreamBehavior === 'usage'
            ? { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
            : null,
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (mockChatBehavior === 'anthropic-usage') {
        /* Anthropic-style usage naming — must still be parsed & recorded. */
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: BACKEND_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: BACKEND_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

async function getUsage(): Promise<any> {
  const res = await request('GET', '/admin/usage');
  expect(res.status).toBe(200);
  return res.data;
}

/** Streams end server-side slightly after the client sees [DONE]; poll until
 *  the expected total requests count is visible in the aggregates. */
async function waitForRequestCount(expectedDelta: number, baseline: number): Promise<any> {
  const deadline = Date.now() + 8000;
  let usage = await getUsage();
  while (usage.totalRequests < baseline + expectedDelta && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    usage = await getUsage();
  }
  return usage;
}

beforeAll(async () => {
  await new Promise<void>(r => MOCK.listen(0, '127.0.0.1', r));
  mockPort = (MOCK.address() as any).port;
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({
    NVIDIA_API_KEYS: 'nkey1',
    EMPERO_API_KEY: 'empero-upstream-key',
    EMPERO_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await request('POST', '/admin/models', {
    model: CLIENT_MODEL, providerId: 'empero', priority: 10, backendModel: BACKEND_MODEL,
  });
  /* Deterministic pricing for the exact provider/model pair. */
  const p = await request('POST', '/admin/pricing', {
    providerId: 'empero', model: CLIENT_MODEL, inputPerM: PRICE_IN, outputPerM: PRICE_OUT,
  });
  expect([200, 201]).toContain(p.status);
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK.close();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

/* ====================== Request 1 + Request 2 (non-stream) ================ */

describe('Usage accumulation — non-streaming (Request 1 + Request 2)', () => {

  it('Request 1: prompt += X, completion += Y, total += X+Y, requests += 1, cost += exact price', async () => {
    const before = await getUsage();

    const res = await request('POST', '/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.data.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });

    const after = await waitForRequestCount(1, before.totalRequests);

    expect(after.totalRequests).toBe(before.totalRequests + 1);
    expect(after.totalSuccess).toBe(before.totalSuccess + 1);
    expect(after.totalPromptTokens).toBe(before.totalPromptTokens + 7);
    expect(after.totalCompletionTokens).toBe(before.totalCompletionTokens + 3);
    expect(after.totalTokens).toBe(before.totalTokens + 10);
    /* Pricing: (7 × $2/1M) + (3 × $3/1M) = 23e-6 USD on top of the baseline. */
    expect(after.totalCostUsd).toBeCloseTo((before.totalCostUsd ?? 0) + (7 * PRICE_IN + 3 * PRICE_OUT) / 1e6, 12);
  });

  it('Request 2 (different usage): aggregates accumulate = before + req1 + req2', async () => {
    const afterReq1 = await getUsage();

    const res = await request('POST', '/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(res.status).toBe(200);

    const after = await waitForRequestCount(1, afterReq1.totalRequests);

    expect(after.totalRequests).toBe(afterReq1.totalRequests + 1);
    expect(after.totalPromptTokens).toBe(afterReq1.totalPromptTokens + 7);
    expect(after.totalCompletionTokens).toBe(afterReq1.totalCompletionTokens + 3);
    expect(after.totalTokens).toBe(afterReq1.totalTokens + 10);
    expect(after.totalCostUsd).toBeCloseTo((afterReq1.totalCostUsd ?? 0) + (7 * PRICE_IN + 3 * PRICE_OUT) / 1e6, 12);

    /* Per-model breakdown reflects the exact accumulated usage. */
    const models = await request('GET', '/admin/usage/models');
    const row = models.data[`empero/${CLIENT_MODEL}`];
    expect(row).toBeDefined();
    expect(row.requests).toBeGreaterThanOrEqual(2);
    expect(row.pricingStatus).toBe('known');
  });

  it('cost uses the LATEST stored pricing (not a stale snapshot)', async () => {
    /* Update the price via the admin API, then verify the next request is
     * priced with the NEW values. */
    const upd = await request('POST', '/admin/pricing', {
      providerId: 'empero', model: CLIENT_MODEL, inputPerM: 10, outputPerM: 20,
    });
    expect([200, 201]).toContain(upd.status);

    const before = await getUsage();
    const res = await request('POST', '/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'repriced' }],
    });
    expect(res.status).toBe(200);
    const after = await waitForRequestCount(1, before.totalRequests);

    expect(after.totalCostUsd).toBeCloseTo((before.totalCostUsd ?? 0) + (7 * 10 + 3 * 20) / 1e6, 12);
  });

  it('Anthropic-style usage (input_tokens/output_tokens) is parsed and recorded', async () => {
    mockChatBehavior = 'anthropic-usage';
    const before = await getUsage();
    const res = await request('POST', '/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'anthropic-format' }],
    });
    expect(res.status).toBe(200);
    const after = await waitForRequestCount(1, before.totalRequests);

    expect(after.totalPromptTokens).toBe(before.totalPromptTokens + 7);
    expect(after.totalCompletionTokens).toBe(before.totalCompletionTokens + 3);
    expect(after.totalTokens).toBe(before.totalTokens + 10);
    mockChatBehavior = 'ok';
  });
});

/* ============================== Streaming ================================= */

describe('Usage accumulation — streaming', () => {

  it('stream with final usage chunk: tokens recorded after the stream completes', async () => {
    mockStreamBehavior = 'usage';
    const before = await getUsage();

    const res = await streamRequest('/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'stream me' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const full = res.chunks.join('');
    expect(full).toContain('data: [DONE]');

    /* The upstream asked to include usage (OpenAI stream_options contract). */
    const streamBodies = receivedChatBodies.filter(b => b.stream === true);
    expect(streamBodies.length).toBeGreaterThanOrEqual(1);
    expect(streamBodies[streamBodies.length - 1].stream_options).toEqual({ include_usage: true });

    const after = await waitForRequestCount(1, before.totalRequests);
    expect(after.totalRequests).toBe(before.totalRequests + 1);
    expect(after.totalPromptTokens).toBe(before.totalPromptTokens + 4);
    expect(after.totalCompletionTokens).toBe(before.totalCompletionTokens + 2);
    expect(after.totalTokens).toBe(before.totalTokens + 6);
    expect(after.totalCostUsd).toBeCloseTo((before.totalCostUsd ?? 0) + (4 * 10 + 2 * 20) / 1e6, 12);
  });

  it('stream WITHOUT usage: request counted, tokens stay null (never fabricated)', async () => {
    mockStreamBehavior = 'no-usage';
    const before = await getUsage();

    const res = await streamRequest('/v1/chat/completions', {
      model: CLIENT_MODEL,
      messages: [{ role: 'user', content: 'no usage here' }],
      stream: true,
    });
    expect(res.status).toBe(200);

    const after = await waitForRequestCount(1, before.totalRequests);
    expect(after.totalRequests).toBe(before.totalRequests + 1);
    expect(after.totalPromptTokens).toBe(before.totalPromptTokens);
    expect(after.totalCompletionTokens).toBe(before.totalCompletionTokens);
    expect(after.totalTokens).toBe(before.totalTokens);
    mockStreamBehavior = 'usage';
  });
});

/* ========================= Parser format coverage ========================= */

describe('usage parser — provider-specific formats', () => {
  it('OpenAI style', () => {
    expect(extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
      .toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('Anthropic style (input_tokens/output_tokens)', () => {
    expect(extractUsage({ usage: { input_tokens: 7, output_tokens: 3 } }))
      .toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it('camelCase style', () => {
    expect(extractUsage({ usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 } }))
      .toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });

  it('Anthropic style streamed through the raw JSON string', () => {
    expect(extractUsage('{"usage":{"input_tokens":2,"output_tokens":5}}'))
      .toEqual({ promptTokens: 2, completionTokens: 5, totalTokens: 7 });
  });

  it('missing usage stays null (no fabrication)', () => {
    expect(extractUsage({ choices: [] }))
      .toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    expect(extractUsage({ usage: null }))
      .toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });
});

/* ======================== Persisted storage proof ========================= */

describe('usage records reach the PERSISTED file (not just memory)', () => {
  it('usage-records.json contains the exact per-request token/cost values', async () => {
    /* SIGTERM (stopServer) triggers the graceful flush in the child process. */
    await stopServer();

    expect(fs.existsSync(USAGE_FILE)).toBe(true);
    const persisted: any[] = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    const mine = persisted.filter(r => r.provider === 'empero' && r.model === CLIENT_MODEL);

    const nonStream = mine.filter(r => r.status === 'success' && r.promptTokens === 7 && r.completionTokens === 3);
    expect(nonStream.length).toBeGreaterThanOrEqual(2); // Request 1 + Request 2 (+ repriced/anthropic)
    for (const r of nonStream) {
      expect(r.totalTokens).toBe(10);
      expect(r.costUsd).toBeGreaterThan(0);
    }

    const streamed = mine.find(r => r.status === 'success' && r.promptTokens === 4 && r.completionTokens === 2);
    expect(streamed).toBeDefined();
    expect(streamed.totalTokens).toBe(6);

    /* Request 1/2 priced at 2/3, the repriced request at 10/20 — per-request
     * cost captured AT REQUEST TIME from the pricing in effect. */
    const cheap = nonStream.find(r => Math.abs(r.costUsd - (7 * 2 + 3 * 3) / 1e6) < 1e-12);
    const dear = nonStream.find(r => Math.abs(r.costUsd - (7 * 10 + 3 * 20) / 1e6) < 1e-12);
    expect(cheap).toBeDefined();
    expect(dear).toBeDefined();
  });
});
