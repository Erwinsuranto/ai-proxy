import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordUsage,
  flushUsage,
  queryUsage,
  getUsageRecordByIndex,
  UsageRecord,
} from '../src/lib/usage-store';

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

const MARKER = `logs-order-${Date.now()}`;
const BASE = 10_000_000;
const N = 10;
const PAGE = 5;

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'k1,k2' });

  // Insert N records in ASCENDING timestamp order to simulate older records
  // flushed to disk being read before the in-memory buffer — exactly the
  // scenario that hid the newest record on page 2 before the fix.
  for (let i = 0; i < N; i++) {
    recordUsage(makeRecord({ model: `${MARKER}-r${i}`, timestamp: BASE + i, requestId: `req-${i}` }));
  }
  flushUsage();
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

describe('Admin Logs ordering + pagination (regression)', () => {
  it('page 1 returns records in DESC timestamp order with newest first', async () => {
    const res = await request('GET', `/admin/logs?search=${MARKER}&limit=${PAGE}&offset=0`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(N);
    expect(res.data.logs.length).toBe(PAGE);
    const ts = (res.data.logs as any[]).map((l) => l.timestamp);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    }
    // Newest of the set must be the very first row on page 1.
    expect(ts[0]).toBe(BASE + 9);
  });

  it('page 2 contains the OLDER half and follows page 1 (no newest is missed)', async () => {
    const p1 = await request('GET', `/admin/logs?search=${MARKER}&limit=${PAGE}&offset=0`);
    const p2 = await request('GET', `/admin/logs?search=${MARKER}&limit=${PAGE}&offset=${PAGE}`);
    expect(p2.status).toBe(200);
    expect(p2.data.logs.length).toBe(PAGE);
    // Every page 2 timestamp must be STRICTLY older than the last page 1 row.
    expect(p2.data.logs[0].timestamp).toBeLessThan(p1.data.logs[PAGE - 1].timestamp);
    // Union of page 1 + page 2 equals exactly the N marker records, sorted DESC.
    const union = [
      ...(p1.data.logs as any[]),
      ...(p2.data.logs as any[]),
    ].map((l) => l.timestamp);
    expect(union.length).toBe(N);
    const expected: number[] = [];
    for (let i = 0; i < N; i++) expected.push(BASE + i);
    expected.sort((a, b) => b - a);
    expect(union).toEqual(expected);
  });

  it('reload after a new request keeps newest on top of page 1', async () => {
    const newer = BASE + 100;
    recordUsage(makeRecord({ model: `${MARKER}-newer`, timestamp: newer, requestId: 'req-newer' }));
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}&limit=${PAGE}&offset=0`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(N + 1);
    expect(res.data.logs[0].timestamp).toBe(newer);
    expect(res.data.logs[0].model).toBe(`${MARKER}-newer`);

    const allTs = (res.data.logs as any[]).map((l) => l.timestamp);
    expect(allTs.indexOf(newer)).toBe(0);
  });

  it('filter + sorting + pagination stay correct together', async () => {
    recordUsage(makeRecord({ provider: 'alpha', model: `${MARKER}-a1`, timestamp: BASE + 5 }));
    recordUsage(makeRecord({ provider: 'beta',  model: `${MARKER}-b1`, timestamp: BASE + 8 }));
    recordUsage(makeRecord({ provider: 'alpha', model: `${MARKER}-a2`, timestamp: BASE + 12 }));
    flushUsage();

    const alpha = await request('GET', `/admin/logs?search=${MARKER}&provider=alpha&limit=10&offset=0`);
    expect(alpha.status).toBe(200);
    const alphaModels = (alpha.data.logs as any[]).map((l) => l.model);
    expect(alphaModels.indexOf(`${MARKER}-a2`)).toBeLessThan(alphaModels.indexOf(`${MARKER}-a1`));
    expect(alphaModels[0]).toBe(`${MARKER}-a2`);
    expect(alphaModels.some((m) => m.startsWith(`${MARKER}-b`))).toBe(false);

    const alphaP1 = await request('GET', `/admin/logs?search=${MARKER}&provider=alpha&limit=1&offset=0`);
    const alphaP2 = await request('GET', `/admin/logs?search=${MARKER}&provider=alpha&limit=1&offset=1`);
    expect(alphaP1.data.logs[0].model).toBe(`${MARKER}-a2`);
    expect(alphaP2.data.logs[0].model).toBe(`${MARKER}-a1`);
    expect(alphaP2.data.logs[0].timestamp).toBeLessThan(alphaP1.data.logs[0].timestamp);
  });
});

describe('usage-store query/sort/pagination (unit)', () => {
  it('slice is applied AFTER sort; DESC newest-first even when only newest is in-memory', () => {
    const m = `${MARKER}-unit-${Date.now()}`;
    recordUsage(makeRecord({ model: m, timestamp: 100 }));
    recordUsage(makeRecord({ model: m, timestamp: 200 }));
    recordUsage(makeRecord({ model: m, timestamp: 300 }));
    flushUsage();
    recordUsage(makeRecord({ model: m, timestamp: 999_999 }));

    const p1 = queryUsage({ search: m, limit: 2, offset: 0 });
    const p2 = queryUsage({ search: m, limit: 2, offset: 2 });
    expect(p1.total).toBe(4);
    expect(p1.records[0].timestamp).toBe(999_999);
    expect(p1.records[1].timestamp).toBe(300);
    expect(p2.records[0].timestamp).toBe(200);
    expect(p2.records[1].timestamp).toBe(100);
  });

  it('getUsageRecordByIndex resolves using the same DESC ordering (default = all records)', () => {
    const a = getUsageRecordByIndex(0)?.timestamp ?? -Infinity;
    const b = getUsageRecordByIndex(1)?.timestamp ?? -Infinity;
    expect(a).toBeGreaterThanOrEqual(b);
    expect(getUsageRecordByIndex(-1)).toBeUndefined();
    expect(getUsageRecordByIndex(999_999_999)).toBeUndefined();
  });

  it('getUsageRecordByIndex honors filter to keep detail consistent with filtered /admin/logs rows', () => {
    const m = `${MARKER}-detail-${Date.now()}`;
    recordUsage(makeRecord({ provider: 'zeta', model: m, timestamp: 500 }));
    recordUsage(makeRecord({ provider: 'zeta', model: `${m}-v2`, timestamp: 700 }));
    recordUsage(makeRecord({ provider: 'other', model: `${m}-noise`, timestamp: 600 }));
    flushUsage();

    const rec = getUsageRecordByIndex(0, { provider: 'zeta', search: m });
    expect(rec).toBeDefined();
    expect(rec!.model).toBe(`${m}-v2`);
    expect(rec!.provider).toBe('zeta');
  });
});
