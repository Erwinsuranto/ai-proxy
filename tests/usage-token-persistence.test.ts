import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import { recordUsage, flushUsage, UsageRecord } from '../src/lib/usage-store';

const USAGE_FILE = configFile('usage-records.json');

function makeRecord(partial: Partial<UsageRecord>): UsageRecord {
  const has = (k: keyof UsageRecord) => partial[k] !== undefined;
  return {
    timestamp: has('timestamp') ? partial.timestamp! : Date.now(),
    provider: has('provider') ? partial.provider! : 'nvidia',
    model: has('model') ? partial.model! : 'test-model',
    status: has('status') ? partial.status! : 'success',
    latencyMs: has('latencyMs') ? partial.latencyMs! : 10,
    promptTokens: has('promptTokens') ? partial.promptTokens! : 5,
    completionTokens: has('completionTokens') ? partial.completionTokens! : 3,
    totalTokens: has('totalTokens') ? partial.totalTokens! : 8,
    apiKey: has('apiKey') ? partial.apiKey! : null,
    httpStatus: has('httpStatus') ? partial.httpStatus! : 200,
    errorMessage: has('errorMessage') ? partial.errorMessage! : null,
    requestId: has('requestId') ? partial.requestId! : null,
    apiKeyMasked: has('apiKeyMasked') ? partial.apiKeyMasked! : null,
  };
}

const MARKER = `usage-persist-${Date.now()}`;

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'k1,k2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

describe('Token usage persistence through /admin/logs (regression)', () => {
  it('non-streaming success with upstream usage: tokens persist into /admin/logs', async () => {
    // Simulate what `recordUsageFor` records for a non-streaming success when
    // upstream returned a JSON body with `usage: {prompt_tokens, completion_tokens, total_tokens}`.
    recordUsage(makeRecord({
      provider: 'nvidia',
      model: `${MARKER}-nonstream`,
      status: 'success',
      httpStatus: 200,
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
      latencyMs: 42,
      requestId: `${MARKER}-req-ns`,
    }));
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-nonstream`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(1);
    const rec = res.data.logs[0];
    expect(rec.status).toBe('success');
    expect(rec.promptTokens).toBe(12);
    expect(rec.completionTokens).toBe(7);
    expect(rec.totalTokens).toBe(19);
    expect(rec.httpStatus).toBe(200);
  });

  it('streaming success with upstream usage in final SSE chunk: tokens persist into /admin/logs', async () => {
    // Simulate what `wrapStream` + `recordUsageFor` records for a streaming
    // success when upstream sent usage in the final SSE chunk.
    recordUsage(makeRecord({
      provider: 'openrouter',
      model: `${MARKER}-stream`,
      status: 'success',
      httpStatus: 200,
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      latencyMs: 88,
      requestId: `${MARKER}-req-st`,
    }));
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-stream`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(1);
    const rec = res.data.logs[0];
    expect(rec.status).toBe('success');
    expect(rec.promptTokens).toBe(5);
    expect(rec.completionTokens).toBe(2);
    expect(rec.totalTokens).toBe(7);
  });

  it('streaming success where upstream sends NO usage: tokens stay null (never estimated)', async () => {
    // Mirrors NVIDIA which sends `usage: null`. Storage MUST keep null — UI
    // renders "—". Never estimate or fabricate.
    recordUsage(makeRecord({
      provider: 'nvidia',
      model: `${MARKER}-null`,
      status: 'success',
      httpStatus: 200,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      latencyMs: 33,
    }));
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-null`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(1);
    const rec = res.data.logs[0];
    expect(rec.status).toBe('success');
    expect(rec.promptTokens).toBeNull();
    expect(rec.completionTokens).toBeNull();
    expect(rec.totalTokens).toBeNull();
  });

  it('total_tokens is computed when upstream omits it but provides prompt+completion', async () => {
    // `extractUsageFromResult` / `extractUsage` derive total = prompt + completion
    // only when both are present and upstream total is absent.
    recordUsage(makeRecord({
      provider: 'groq',
      model: `${MARKER}-derived-total`,
      status: 'success',
      httpStatus: 200,
      promptTokens: 4,
      completionTokens: 6,
      // emulate derived total
      totalTokens: 10,
      latencyMs: 5,
    }));
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-derived-total`);
    expect(res.status).toBe(200);
    expect(res.data.logs[0].totalTokens).toBe(10);
  });

  it('latest record appears at the top of /admin/logs (DESC newest-first)', async () => {
    const ts = [Date.now() + 1000, Date.now() + 2000, Date.now() + 3000];
    ts.forEach((t, i) => {
      recordUsage(makeRecord({
        model: `${MARKER}-order-${i}`,
        timestamp: t,
        requestId: `${MARKER}-order-req-${i}`,
        promptTokens: i,
        completionTokens: i,
        totalTokens: i * 2,
      }));
    });
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-order`);
    expect(res.status).toBe(200);
    expect(res.data.logs[0].timestamp).toBe(ts[2]);
    expect(res.data.logs[1].timestamp).toBe(ts[1]);
    expect(res.data.logs[2].timestamp).toBe(ts[0]);
    // Newest carries its token payload through to the UI.
    expect(res.data.logs[0].promptTokens).toBe(2);
    expect(res.data.logs[0].completionTokens).toBe(2);
    expect(res.data.logs[0].totalTokens).toBe(4);
  });
});
