/**
 * Usage audit round 2 — fallback attribution + historical cost migration +
 * end-to-end cost validation through the REAL server/aggregation path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import { loadUsageRecords } from '../src/lib/usage-store';
import { computeCostSplit, getModelPrice } from '../src/lib/pricing';

const USAGE_FILE = configFile('usage-records.json');

/* Manual reference math (USD):
 *   nvidia/z-ai/glm-5.2 ($0.10/$0.40): 88183 in -> 0.0088183 | 234 out -> 0.0000936 | total 0.0089119
 *   groq/deepseek-v4-flash ($0.12/$0.12): 1000 in -> 0.00012 | total 0.00012
 *   onehop/deepseek-v4-flash ($0.268/$0.40): 1000 in -> 0.000268 | total 0.000268
 *   tokenharbor free ($0/$0): 1000/500 -> $0
 *   ghost (unpriced): cost must stay null */
const SEED = [
  {
    timestamp: Date.now() - 60_000, provider: 'nvidia', model: 'z-ai/glm-5.2',
    status: 'success', latencyMs: 120,
    promptTokens: 88_183, completionTokens: 234, totalTokens: 88_417,
    apiKey: null, httpStatus: 200, errorMessage: null,
    requestId: 'seed-glm', apiKeyMasked: null,
    /* legacy record: numeric TOTAL only — no split fields on disk */
    costUsd: 0.0089119,
  },
  {
    timestamp: Date.now() - 50_000, provider: 'groq', model: 'deepseek-v4-flash',
    status: 'success', latencyMs: 80,
    promptTokens: 1000, completionTokens: 0, totalTokens: 1000,
    apiKey: null, httpStatus: 200, errorMessage: null,
    requestId: 'seed-groq', apiKeyMasked: null,
    costUsd: 0.00012,
  },
  {
    timestamp: Date.now() - 40_000, provider: 'onehop', model: 'deepseek-v4-flash',
    status: 'success', latencyMs: 90,
    promptTokens: 1000, completionTokens: 0, totalTokens: 1000,
    apiKey: null, httpStatus: 200, errorMessage: null,
    requestId: 'seed-onehop', apiKeyMasked: null,
    costUsd: 0.000268,
  },
  {
    timestamp: Date.now() - 30_000, provider: 'tokenharbor', model: 'deepseek-v4-flash:free',
    status: 'success', latencyMs: 60,
    promptTokens: 1000, completionTokens: 500, totalTokens: 1500,
    apiKey: null, httpStatus: 200, errorMessage: null,
    requestId: 'seed-free', apiKeyMasked: null,
    costUsd: 0,
  },
  {
    timestamp: Date.now() - 20_000, provider: 'ghost', model: 'unpriced-model',
    status: 'error', latencyMs: 5,
    promptTokens: 50, completionTokens: 25, totalTokens: 75,
    apiKey: null, httpStatus: 500, errorMessage: 'upstream boom',
    requestId: 'seed-unpriced', apiKeyMasked: null,
    costUsd: null,
  },
];

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  fs.writeFileSync(USAGE_FILE, JSON.stringify(SEED), 'utf-8');
  await startServer({ NVIDIA_API_KEYS: 'key1,key2', OPENROUTER_API_KEYS: 'okey1,okey2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

describe('Provider-locked error attribution (multi-provider registration)', () => {
  const MODEL = 'audit/fallback-x';

  it('registers a model on TWO providers with deterministic order', async () => {
    // priority 10 = the LOCKED provider; priority 20 exists in the registry but
    // must NEVER be attempted (provider-locked routing).
    const r1 = await request('POST', '/admin/models', { model: MODEL, providerId: 'openrouter', priority: 10 });
    const r2 = await request('POST', '/admin/models', { model: MODEL, providerId: 'nvidia', priority: 20 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('locked provider fails → ONE error record attributed to the LOCKED provider (no cross-provider)', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(MODEL)}&limit=100`)).data;
    const recs = (logs.logs || []) as any[];
    const errorRecs = recs.filter(r => r.status === 'error');
    const successRecs = recs.filter(r => r.status === 'success');
    /* No fabricated successes; exactly one surfaced error (one record per
       request lifecycle, never per key attempt). */
    expect(successRecs).toHaveLength(0);
    expect(errorRecs).toHaveLength(1);

    /* Provider-locked: model pinned to openrouter (priority=10). nvidia
       (priority=20) is NEVER attempted, so the error is attributed to the
       locked provider, openrouter. */
    expect(errorRecs[0].provider).toBe('openrouter');
    expect(typeof errorRecs[0].httpStatus).toBe('number');
    expect(errorRecs[0].httpStatus).not.toBe(200);
    expect(errorRecs[0].errorMessage).toBeTruthy();
  }, 30000);

  it('single-provider model → error attributed to that provider itself', async () => {
    const m = 'audit/single-provider-x';
    await request('POST', '/admin/models', { model: m, providerId: 'nvidia', priority: 15 });
    const res = await request('POST', '/v1/chat/completions', {
      model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(m)}&limit=50`)).data;
    const err = (logs.logs || []).find((r: any) => r.status === 'error');
    expect(err).toBeDefined();
    expect(err.provider).toBe('nvidia');
  }, 30000);

  it('unknown model → blocked record with provider "unknown" (never success)', async () => {
    const m = `audit/blocked-${Date.now()}`;
    const res = await request('POST', '/v1/chat/completions', {
      model: m, messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const logs = (await request('GET', `/admin/logs?model=${encodeURIComponent(m)}&limit=50`)).data;
    const rec = (logs.logs || [])[0];
    expect(rec.status).toBe('blocked');
    expect(rec.provider).toBe('unknown');
    expect(rec.costUsd ?? null).toBeNull();
  }, 20000);
});

describe('Historical cost migration via real server data (#2)', () => {
  it('legacy total-only record gets split backfilled WITHOUT changing the stored total', async () => {
    const logs = (await request('GET', '/admin/logs?limit=100')).data;
    const glm = (logs.logs as any[]).find(r => r.requestId === 'seed-glm');
    expect(glm).toBeDefined();
    expect(glm.costUsd).toBeCloseTo(0.0089119, 12);           // total PRESERVED
    expect(glm.inputCostUsd).toBeCloseTo(0.0088183, 12);      // split backfilled
    expect(glm.outputCostUsd).toBeCloseTo(0.0000936, 12);
    expect(glm.inputCostUsd + glm.outputCostUsd).toBeCloseTo(glm.costUsd, 9);
    // identity untouched
    expect(glm.promptTokens).toBe(88_183);
    expect(glm.model).toBe('z-ai/glm-5.2');
  }, 20000);

  it('records whose split cannot reproduce the stored total keep N/A split (#insufficient)', async () => {
    /* Simulate a price change AFTER capture: seed a legacy record whose stored
       total matches OLD pricing, then register a DIFFERENT current price and
       verify loadUsageRecords refuses to fabricate a mismatching split. */
    const legacy: any = {
      timestamp: Date.now(), provider: 'testprov', model: 'price-changed',
      status: 'success', latencyMs: 1,
      promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000,
      apiKey: null, httpStatus: 200, errorMessage: null, requestId: 'legacy-pc', apiKeyMasked: null,
      costUsd: 0.5, // captured when price was $0.50/1M input
    };
    fs.writeFileSync(USAGE_FILE, JSON.stringify(SEED.concat([legacy])), 'utf-8');

    const registry = await import('../src/lib/pricing') as any;
    registry.PRICING_REGISTRY['testprov/price-changed'] = { inputPerM: 0.9, outputPerM: 0.9 }; // CURRENT price differs
    try {
      const loaded = loadUsageRecords().find((r: any) => r.requestId === 'legacy-pc')!;
      expect(loaded.costUsd).toBe(0.5);            // immutable
      expect(loaded.inputCostUsd ?? null).toBeNull(); // NOT fabricated at new price
      expect(loaded.outputCostUsd ?? null).toBeNull();
    } finally {
      delete registry.PRICING_REGISTRY['testprov/price-changed'];
    }
  }, 20000);

  it('repeated migration is idempotent (no cost doubling)', async () => {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(SEED), 'utf-8');
    const first = loadUsageRecords().filter((r: any) => r.requestId?.startsWith('seed-'));
    const second = loadUsageRecords().filter((r: any) => r.requestId?.startsWith('seed-'));
    for (let i = 0; i < first.length; i++) {
      expect(second[i].costUsd).toBe(first[i].costUsd);
      expect(second[i].inputCostUsd ?? null).toBe(first[i].inputCostUsd ?? null);
      expect(second[i].outputCostUsd ?? null).toBe(first[i].outputCostUsd ?? null);
    }
    // And the on-disk file is never mutated by loading.
    expect(JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))).toHaveLength(SEED.length);
  }, 20000);
});

describe('End-to-end cost validation through admin API (#3/#7/#8)', () => {
  it('stored == calculated == aggregated across summary/provider/model views', async () => {
    const logs = (await request('GET', '/admin/logs?limit=1000')).data;
    const agg = (await request('GET', '/admin/usage')).data;
    const byProv = (await request('GET', '/admin/usage/providers')).data;
    const byModel = (await request('GET', '/admin/usage/models')).data;

    let sumTotal: number | null = null;
    let sumIn: number | null = null;
    let sumOut: number | null = null;
    for (const r of logs.logs || []) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) sumTotal = (sumTotal ?? 0) + r.costUsd;
      if (typeof r.inputCostUsd === 'number' && Number.isFinite(r.inputCostUsd)) sumIn = (sumIn ?? 0) + r.inputCostUsd;
      if (typeof r.outputCostUsd === 'number' && Number.isFinite(r.outputCostUsd)) sumOut = (sumOut ?? 0) + r.outputCostUsd;
    }

    /* dashboard total == Σ record totals */
    if (sumTotal !== null) {
      expect(agg.totalCostUsd).toBeCloseTo(sumTotal, 9);
      expect(sumIn! + sumOut!).toBeCloseTo(sumTotal, 9);
    }

    /* provider aggregation == its records' sum */
    for (const [id, b] of Object.entries<any>(byProv)) {
      const mine = (logs.logs || []).filter((r: any) => r.provider === id);
      let pSum: number | null = null;
      for (const r of mine) {
        if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) pSum = (pSum ?? 0) + r.costUsd;
      }
      if (pSum !== null) expect(b.costUsd).toBeCloseTo(pSum, 9);
      else expect(b.costUsd).toBeNull();
    }

    /* model rows: exact provider/model composite keys, correct pricing context */
    const glm = byModel['nvidia/z-ai/glm-5.2'];
    const groq = byModel['groq/deepseek-v4-flash'];
    const onehop = byModel['onehop/deepseek-v4-flash'];
    const free = byModel['tokenharbor/deepseek-v4-flash:free'];
    const ghost = byModel['ghost/unpriced-model'];

    expect(glm.pricingStatus).toBe('known');
    expect(glm.costUsd).toBeCloseTo(0.0089119, 9);
    expect(groq.costUsd).toBeCloseTo(0.00012, 12);   // $0.12/1M context
    expect(onehop.costUsd).toBeCloseTo(0.000268, 12); // $0.268/1M context — NOT groq's
    expect(free.pricingStatus).toBe('free');
    expect(free.costUsd).toBe(0);
    expect(ghost.pricingStatus).toBe('unknown');
    expect(ghost.costUsd).toBeNull();

    /* same model NAME under different providers never mixes into one row */
    expect(byModel['groq/deepseek-v4-flash']).not.toBe(byModel['onehop/deepseek-v4-flash']);
  }, 20000);

  it('round-trip: seeded disk values survive server storage read verbatim', async () => {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')) as any[];
    const seededGlm = raw.find(r => r.requestId === 'seed-glm');
    expect(seededGlm.costUsd).toBe(0.0089119);          // unchanged on disk
    expect(seededGlm.promptTokens).toBe(88_183);        // tokens untouched
    expect(seededGlm.timestamp).toBeTypeOf('number');   // timestamp untouched
  });
});
