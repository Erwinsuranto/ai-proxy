/**
 * Regression tests for the SeekAI fixes (Fix #1 inline upstream errors,
 * Fix #2 raised timeout). Uses a LOCAL mock upstream so no paid credentials
 * are used. Demonstrates that:
 *   - HTTP 200 carrying an inline ` [error]` payload is turned into a real
 *     upstream failure and is NOT forwarded to the client as a model answer.
 *   - The existing key-rotation / fallback path is exercised: after inline
 *     failures on earlier keys, a request lands on a working key (MOCK_OK).
 *   - A SeekAI request that exceeds the (raised) timeout becomes an upstream
 *     failure and key rotation proceeds.
 *   - Internal error text never leaks a raw API key.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, request, configFile } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

type Mode = 'ok' | 'inline' | 'stream-inline' | 'stream-ok';
let mockMode: Mode = 'ok';
let mockInlineRemaining = 0;
let mockStreamInlineRemaining = 0;
let mockDelayMs = 0;

const MODEL = 'seekai/echo';

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'seekai-mock', object: 'model', owned_by: 'seekai' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isStream = (() => { try { return !!JSON.parse(body).stream; } catch { return false; } })();
      const respond = () => {
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (mockStreamInlineRemaining > 0) {
            mockStreamInlineRemaining--;
            res.write('data: {"choices":[{"delta":{"content":"[error] Service temporarily unavailable"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write('data: {"choices":[{"delta":{"content":"MOCK_OK"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (mockInlineRemaining > 0) {
          mockInlineRemaining--;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'x', object: 'chat.completion', created: 1, model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: '[error] Service temporarily unavailable' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      };
      if (mockDelayMs > 0) {
        setTimeout(respond, mockDelayMs);
      } else {
        respond();
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function streamRequest(model: string, stream: boolean): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: 3456,
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, raw: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream, max_tokens: 8 }));
    req.end();
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    SEEKAI_API_KEYS: 'k1,k2,k3,k4',
    SEEKAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    SEEKAI_TIMEOUT: '2000',
    DISABLE_PROVIDERS: 'nvidia',
  });
  await request('POST', '/admin/models', { model: MODEL, providerId: 'seekai', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer();
  MOCK_SERVER.close();
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

beforeEach(() => {
  mockMode = 'ok';
  mockInlineRemaining = 0;
  mockStreamInlineRemaining = 0;
  mockDelayMs = 0;
});

describe('Fix #1 — inline upstream error is a real failure, not a 200 completion', () => {
  it('HTTP 200 + inline [error] is surfaced as a 5xx (not 200 with error text)', async () => {
    mockInlineRemaining = 3; // first 3 requests fail inline
    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(res.data);
    // The raw upstream error string must NOT be forwarded as the model answer.
    expect(text).not.toContain('MOCK_OK');
    expect(text.toLowerCase()).not.toContain('[error] service temporarily unavailable');
    // And no raw API key leaks into the error surface.
    expect(text).not.toContain('k1');
    expect(text).not.toContain('k2');
  }, 40000);

  it('fallback/rotation reaches a working key after inline failures', async () => {
    mockInlineRemaining = 3;
    // 3 inline failures then a working key
    for (let i = 0; i < 3; i++) {
      const r = await request('POST', '/v1/chat/completions', {
        model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const ok = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.data)).toContain('MOCK_OK');
  }, 40000);

  it('inline error is recorded as a key failure in /internal/keys', async () => {
    const before = await request('GET', '/internal/keys');
    mockInlineRemaining = 1;
    await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    const after = await request('GET', '/internal/keys');
    const beforeFailed = (before.data as any[]).filter((k) => k.provider === 'seekai').reduce((s, k) => s + k.failed, 0);
    const afterFailed = (after.data as any[]).filter((k) => k.provider === 'seekai').reduce((s, k) => s + k.failed, 0);
    expect(afterFailed).toBeGreaterThan(beforeFailed);
  }, 40000);
});

describe('Fix #1 — streaming inline error handled safely', () => {
  it('streaming inline error becomes a 5xx and is not forwarded as completion', async () => {
    mockStreamInlineRemaining = 3;
    const res = await streamRequest(MODEL, true);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.raw.toLowerCase()).not.toContain('[error] service temporarily unavailable');
  }, 40000);

  it('streaming succeeds after inline failures are rotated away', async () => {
    mockStreamInlineRemaining = 3;
    for (let i = 0; i < 3; i++) {
      const r = await streamRequest(MODEL, true);
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const ok = await streamRequest(MODEL, true);
    expect(ok.status).toBe(200);
    expect(ok.raw).toContain('MOCK_OK');
  }, 40000);
});

describe('Fix #2 — SeekAI timeout becomes an upstream failure', () => {
  it('a request exceeding SEEKAI_TIMEOUT fails and key rotation proceeds', async () => {
    mockDelayMs = 5000; // exceeds the 2000ms SEEKAI_TIMEOUT set in this test file
    const r = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    }, 8000);
    expect(r.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('k1');

    // reset delay; next request should succeed via rotation
    mockDelayMs = 0;
    const ok = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.data)).toContain('MOCK_OK');
  }, 40000);
});
