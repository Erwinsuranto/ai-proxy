/**
 * Model Pricing Management + Cost Calculation — regression tests.
 *
 * Deterministic reference math (from spec):
 *   input = 1,000,000 tokens @ $1/1M  -> inputCost  = $1
 *   output =   500,000 tokens @ $2/1M -> outputCost = $1
 *   totalCost = $2
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import { computeCostUsd, getPricingStatus } from '../src/lib/pricing';
import { reloadPricingCache } from '../src/lib/pricing-store';

const PRICING_FILE = configFile('model-pricing.json');
const USAGE_FILE = configFile('usage-records.json');

const MODEL = 'audit/priced-model'; // registered into the Model Registry below

beforeAll(async () => {
  for (const f of [PRICING_FILE, USAGE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  for (const f of [PRICING_FILE, USAGE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('GET /admin/pricing (built-in registry exposed)', () => {
  it('lists built-in entries without any stored ones', async () => {
    const res = await request('GET', '/admin/pricing');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.entries)).toBe(true);
    expect(res.data.entries).toHaveLength(0);
    const glm = res.data.builtin.find((e: any) => e.id === 'nvidia/z-ai/glm-5.2');
    expect(glm).toBeDefined();
    expect(glm.source).toBe('builtin');
    expect(glm.inputPerM).toBe(0.1);
    expect(glm.outputPerM).toBe(0.4);
  });
});

describe('POST /admin/pricing validation', () => {
  it('rejects unknown provider (#7)', async () => {
    const res = await request('POST', '/admin/pricing', {
      providerId: 'no-such-provider', model: 'x', inputPerM: 1, outputPerM: 2,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a model that is NOT in the model registry (never fabricates models) (#6/#7)', async () => {
    const res = await request('POST', '/admin/pricing', {
      providerId: 'nvidia', model: 'totally-made-up-model', inputPerM: 1, outputPerM: 2,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/model registry/i);
  });

  it('rejects negative prices', async () => {
    await request('POST', '/admin/models', { model: MODEL, providerId: 'nvidia', priority: 50 });
    const res = await request('POST', '/admin/pricing', {
      providerId: 'nvidia', model: MODEL, inputPerM: -1, outputPerM: 2,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/non-negative/);
  });

  it('rejects non-numeric prices', async () => {
    const res = await request('POST', '/admin/pricing', {
      providerId: 'nvidia', model: MODEL, inputPerM: 'abc', outputPerM: 2,
    });
    expect(res.status).toBe(400);
  });

  it('creates a valid entry (201) with USD metadata', async () => {
    const res = await request('POST', '/admin/pricing', {
      providerId: 'nvidia', model: MODEL, inputPerM: 1, outputPerM: 2,
    });
    expect(res.status).toBe(201);
    expect(res.data.created).toBe(true);
    expect(res.data.entry.currency).toBe('USD');
    expect(res.data.entry.enabled).toBe(true);
    expect(res.data.entry.id).toBe(`nvidia/${MODEL}`);
  });

  it('handles duplicates as an explicit UPDATE (200, created=false)', async () => {
    const res = await request('POST', '/admin/pricing', {
      providerId: 'nvidia', model: MODEL, inputPerM: 1, outputPerM: 3,
    });
    expect(res.status).toBe(200);
    expect(res.data.created).toBe(false);
    expect(res.data.entry.outputPerM).toBe(3);

    const list = await request('GET', '/admin/pricing');
    const mine = list.data.entries.filter((e: any) => e.model === MODEL);
    expect(mine).toHaveLength(1); // no duplicate rows
    // restore spec values
    await request('POST', '/admin/pricing', { providerId: 'nvidia', model: MODEL, inputPerM: 1, outputPerM: 2 });
  });
});

describe('Deterministic cost calculation through real storage/backfill (#15)', () => {
  it('legacy null-cost records backfill to exactly $2 (1M×$1 + 0.5M×$2)', async () => {
    const legacy = {
      timestamp: Date.now(), provider: 'nvidia', model: MODEL,
      status: 'success', latencyMs: 42,
      promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000,
      apiKey: null, httpStatus: 200, errorMessage: null,
      requestId: 'pricing-spec-record', apiKeyMasked: null,
      costUsd: null, // recorded before pricing existed
    };
    fs.writeFileSync(USAGE_FILE, JSON.stringify([legacy]), 'utf-8');

    const logs = (await request('GET', '/admin/logs')).data;
    const rec = (logs.logs || []).find((r: any) => r.requestId === 'pricing-spec-record');
    expect(rec).toBeDefined();
    expect(rec.costUsd).toBeCloseTo(2, 9);          // totalCost = $2
    expect(rec.inputCostUsd).toBeCloseTo(1, 9);     // 1M × $1/1M
    expect(rec.outputCostUsd).toBeCloseTo(1, 9);    // 0.5M × $2/1M

    // identity untouched by backfill
    expect(rec.promptTokens).toBe(1_000_000);
    expect(rec.completionTokens).toBe(500_000);
  }, 20000);

  it('aggregates the backfilled cost into summary/provider/model views', async () => {
    const agg = (await request('GET', '/admin/usage')).data;
    expect(agg.totalCostUsd).toBeCloseTo(2, 9);
    expect(agg.totalInputCostUsd).toBeCloseTo(1, 9);
    expect(agg.totalOutputCostUsd).toBeCloseTo(1, 9);
    expect(agg.totalTokens).toBe(1_500_000);

    const byProv = (await request('GET', '/admin/usage/providers')).data;
    expect(byProv.nvidia.costUsd).toBeCloseTo(2, 9);

    const byModel = (await request('GET', `/admin/usage/models`)).data;
    const row = byModel[`nvidia/${MODEL}`];
    expect(row.pricingStatus).toBe('known');
    expect(row.costUsd).toBeCloseTo(2, 9);
  }, 20000);
});

describe('Enable/disable semantics (#8/#12)', () => {
  it('disabling pricing makes the pair UNKNOWN again (cost null, never $0)', async () => {
    const id = `nvidia/${MODEL}`;
    const res = await request('PATCH', `/admin/pricing/${encodeURIComponent(id)}`, { enabled: false });
    expect(res.status).toBe(200);
    expect(res.data.entry.enabled).toBe(false);

    const logs = (await request('GET', '/admin/logs')).data;
    const rec = (logs.logs || []).find((r: any) => r.requestId === 'pricing-spec-record');
    expect(rec.costUsd ?? null).toBeNull();
    expect(rec.inputCostUsd ?? null).toBeNull();

    const status = getPricingStatus('nvidia', MODEL);
    expect(status).toBe('unknown');
  }, 20000);

  it('re-enabling restores the computed cost (idempotent across loads)', async () => {
    const id = `nvidia/${MODEL}`;
    await request('PATCH', `/admin/pricing/${encodeURIComponent(id)}`, { enabled: true });

    const first = (await request('GET', '/admin/logs')).data.logs.find((r: any) => r.requestId === 'pricing-spec-record');
    const second = (await request('GET', '/admin/logs')).data.logs.find((r: any) => r.requestId === 'pricing-spec-record');
    for (const rec of [first, second]) {
      expect(rec.costUsd).toBeCloseTo(2, 9);
      expect(rec.inputCostUsd).toBeCloseTo(1, 9);
    }
    expect(second.costUsd).toBe(first.costUsd);
  }, 20000);
});

describe('Built-in override precedence (#2)', () => {
  it('stored entry OVERRIDES the built-in price; deleting restores built-in', async () => {
    // Register the model so the pricing POST passes registry validation.
    await request('POST', '/admin/models', { model: 'z-ai/glm-5.2', providerId: 'nvidia', priority: 60 });

    // Seed a legacy null-cost record for the BUILT-IN priced pair.
    const legacy = {
      timestamp: Date.now(), provider: 'nvidia', model: 'z-ai/glm-5.2',
      status: 'success', latencyMs: 10,
      promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000,
      apiKey: null, httpStatus: 200, errorMessage: null,
      requestId: 'override-check', apiKeyMasked: null,
      costUsd: null,
    };
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    raw.push(legacy);
    fs.writeFileSync(USAGE_FILE, JSON.stringify(raw), 'utf-8');

    // Built-in first: $0.10/1M in.
    let rec = (await request('GET', '/admin/logs')).data.logs.find((r: any) => r.requestId === 'override-check');
    expect(rec.costUsd).toBeCloseTo(0.1, 9);

    // Override with $5/1M in.
    await request('POST', '/admin/pricing', { providerId: 'nvidia', model: 'z-ai/glm-5.2', inputPerM: 5, outputPerM: 5 });
    rec = (await request('GET', '/admin/logs')).data.logs.find((r: any) => r.requestId === 'override-check');
    expect(rec.costUsd).toBeCloseTo(5, 9);

    // Delete the OVERRIDE only — configuration removed, usage history untouched...
    const del = await request('DELETE', `/admin/pricing/${encodeURIComponent('nvidia/z-ai/glm-5.2')}`);
    expect(del.status).toBe(200);
    const list = (await request('GET', '/admin/pricing')).data;
    expect(list.entries.find((e: any) => e.id === 'nvidia/z-ai/glm-5.2')).toBeUndefined();
    expect(list.builtin.find((e: any) => e.id === 'nvidia/z-ai/glm-5.2')).toBeDefined();

    // ...and the record falls back to the built-in price.
    rec = (await request('GET', '/admin/logs')).data.logs.find((r: any) => r.requestId === 'override-check');
    expect(rec.costUsd).toBeCloseTo(0.1, 9);
    expect(rec.promptTokens).toBe(1_000_000); // never touched
  }, 20000);

  it('disabling a built-in-priced pair forces UNKNOWN even though builtin exists', async () => {
    await request('POST', '/admin/models', { model: 'z-ai/glm-5.2', providerId: 'nvidia', priority: 61 });
    await request('POST', '/admin/pricing', { providerId: 'nvidia', model: 'z-ai/glm-5.2', inputPerM: 5, outputPerM: 5 });
    await request('PATCH', `/admin/pricing/${encodeURIComponent('nvidia/z-ai/glm-5.2')}`, { enabled: false });
    reloadPricingCache(); // this process caches too; server mutated the file via HTTP
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', 1000, 100)).toBeNull();
    expect(getPricingStatus('nvidia', 'z-ai/glm-5.2')).toBe('unknown');
    // cleanup
    await request('DELETE', `/admin/pricing/${encodeURIComponent('nvidia/z-ai/glm-5.2')}`);
  });
});

describe('Security & safety (#14/#8)', () => {
  it('pricing endpoints expose NO credential material', async () => {
    const res = await request('GET', '/admin/pricing');
    const body = JSON.stringify(res.data);
    expect(body.toLowerCase()).not.toContain('apikey');
    expect(body.toLowerCase()).not.toContain('authorization');
    expect(body.toLowerCase()).not.toContain('bearer');
  });

  it('DELETE removes only pricing CONFIG — usage record survives on disk', async () => {
    const before = fs.existsSync(USAGE_FILE)
      ? JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')).length
      : 0;
    expect(before).toBeGreaterThanOrEqual(2);
    // delete the audit/priced-model config
    const del = await request('DELETE', `/admin/pricing/${encodeURIComponent(`nvidia/${MODEL}`)}`);
    expect(del.status).toBe(200);
    const after = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')).length;
    expect(after).toBe(before); // usage history untouched
    // and its cost becomes unknown again
    const logs = (await request('GET', '/admin/logs')).data;
    const rec = logs.logs.find((r: any) => r.requestId === 'pricing-spec-record');
    expect(rec.costUsd ?? null).toBeNull();
  });
});
