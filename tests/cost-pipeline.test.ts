/* ============================================================================
 * Cost pipeline — usage → pricing → cost → aggregation → Admin Overview.
 *
 * Guards the exact freeze scenario this suite was written for: a dashboard
 * whose token totals keep growing while "Est. Cost (Total)" never moves,
 * because every NEW usage record was written with costUsd = null (unknown
 * pricing for the provider/model pairs carrying the traffic).
 *
 * Contract (mirrors src/lib/pricing.ts + usage-store semantics):
 *   - A known (provider, model) price MUST attach a real cost to every new
 *     record AT RECORD TIME, and every aggregate (incl. /admin/usage via
 *     getUsageAggregates) MUST grow by exactly that cost. No cap, no stale
 *     snapshot, no early rounding.
 *   - Large traffic (billions of tokens) must not break the math.
 *   - Unknown pricing stays null — NEVER a fabricated $0, and never blocks
 *     other providers from contributing to the aggregate.
 *   - Pricing is looked up by the EXACT provider + model pair; aliases,
 *     bare model ids under a different provider, or wrong-case variants
 *     must not silently pick a price.
 * ========================================================================== */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import {
  recordUsage,
  flushUsage,
  getAllUsage,
  loadUsageRecords,
  getUsageAggregates,
  getUsageByModel,
  type UsageRecord,
} from '../src/lib/usage-store';
import { computeCostUsd, computeCostSplit, getModelPrice, getPricingStatus, PRICING_REGISTRY } from '../src/lib/pricing';
import { upsertPricing, deletePricing, setPricingEnabled, reloadPricingCache } from '../src/lib/pricing-store';
import { configFile } from './setup';

const USAGE_FILE = configFile('usage-records.json');
const PRICING_FILE = configFile('model-pricing.json');

/* Synthetic pairs only — the test store is a throwaway (vitest DATA_DIR in
   os.tmpdir). NOTHING here registers a price for a real production model. */
const SYN_PROV_A = 'unit-test-prov';
const SYN_PROV_B = 'unit-test-prov-b';
const SYN_MODEL = 'syn/model-alpha';   /* same model id, two providers */
const SYN_IN = 1, SYN_OUT = 2;         /* ${SYN_IN}/${SYN_OUT} per 1M */
const SYN_B_IN = 10, SYN_B_OUT = 20;   /* ten times the price */
const SYN_KIE_MODEL = 'e2e-kie-test-model'; /* synthetic id on the real kie.ai provider id */

let seq = 0;
function mk(partial: Partial<UsageRecord> & { provider: string; model: string }): UsageRecord {
  return {
    timestamp: Date.now(),
    status: 'success',
    latencyMs: 10,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    apiKey: null,
    requestId: `cp-${++seq}-${partial.provider}-${partial.model}`,
    ...partial,
  } as UsageRecord;
}

function base(prices: number) { return prices / 1e6; }

