/**
 * Token Cost Display — regression tests.
 *
 * Requirements:
 *   - Cost is computed per request from provider + exact model + that request's
 *     tokens: (prompt_tokens × input$/1M) + (completion_tokens × output$/1M).
 *   - Unknown prices are stored/rendered as N/A (null), never fabricated as $0.
 *   - Dashboard aggregates only SUM individual per-request costUsd values.
 *   - Token tracking is untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordUsage,
  flushUsage,
  getAllUsage,
  getUsageAggregates,
  getUsageByProvider,
  getUsageByModel,
  loadUsageRecords,
  UsageRecord,
} from '../src/lib/usage-store';
import { computeCostUsd, getModelPrice, costForRecord } from '../src/lib/pricing';
import { __test } from '../src/admin/dashboard';

const USAGE_FILE = configFile('usage-records.json');

function makeRecord(partial: Partial<UsageRecord>): UsageRecord {
  const has = (k: keyof UsageRecord) => partial[k] !== undefined;
  return {
    timestamp: has('timestamp') ? partial.timestamp! : Date.now(),
    provider: has('provider') ? partial.provider! : 'nvidia',
    model: has('model') ? partial.model! : 'test-model',
    status: has('status') ? partial.status! : 'success',
    latencyMs: has('latencyMs') ? partial.latencyMs! : 10,
    promptTokens: has('promptTokens') ? partial.promptTokens! : 1000,
    completionTokens: has('completionTokens') ? partial.completionTokens! : 100,
    totalTokens: has('totalTokens') ? partial.totalTokens! : 1100,
    apiKey: has('apiKey') ? partial.apiKey! : null,
    httpStatus: has('httpStatus') ? partial.httpStatus! : 200,
    errorMessage: has('errorMessage') ? partial.errorMessage! : null,
    requestId: has('requestId') ? partial.requestId! : null,
    apiKeyMasked: has('apiKeyMasked') ? partial.apiKeyMasked! : null,
    costUsd: partial.costUsd,
  };
}

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

const promptOf = (r: UsageRecord) => r.promptTokens ?? 0;
const completionOf = (r: UsageRecord) => r.completionTokens ?? 0;

describe('Token cost — pricing math', () => {
  it('computes (prompt×input) + (completion×output) per 1M tokens', () => {
    /* nvidia/z-ai/glm-5.2 = $0.10/1M in, $0.40/1M out */
    const cost = computeCostUsd('nvidia', 'z-ai/glm-5.2', 1_000_000, 1_000_000);
    expect(cost).toBe(0.5);
  });

  it('returns null when price is unknown (never fabricates a $0)', () => {
    expect(computeCostUsd('unknown-provider', 'some/model', 100, 5)).toBeNull();
  });

  it('returns null when tokens are null (no estimate from nothing)', () => {
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', null, null)).toBeNull();
  });

  it('returns null when only one token dimension is available', () => {
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', 100, null)).toBeNull();
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', null, 100)).toBeNull();
  });

  it('returns 0 only for explicitly-free models', () => {
    /* tokenharbor/deepseek-v4-flash:free has a known $0 price. */
    const cost = computeCostUsd('tokenharbor', 'deepseek-v4-flash:free', 100, 100);
    expect(cost).toBe(0);
  });

  it('getModelPrice resolves provider-exact only', () => {
    expect(getModelPrice('NVIDIA', 'z-ai/glm-5.2')).toEqual({ inputPerM: 0.1, outputPerM: 0.4 });
    expect(getModelPrice('nvidia', 'unregistered-model')).toBeUndefined();
    expect(getModelPrice('unknown-prov', 'whatever')).toBeUndefined();
  });

  it('keeps micro-cost precision until UI formatting', () => {
    const cost = computeCostUsd('nvidia', 'z-ai/glm-5.2', 1, 1);
    /* Full IEEE-754 result is kept (no early rounding). The mathematically
       exact value is 5e-7; JS floating math yields 5.000000000000001e-7.
       Both are non-zero and within 1e-15 — that is the point of the test. */
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.0000005, 15);
    expect(cost).not.toBe(0);
  });

  it('resolves gorouter/claude-opus-4-8 at $5/1M in, $25/1M out', () => {
    expect(getModelPrice('gorouter', 'claude-opus-4-8')).toEqual({ inputPerM: 5, outputPerM: 25 });
    /* Case-insensitive provider/model, still exact — no provider-wide default:
       another gorouter model must stay unknown. */
    expect(getModelPrice('GoRouter', 'Claude-Opus-4-8')).toEqual({ inputPerM: 5, outputPerM: 25 });
    expect(getModelPrice('gorouter', 'some-other-model')).toBeUndefined();
  });

  it('computes the real gorouter/claude-opus-4-8 record cost', () => {
    /* (88183 × 5 / 1e6) + (234 × 25 / 1e6)
       = 0.440915 + 0.00585 = 0.446765 */
    const cost = computeCostUsd('gorouter', 'claude-opus-4-8', 88_183, 234);
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.446765, 10);
    /* Output tokens are priced at the OUTPUT rate — never totalTokens × input. */
    expect(cost).not.toBeCloseTo((88_183 + 234) * 5 / 1e6, 10);
  });

  it('keeps unknown gorouter models null (no provider-wide default price)', () => {
    expect(computeCostUsd('gorouter', 'zz-unregistered-model', 1000, 100)).toBeNull();
  });
});

