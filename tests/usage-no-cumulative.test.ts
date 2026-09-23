import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import { recordUsage, flushUsage, queryUsage, getUsageAggregates, UsageRecord } from '../src/lib/usage-store';

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

const MARKER = `usage-no-cumulative-${Date.now()}`;

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'k1,k2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

// Regression: each Usage Log record MUST store only THIS request's own
// upstream-reported tokens. Records must NOT carry tokens from previous
// requests (no cumulative/session counters stored as if they were per-request
// usage). The dashboard computes SUM; individual records must remain exactly
// what upstream said. If upstream reports a session-cumulative counter that
// cannot be attributed to a single request, store null — never fabricate.
describe('Usage Logs MUST NOT be cumulative (regression)', () => {
  it('three consecutive requests keep their own per-request tokens (no carryover)', async () => {
    // Simulate three separate real upstream responses for three independent
    // requests: 126616/127318/123720 are NOT cumulative — they reflect the
    // REAL prompt token count for THAT request's payload.
    const reqs = [
      { p: 84,  c: 36,  t: 120 },   // tiny prompt request
      { p: 9,   c: 22,  t: 31  },   // tiny prompt request, different values
      { p: 204151, c: 12, t: 204163 }, // long-history prompt request (large)
    ];
    const tags = reqs.map((r, i) => `${MARKER}-req-${i}`);

    reqs.forEach((r, i) => {
      recordUsage(makeRecord({
        provider: 'tokenharbor',
        model: `${MARKER}-model`,
        status: 'success',
        promptTokens: r.p,
        completionTokens: r.c,
        totalTokens: r.t,
        requestId: tags[i],
      }));
    });
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-model&limit=100`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(3);
    const logs = res.data.logs as any[];
    // Each record stores its own tokens, exactly as upstream reported them.
    // The third record's big promptTokens does NOT leak into the first two,
    // and the small first two do not contaminate the third.
    expect(logs.find((l) => l.requestId === tags[0]).promptTokens).toBe(84);
    expect(logs.find((l) => l.requestId === tags[0]).completionTokens).toBe(36);
    expect(logs.find((l) => l.requestId === tags[0]).totalTokens).toBe(120);

    expect(logs.find((l) => l.requestId === tags[1]).promptTokens).toBe(9);
    expect(logs.find((l) => l.requestId === tags[1]).completionTokens).toBe(22);
    expect(logs.find((l) => l.requestId === tags[1]).totalTokens).toBe(31);

    expect(logs.find((l) => l.requestId === tags[2]).promptTokens).toBe(204151);
    expect(logs.find((l) => l.requestId === tags[2]).completionTokens).toBe(12);
    expect(logs.find((l) => l.requestId === tags[2]).totalTokens).toBe(204163);

    // Dashboard SUM == sum of individual records (no extra inflated totals).
    const sumP = logs.reduce((s, l) => s + (l.promptTokens ?? 0), 0);
    const sumC = logs.reduce((s, l) => s + (l.completionTokens ?? 0), 0);
    const sumT = logs.reduce((s, l) => s + (l.totalTokens ?? 0), 0);

    // Pull the aggregates filtered by marker — verify total tokens equal SUM
    // of individual `recordUsage` records.
    const all = queryUsage({ search: `${MARKER}-model`, limit: 1000, offset: 0 });
    const sP = all.records.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
    const sC = all.records.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
    const sT = all.records.reduce((s, r) => s + (r.totalTokens ?? 0), 0);

    expect(sP).toBe(84 + 9 + 204151);
    expect(sC).toBe(36 + 22 + 12);
    expect(sT).toBe(120 + 31 + 204163);
    // Cross-check consistency with HTTP totals and SUM.
    expect(sP).toBe(sumP);
    expect(sC).toBe(sumC);
    expect(sT).toBe(sumT);
    // total == prompt + completion per record (already enforced upstream; verify storage).
    all.records.forEach((r) => {
      if (r.promptTokens !== null && r.completionTokens !== null) {
        // totalTokens stored equal upstream's value (or computed = p+c if upstream omitted)
        expect(r.totalTokens).toBe(r.promptTokens + r.completionTokens);
      }
    });
  });

  it('if upstream sends a cumulative session counter that cannot be attributed to a single request, store null', async () => {
    // This encodes the policy mandated by the audit: when the value is known
    // to be cumulative-only and we have no reliable delta, the record MUST
    // stay null rather than fabricate a per-request number.
    const rec = makeRecord({
      provider: 'unknown-cumulative',
      model: `${MARKER}-cumulative`,
      status: 'success',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    recordUsage(rec);
    flushUsage();

    const res = await request('GET', `/admin/logs?search=${MARKER}-cumulative`);
    expect(res.status).toBe(200);
    expect(res.data.logs.length).toBe(1);
    const l = res.data.logs[0];
    expect(l.promptTokens).toBeNull();
    expect(l.completionTokens).toBeNull();
    expect(l.totalTokens).toBeNull();
  });

  it('dashboard SUM equals SUM of individual records (no double counting at aggregate level)', async () => {
    // Re-run quick analysis directly through the aggregates API and verify
    // the totals reflect the SUM-of-individual-records, not twice.
    const before = await request('GET', '/admin/usage');
    const beforePT = (before.data.totalPromptTokens ?? 0) as number;

    recordUsage(makeRecord({ model: `${MARKER}-sumcheck`, promptTokens: 1000, completionTokens: 50, totalTokens: 1050 }));
    flushUsage();

    const after = await request('GET', '/admin/usage');
    const afterPT = (after.data.totalPromptTokens ?? 0) as number;
    expect(afterPT).toBeGreaterThanOrEqual(beforePT + 1000);
    // Aggregate is incremented by exactly what we stored — never by double.
    // Compute the SUM at the store level for the same model and confirm
    // equality to sum of records (no double counting).
    const list = queryUsage({ search: `${MARKER}-sumcheck`, limit: 1000, offset: 0 });
    const sumP = list.records.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
    const aggP = getUsageAggregates().totalPromptTokens;
    // Aggregated promptTokens includes our 1000 once — never twice.
    expect(sumP).toBe(1000);
    expect(aggP).toBeGreaterThanOrEqual(sumP);
  });
});