beforeAll(() => {
  for (const f of [USAGE_FILE, PRICING_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
  reloadPricingCache();
});

afterAll(() => {
  for (const id of [`${SYN_PROV_A}/${SYN_MODEL}`, `${SYN_PROV_B}/${SYN_MODEL}`, `kie.ai/${SYN_KIE_MODEL}`]) {
    deletePricing(id);
  }
  for (const f of [USAGE_FILE, PRICING_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
  reloadPricingCache();
});

describe('cost pipeline — valid pricing produces and aggregates cost (A/B/C/F/H/I/J/K)', () => {
  it('A: known registry price → new record gets cost > 0, computed at record time', () => {
    /* nvidia/z-ai/glm-5.2 is a REAL registry price: $0.1/$0.4 per 1M. */
    recordUsage(mk({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 1_500_000, completionTokens: 250_000, totalTokens: 1_750_000 }));
    const rec = getAllUsage().find(r => r.requestId?.startsWith('cp-1'))!;
    expect(rec.costUsd).toBeCloseTo(0.15 + 0.1, 12);
    expect(rec.inputCostUsd).toBeCloseTo(0.15, 12);
    expect(rec.outputCostUsd).toBeCloseTo(0.1, 12);
    expect(getModelPrice('nvidia', 'z-ai/glm-5.2')).toEqual({ inputPerM: 0.1, outputPerM: 0.4 });
  });

  it('B: incremental usage grows the aggregate by exactly the new record cost', () => {
    const before = getUsageAggregates();
    expect(before.totalCostUsd).not.toBeNull();
    recordUsage(mk({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 }));
    const after = getUsageAggregates();
    expect(after.totalCostUsd! - before.totalCostUsd!).toBeCloseTo(0.1 + 0.2, 12);
  });

  it('C: aggregate cost equals the SUM of the individual record costs across multiple models', () => {
    upsertPricing(SYN_PROV_A, SYN_MODEL, SYN_IN, SYN_OUT);
    upsertPricing(SYN_PROV_B, SYN_MODEL, SYN_B_IN, SYN_B_OUT);
    recordUsage(mk({ provider: SYN_PROV_A, model: SYN_MODEL, promptTokens: 2_000_000, completionTokens: 1_000_000, totalTokens: 3_000_000 }));
    recordUsage(mk({ provider: SYN_PROV_B, model: SYN_MODEL, promptTokens: 3_000_000, completionTokens: 500_000, totalTokens: 3_500_000 }));
    const sum = getAllUsage().reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
    /* a: 2M*1 + 1M*2 = 4   b: 3M*10 + 0.5M*20 = 40 */
    expect(getUsageAggregates().totalCostUsd).toBeCloseTo(sum, 9);
    const expected = base(2_000_000 * SYN_IN + 1_000_000 * SYN_OUT) + base(3_000_000 * SYN_B_IN + 500_000 * SYN_B_OUT);
    /* A (0.25) + B (0.30) contributed before this test */
    expect(getUsageAggregates().totalCostUsd).toBeCloseTo(expected + 0.25 + 0.3, 9);
  });

  it('F: pricing resolves by the exact provider+model pair, same model on two providers uses its own price', () => {
    expect(computeCostUsd(SYN_PROV_A, SYN_MODEL, 1_000_000, 0)).toBeCloseTo(SYN_IN, 12);
    expect(computeCostUsd(SYN_PROV_B, SYN_MODEL, 0, 1_000_000)).toBeCloseTo(SYN_B_OUT, 12);
  });

  it('H: micro costs survive full float precision (no integer division, no early rounding)', () => {
    /* 1 prompt token at $0.1/1M = $1e-7 — must NOT collapse to 0. */
    const one = computeCostUsd(SYN_PROV_A, SYN_MODEL, 1, 1)!;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeCloseTo(base(SYN_IN) + base(SYN_OUT), 18);
    const split = computeCostSplit('nvidia', 'z-ai/glm-5.2', 3, 7);
    /* full-rate math: 3 tokens * $0.1/1M = 3e-7 */
    expect(split!.inputCostUsd).toBeCloseTo(3 * 0.1 / 1e6, 18);
    expect(split!.outputCostUsd).toBeCloseTo(7 * 0.4 / 1e6, 18);
  });

  it('I: billions of tokens (real-world scale) price correctly and stay finite', () => {
    const rec = mk({ provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 3_270_669_810, completionTokens: 14_597_039, totalTokens: 3_285_296_879 });
    recordUsage(rec);
    const stored = getAllUsage().find(r => r.requestId === rec.requestId)!;
    const expectIn = 3_270_669_810 * 0.1 / 1e6;   /* ≈ $327.07 */
    const expectOut = 14_597_039 * 0.4 / 1e6;    /* ≈ $5.84  */
    expect(stored.costUsd).toBeCloseTo(expectIn + expectOut, 9);
    expect(Number.isFinite(stored.costUsd!)).toBe(true);
    const agg = getUsageAggregates();
    expect(Number.isFinite(agg.totalCostUsd!)).toBe(true);
    expect(agg.totalCostUsd!).toBeGreaterThan(expectIn);
    /* the token totals and the cost moved together on the SAME record: */
    expect(agg.totalPromptTokens).toBeGreaterThanOrEqual(3_270_669_810);
  });

  it('J: Admin Overview aggregation grows when a new priced record is added', () => {
    /* routes/admin.ts GET /admin/usage (no filters) answers with
       getUsageAggregates() — the exact source of the Est. Cost (Total) card. */
    const before = getUsageAggregates();
    recordUsage(mk({ provider: SYN_PROV_A, model: SYN_MODEL, promptTokens: 7_000_000, completionTokens: 900_000, totalTokens: 7_900_000 }));
    const after = getUsageAggregates();
    const added = 7_000_000 * SYN_IN / 1e6 + 900_000 * SYN_OUT / 1e6;
    expect(after.totalCostUsd! - before.totalCostUsd!).toBeCloseTo(added, 9);
    /* cost fields must also stay in lockstep (input/output split) */
    expect(after.totalInputCostUsd! - before.totalInputCostUsd!).toBeCloseTo(7_000_000 * SYN_IN / 1e6, 9);
    expect(after.totalOutputCostUsd! - before.totalOutputCostUsd!).toBeCloseTo(900_000 * SYN_OUT / 1e6, 9);
  });

  it('K: pre-existing registry providers keep computing cost (regression)', () => {
    for (const key of ['gorouter/claude-opus-4-8', 'openrouter/anthropic/claude-fable-5', 'kilo/deepseek-v4-flash'] as const) {
      const [p, ...rest] = key.split('/');
      const m = rest.join('/');
      const price = PRICING_REGISTRY[key as keyof typeof PRICING_REGISTRY];
      const cost = computeCostUsd(p, m, 1_000_000, 1_000_000)!;
      expect(getPricingStatus(p, m)).toBe('known');
      expect(cost).toBeCloseTo(price.inputPerM! + price.outputPerM!, 12);
    }
  });
});

describe('cost pipeline — unknown pricing never fabricates and never blocks others (D/E/G/L/M)', () => {
  it('D: a record without pricing stores costUsd null, does not crash, and is NOT counted as $0', () => {
    const before = getUsageAggregates();
    recordUsage(mk({ provider: 'unknown-provider-xyz', model: 'some/unpriced-model', promptTokens: 500_000, completionTokens: 500_000, totalTokens: 1_000_000 }));
    const after = getUsageAggregates();
    expect(getModelPrice('unknown-provider-xyz', 'some/unpriced-model')).toBeUndefined();
    const rec = getAllUsage().find(r => r.provider === 'unknown-provider-xyz')!;
    expect(rec.costUsd).toBeNull();
    expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd!, 12); /* unchanged, not diluted */
    /* a half-known pair (price unknown, tokens present) behaves the same */
    recordUsage(mk({ provider: 'kie.ai', model: 'claude-fable-5.1', promptTokens: 2_000_000, completionTokens: 0, totalTokens: 2_000_000 }));
    expect(getPricingStatus('kie.ai', 'claude-fable-5.1')).toBe('unknown');
    expect(getAllUsage().find(r => r.provider === 'kie.ai' && r.model === 'claude-fable-5.1')!.costUsd).toBeNull();
  });

  it('E: cached-input tokens are priced at the full input rate — no cached discount is invented', () => {
    /* The registry models only input/output rates (no cached pricing field),
       so the pipeline must NOT silently apply any cached discount: cost for
       1M prompt tokens === exactly inputPerM. */
    expect(computeCostSplit('nvidia', 'z-ai/glm-5.2', 1_000_000, 0)!.inputCostUsd).toBeCloseTo(0.1, 15);
  });

  it('G: provider stays EXACT while equivalent alias forms of the same registered model resolve; a different model or provider never borrows a price', () => {
    /* alias-normalized hits on the built-in registry */
    expect(computeCostUsd('openrouter', 'x-ai/grok-4.6', 1_000_000, 0)).toBeCloseTo(3, 12);      /* ← 'openrouter/grok-4.6' */
    expect(computeCostUsd('nvidia', 'glm-5-2', 1_000_000, 0)).toBeCloseTo(0.1, 12);              /* ← 'nvidia/z-ai/glm-5.2' */
    expect(getPricingStatus('nvidia', 'nvidia/z-ai/glm-5.2')).toBe('known');                     /* double-prefixed request form */
    /* genuinely different ids stay unknown */
    expect(getModelPrice('openrouter', 'x-ai/grok-4.7')).toBeUndefined();
    expect(getModelPrice('grok-4.6', 'openrouter')).toBeUndefined();                             /* swapped halves never match */
    expect(getModelPrice('nvidia', 'anthropic/claude-fable-5')).toBeUndefined();                 /* another provider's key never leaks */
    /* case-insensitive exact matching still WORKS */
    expect(computeCostUsd('NVIDIA', 'Z-AI/GLM-5.2', 1_000_000, 0)).toBeCloseTo(0.1, 12);
    expect(getPricingStatus('unit-test-prov', 'SYN/MODEL-ALPHA')).toBe('known');
  });

  it('G+: a stored admin entry is reachable through its alias form and keeps override semantics', () => {
    upsertPricing('unit-alias-prov', 'vendor/e2e.mod-x', 7, 14);
    /* requested as de-prefixed / dot-dash variants of the same pair */
    expect(getPricingStatus('unit-alias-prov', 'e2e-mod-x')).toBe('known');
    expect(computeCostUsd('unit-alias-prov', 'e2e-mod-x', 1_000_000, 1_000_000)).toBeCloseTo(21, 12);
    /* explicit $0 free override reached by alias form → free, not unknown */
    upsertPricing('unit-alias-prov', 'e2e.mod-x', 0, 0);   /* exact store hit wins over the 7/14 alias entry */
    expect(getPricingStatus('unit-alias-prov', 'e2e.mod-x')).toBe('free');
    deletePricing('unit-alias-prov/vendor/e2e.mod-x');
    deletePricing('unit-alias-prov/e2e.mod-x');
  });

  it('G++: equivalent variants registered with DIFFERENT prices are ambiguous → unknown, never a guess', () => {
    upsertPricing('unit-amb-prov', 'z.0-neutron', 1, 2);
    upsertPricing('unit-amb-prov', 'z-0-neutron', 8, 9);
    /* exact forms keep their own prices */
    expect(computeCostUsd('unit-amb-prov', 'z.0-neutron', 1_000_000, 0)).toBeCloseTo(1, 12);
    expect(computeCostUsd('unit-amb-prov', 'z-0-neutron', 1_000_000, 0)).toBeCloseTo(8, 12);
    /* a third equivalent form matches BOTH → ambiguous → null */
    const reqVariant = 'z.0.neutron';
    expect(getPricingStatus('unit-amb-prov', reqVariant)).toBe('unknown');
    expect(computeCostUsd('unit-amb-prov', reqVariant, 1_000_000, 1_000_000)).toBeNull();
    deletePricing('unit-amb-prov/z.0-neutron');
    deletePricing('unit-amb-prov/z-0-neutron');
  });

  it('L: OpenCode Inference usage (pricing unavailable) cannot freeze or poison other providers', () => {
    const before = getUsageAggregates();
    for (const m of ['big-pickle', 'mimo-v2.5-free', 'nemotron-3-super-free']) {
      recordUsage(mk({ provider: 'opencode-inference', model: m, promptTokens: 1_200_000_000, completionTokens: 4_000_000, totalTokens: 1_204_000_000 }));
    }
    expect(getPricingStatus('opencode-inference', 'big-pickle')).toBe('unknown');
    const after = getUsageAggregates();
    /* tokens grew massively, cost stayed EXACTLY the same (never $0-added) … */
    expect(after.totalPromptTokens).toBeGreaterThan(before.totalPromptTokens);
    expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd!, 12);
    /* … and priced providers keep contributing afterwards */
    recordUsage(mk({ provider: SYN_PROV_A, model: SYN_MODEL, promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }));
    expect(getUsageAggregates().totalCostUsd! - after.totalCostUsd!).toBeCloseTo(SYN_IN, 12);
  });

  it('M: kie.ai pipeline — null cost while unknown; valid as soon as its actual price is registered', () => {
    const model = SYN_KIE_MODEL; /* synthetic id routed under the real kie.ai provider id */
    recordUsage(mk({ provider: 'kie.ai', model, promptTokens: 4_000_000, completionTokens: 2_000_000, totalTokens: 6_000_000 }));
    expect(getAllUsage().find(r => r.model === model)!.costUsd).toBeNull();

    /* The user-facing remedy is the admin pricing store: register the pair's
       OFFICIAL price and ALL records (new + historical backfill) price on it.
       0.5/2.0 here is TEST DATA in a throwaway dir, not a real list price. */
    /* The admin Overview aggregate reacts IMMEDIATELY, per event, even though
       nothing has been flushed to disk:
         upsert prices the already-buffered record → aggregate += 18
         a second priced record                  → aggregate += 18 again */
    const agg0 = getUsageAggregates().totalCostUsd!;

    upsertPricing('kie.ai', model, 0.5, 2.0);
    const agg1 = getUsageAggregates().totalCostUsd!;
    expect(agg1 - agg0).toBeCloseTo(4 * 0.5 + 2 * 2.0, 12);

    recordUsage(mk({ provider: 'kie.ai', model, promptTokens: 4_000_000, completionTokens: 2_000_000, totalTokens: 6_000_000 }));
    const agg2 = getUsageAggregates().totalCostUsd!;
    expect(agg2 - agg1).toBeCloseTo(4 * 0.5 + 2 * 2.0, 12);

    /* Historical backfill: the unpriced record from before is priced at read
       time with the SAME stored tokens (usage never touched). */
    flushUsage();
    const loaded = loadUsageRecords().filter(r => r.model === model);
    for (const r of loaded) {
      expect(r.costUsd).not.toBeNull();
      expect(r.costUsd).toBeCloseTo((r.promptTokens ?? 0) * 0.5 / 1e6 + (r.completionTokens ?? 0) * 2.0 / 1e6, 12);
      expect(r.promptTokens! + r.completionTokens!).toBe(r.totalTokens);
    }
    /* disabled pricing → back to unknown-null (not $0) */
    setPricingEnabled(`kie.ai/${model}`, false);
    expect(getPricingStatus('kie.ai', model)).toBe('unknown');
    expect(computeCostUsd('kie.ai', model, 9_999, 9_999)).toBeNull();
    setPricingEnabled(`kie.ai/${model}`, true);
    expect(computeCostUsd('kie.ai', model, 1_000_000, 0)).toBeCloseTo(0.5, 12);
  });
});

describe('cost pipeline — persistence mirrors aggregation', () => {
  it('flushed + reloaded aggregates equal in-memory aggregates', () => {
    flushUsage();
    const disk = loadUsageRecords();
    expect(disk.length).toBeGreaterThan(0);
    const inMem = getUsageAggregates();
    const onDiskOnly = disk.reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
    const fromMemOnly = getAllUsage()
      .filter(r => !disk.some(d => d.requestId === r.requestId))
      .reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
    expect(inMem.totalCostUsd).toBeCloseTo(onDiskOnly + fromMemOnly, 9);
    /* per-model breakdown exposes the exact pair identity + pricing status */
    const byModel = getUsageByModel();
    const g = byModel['nvidia/z-ai/glm-5.2'];
    expect(g.pricingStatus).toBe('known');
    expect(g.costUsd).not.toBeNull();
    const inf = byModel['opencode-inference/big-pickle'];
    expect(inf.pricingStatus).toBe('unknown');
    expect(inf.costUsd).toBeNull();
  });
});