describe('Token cost — stored per request, aggregated by sum', () => {
  const MARKER = `cost-test-${Date.now()}`;

  it('stores costUsd on each record independently', () => {
    const a = makeRecord({ model: `${MARKER}-m1`, provider: 'nvidia', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
    const b = makeRecord({ model: `${MARKER}-m2`, provider: 'nvidia', promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 });
    /* nvidia/z-ai/glm-5.2 = $0.10/1M in, $0.40/1M out */
    a.model = 'z-ai/glm-5.2';
    b.model = 'z-ai/glm-5.2';
    recordUsage(a);
    recordUsage(b);
    flushUsage();

    const recs = getAllUsage().filter(r => r.model === 'z-ai/glm-5.2' && r.provider === 'nvidia' && (promptOf(r) >= 1_000_000 || completionOf(r) >= 1_000_000));
    expect(recs.length).toBe(2);
    const m1 = recs.find(r => (r.promptTokens ?? 0) >= 1_000_000)!;
    const m2 = recs.find(r => (r.completionTokens ?? 0) >= 1_000_000)!;
    expect(m1.costUsd).toBe(0.1);   /* 1M × $0.10/1M */
    expect(m2.costUsd).toBe(0.4);   /* 1M × $0.40/1M */
  });

  it('does not use cumulative tokens for the second request', () => {
    const model = 'z-ai/glm-5.2';
    const tag = `no-cumulative-${Date.now()}`;
    const a = makeRecord({ provider: 'nvidia', model, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, requestId: `${tag}-a` });
    const b = makeRecord({ provider: 'nvidia', model, promptTokens: 2000, completionTokens: 1000, totalTokens: 3000, requestId: `${tag}-b` });
    recordUsage(a);
    recordUsage(b);
    flushUsage();
    /* recordUsage stores an immutable copy; read the persisted records back. */
    const storedA = getAllUsage().find(r => r.requestId === `${tag}-a`)!;
    const storedB = getAllUsage().find(r => r.requestId === `${tag}-b`)!;
    expect(storedA.costUsd).toBe(computeCostUsd('nvidia', model, 1000, 500));
    expect(storedB.costUsd).toBe(computeCostUsd('nvidia', model, 2000, 1000));
    /* B must NOT be computed from cumulative tokens (3000 + 1500). */
    expect(storedB.costUsd).not.toBe(computeCostUsd('nvidia', model, 3000, 1500));
  });

  it('records known-price cost and unknown-price null coexist', () => {
    const known = makeRecord({ model: 'z-ai/glm-5.2', provider: 'nvidia', promptTokens: 10, completionTokens: 5 });
    const unknown = makeRecord({ model: `zz-unknown-${MARKER}`, provider: 'no-such-provider', promptTokens: 10, completionTokens: 5 });
    recordUsage(known);
    recordUsage(unknown);
    flushUsage();
    const recs = getAllUsage().filter(r => r.model === 'z-ai/glm-5.2' || r.model === `zz-unknown-${MARKER}`);
    expect(recs.find(r => r.model === 'z-ai/glm-5.2' && r.provider === 'nvidia')!.costUsd).not.toBeNull();
    expect(recs.find(r => r.model === `zz-unknown-${MARKER}`)!.costUsd).toBeNull();
  });

  it('backfills legacy priced records (costUsd absent) from their own tokens', () => {
    /* Records written before the cost feature carry no `costUsd` field. Their
       per-request tokens are already persisted, so the cost is recomputed from
       the SAME tokens with current pricing — no fabricated tokens, no $0 guess.
       nvidia/z-ai/glm-5.2 = $0.10/1M in, $0.40/1M out. */
    const legacy = makeRecord({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
    delete legacy.costUsd;
    fs.writeFileSync(USAGE_FILE, JSON.stringify([legacy]), 'utf-8');
    const before = fs.readFileSync(USAGE_FILE, 'utf-8');
    const loaded = loadUsageRecords().find(r => r.model === 'z-ai/glm-5.2');
    expect(loaded).toBeDefined();
    expect(loaded?.costUsd).toBe(0.1);
    /* Read-only enrichment: the on-disk file must not be mutated by a load. */
    expect(fs.readFileSync(USAGE_FILE, 'utf-8')).toBe(before);
  });

  it('leaves legacy unpriced records as null (never a fabricated $0)', () => {
    const legacy = makeRecord({ provider: 'no-such-provider', model: `legacy-unpriced-${MARKER}`, promptTokens: 10, completionTokens: 5 });
    delete legacy.costUsd;
    fs.writeFileSync(USAGE_FILE, JSON.stringify([legacy]), 'utf-8');
    const loaded = loadUsageRecords().find(r => r.model === legacy.model);
    expect(loaded).toBeDefined();
    expect(loaded?.costUsd).toBeNull();
  });

  it('never overwrites an already-recorded numeric costUsd (immutable at request time)', () => {
    /* A record that already carries a numeric costUsd is the source of truth
       and must be preserved verbatim — even if current pricing would compute a
       different value. A `null` cost, by contrast, means "no price was known at
       request time" and IS eligible for recomputation (see backfill test). */
    const withCost = makeRecord({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, costUsd: 999 });
    const zeroCost = makeRecord({ provider: 'tokenharbor', model: 'deepseek-v4-flash:free', promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500, costUsd: 0 });
    fs.writeFileSync(USAGE_FILE, JSON.stringify([withCost, zeroCost]), 'utf-8');
    const loaded = loadUsageRecords();
    expect(loaded[0].costUsd).toBe(999);
    /* $0 is a real, known price and must not be treated as "missing". */
    expect(loaded[1].costUsd).toBe(0);
  });

  it('recomputes historical records whose costUsd is null once a price exists', () => {
    /* Real-world case: gorouter/claude-opus-4-8 requests were recorded before
       the price was registered, so they carry costUsd: null while their tokens
       are intact. Loading must reprice them from those SAME tokens. */
    const historical = makeRecord({
      provider: 'gorouter', model: 'claude-opus-4-8',
      promptTokens: 88_183, completionTokens: 234, totalTokens: 88_417,
      timestamp: 1_700_000_000_000, requestId: 'historical-gorouter',
      costUsd: null,
    });
    fs.writeFileSync(USAGE_FILE, JSON.stringify([historical]), 'utf-8');
    const before = fs.readFileSync(USAGE_FILE, 'utf-8');
    const loaded = loadUsageRecords()[0];
    expect(loaded.costUsd).toBeCloseTo(0.446765, 10);
    /* Nothing else may change. */
    expect(loaded.promptTokens).toBe(88_183);
    expect(loaded.completionTokens).toBe(234);
    expect(loaded.totalTokens).toBe(88_417);
    expect(loaded.provider).toBe('gorouter');
    expect(loaded.model).toBe('claude-opus-4-8');
    expect(loaded.timestamp).toBe(1_700_000_000_000);
    /* Read-only enrichment: the on-disk file must not be mutated by a load. */
    expect(fs.readFileSync(USAGE_FILE, 'utf-8')).toBe(before);
  });

  it('leaves a null cost null when the price is still unknown', () => {
    const unpriced = makeRecord({ provider: 'no-such-provider', model: `still-unpriced-${MARKER}`, promptTokens: 10, completionTokens: 5, costUsd: null });
    fs.writeFileSync(USAGE_FILE, JSON.stringify([unpriced]), 'utf-8');
    expect(loadUsageRecords()[0].costUsd).toBeNull();
  });

  it('dashboard totals = SUM of per-request costUsd (individual, not cumulative)', async () => {
    const res = await request('GET', `/admin/usage`);
    expect(res.status).toBe(200);
    const agg = (await request('GET', '/admin/usage')).data;
    expect(agg).toHaveProperty('totalCostUsd');
    /* Sum all stored costUsd values by hand and compare with aggregate. */
    const allRecs = getAllUsage();
    let sumKnown = 0;
    let anyKnown = false;
    for (const r of allRecs) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
        sumKnown += r.costUsd;
        anyKnown = true;
      }
    }
    if (anyKnown) {
      expect(agg.totalCostUsd).toBeCloseTo(sumKnown, 6);
    }
  });

  it('provider/model aggregation exposes costUsd', () => {
    const byProv = getUsageByProvider();
    const byModel = getUsageByModel();
    for (const id of Object.keys(byProv)) {
      expect(byProv[id]).toHaveProperty('costUsd');
    }
    for (const id of Object.keys(byModel)) {
      expect(byModel[id]).toHaveProperty('costUsd');
    }
  });

  it('sums individual costs independently for one provider and one model', () => {
    const provider = 'nvidia';
    const model = 'z-ai/glm-5.2';
    const records = [
      makeRecord({ provider, model, promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }),
      makeRecord({ provider, model, promptTokens: 2_000_000, completionTokens: 0, totalTokens: 2_000_000 }),
    ];
    records.forEach(recordUsage);
    const expected = getAllUsage()
      .filter(record => record.provider === provider && record.model === model)
      .reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    expect(getUsageByProvider()[provider].costUsd).toBe(expected);
    expect(getUsageByModel()[`${provider}/${model}`].costUsd).toBe(expected);
  });

  it('deduplicates repeated records with the same request ID', () => {
    const requestId = `duplicate-${MARKER}`;
    const a = makeRecord({ provider: 'nvidia', model: 'z-ai/glm-5.2', requestId, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    const b = makeRecord({ provider: 'nvidia', model: 'z-ai/glm-5.2', requestId, promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 });
    recordUsage(a);
    recordUsage(b);
    const matches = getAllUsage().filter(record => record.requestId === requestId);
    expect(matches).toHaveLength(1);
    expect(matches[0].promptTokens).toBe(1000);
  });
});

describe('Token cost — frontend renderers', () => {
  it('fmtCost formats small USD values and N/A for null/unknown', () => {
    const { fmtCost } = __test;
    expect(fmtCost(null)).toBe('N/A');
    expect(fmtCost(undefined)).toBe('N/A');
    expect(fmtCost(0)).toBe('$0.000');
    expect(fmtCost(0.001)).toBe('$0.001');
    expect(fmtCost(0.0000005)).toBe('$0.0000005');
    expect(fmtCost(12.5)).toBe('$12.500');
  });

  it('renderLogsHTML shows Est. Cost column', () => {
    const ts = Date.now();
    const html = __test.renderLogsHTML({
      total: 1,
      logs: [{
        timestamp: ts, provider: 'nvidia', model: 'z-ai/glm-5.2',
        status: 'success' as const, latencyMs: 5,
        promptTokens: 100, completionTokens: 100, totalTokens: 200,
        apiKey: null, httpStatus: 200, errorMessage: null, costUsd: 0.005,
      }],
    }, 0);
    expect(html).toContain('$0.005');
  });

  it('renderUsageSummaryHTML includes Est. Cost (Total) card', () => {
    const html = __test.renderUsageSummaryHTML({
      totalRequests: 1, totalSuccess: 1, totalFailed: 0, totalBlocked: 0,
      totalPromptTokens: 100, totalCompletionTokens: 100, totalTokens: 200,
      avgLatencyMs: 1, totalCostUsd: 0.5,
    });
    expect(html).toContain('Est. Cost (Total)');
    expect(html).toContain('$0.5');
  });
});

describe('Token cost — costForRecord consistency', () => {
  it('costForRecord uses the same inputs as recordUsage', () => {
    const rec = makeRecord({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 500_000, completionTokens: 250_000 });
    const expected = computeCostUsd(rec.provider, rec.model, rec.promptTokens, rec.completionTokens);
    expect(costForRecord(rec)).toBe(expected);
  });

  it('prices a freshly recorded gorouter/claude-opus-4-8 request end to end', () => {
    const requestId = `gorouter-live-${Date.now()}`;
    recordUsage(makeRecord({
      provider: 'gorouter', model: 'claude-opus-4-8',
      promptTokens: 88_183, completionTokens: 234, totalTokens: 88_417,
      requestId,
    }));
    flushUsage();
    const stored = getAllUsage().find(r => r.requestId === requestId)!;
    expect(stored.costUsd).toBeCloseTo(0.446765, 10);
    /* Tokens and identity are stored verbatim. */
    expect(stored.promptTokens).toBe(88_183);
    expect(stored.completionTokens).toBe(234);
    expect(stored.totalTokens).toBe(88_417);
    expect(stored.provider).toBe('gorouter');
    expect(stored.model).toBe('claude-opus-4-8');
    /* And it aggregates into the provider/model breakdowns. */
    expect(getUsageByProvider()['gorouter'].costUsd).toBeGreaterThan(0);
    expect(getUsageByModel()['gorouter/claude-opus-4-8'].costUsd).toBeGreaterThan(0);
  });
});
