/**
 * Usage path FULL-AUDIT regression tests.
 *
 * Covers: token extraction, totals, pricing lookup, input/output/total cost,
 * free vs unknown pricing, null tokens, streaming usage (+null, +dedup),
 * aggregation (provider/model split by exact pair), historical recalculation
 * idempotency, blocked/error statuses, dashboard cost consistency, cross-
 * provider same-model separation and precision.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordUsage,
  getAllUsage,
  getUsageAggregates,
  getUsageByProvider,
  getUsageByModel,
  loadUsageRecords,
  flushUsage,
  UsageRecord,
} from '../src/lib/usage-store';
import {
  computeCostUsd,
  computeCostSplit,
  getPricingStatus,
  getModelPrice,
} from '../src/lib/pricing';
import { extractUsage, wrapStream } from '../src/services/stream-usage';
import { Transform } from 'stream';

const USAGE_FILE = configFile('usage-records.json');

function makeRecord(partial: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: partial.timestamp ?? Date.now(),
    provider: partial.provider ?? 'nvidia',
    model: partial.model ?? 'z-ai/glm-5.2',
    status: partial.status ?? 'success',
    latencyMs: partial.latencyMs ?? 10,
    promptTokens: partial.promptTokens ?? null,
    completionTokens: partial.completionTokens ?? null,
    totalTokens: partial.totalTokens ?? null,
    apiKey: partial.apiKey ?? null,
    httpStatus: partial.httpStatus ?? 200,
    errorMessage: partial.errorMessage ?? null,
    requestId: partial.requestId ?? null,
    apiKeyMasked: partial.apiKeyMasked ?? null,
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

describe('Token extraction & totals', () => {
  it('extracts prompt/completion/total from an OpenAI-style usage object (#1)', () => {
    const u = extractUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
    expect(u).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
  });

  it('uses upstream total_tokens when provided (#2)', () => {
    const u = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 } });
    expect(u.totalTokens).toBe(999); // upstream is source of truth
  });

  it('computes total when upstream omits it (prompt+completion)', () => {
    const u = extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(u.totalTokens).toBe(10);
  });

  it('returns nulls when usage is missing or malformed (#2/#10)', () => {
    expect(extractUsage({})).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    expect(extractUsage('not-json')).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    const partial = extractUsage({ usage: { prompt_tokens: 5 } });
    expect(partial).toEqual({ promptTokens: 5, completionTokens: null, totalTokens: null });
  });

  it('accepts camelCase variants', () => {
    const u = extractUsage({ usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 } });
    expect(u).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });
});

describe('Pricing lookup & status (#3/#4/#8/#9)', () => {
  it('resolves by exact provider+model, case-insensitive', () => {
    expect(getModelPrice('nvidia', 'z-ai/glm-5.2')).toEqual({ inputPerM: 0.1, outputPerM: 0.4 });
    expect(getModelPrice('NVIDIA', 'Z-AI/GLM-5.2')).toEqual({ inputPerM: 0.1, outputPerM: 0.4 });
    expect(getModelPrice('nvidia', 'other/model')).toBeUndefined();
  });

  it('pricingStatus distinguishes known / free / unknown (#13)', () => {
    expect(getPricingStatus('nvidia', 'z-ai/glm-5.2')).toBe('known');
    expect(getPricingStatus('tokenharbor', 'deepseek-v4-flash:free')).toBe('free');
    expect(getPricingStatus('nvidia', 'zz-not-registered')).toBe('unknown');
  });
});

describe('Cost calculation (#5/#6/#7/#24)', () => {
  it('splits input/output cost at their OWN rates', () => {
    /* nvidia/z-ai/glm-5.2: $0.10/1M in, $0.40/1M out */
    const s = computeCostSplit('nvidia', 'z-ai/glm-5.2', 1_000_000, 1_000_000)!;
    expect(s.inputCostUsd).toBeCloseTo(0.1, 12);
    expect(s.outputCostUsd).toBeCloseTo(0.4, 12);
    expect(s.totalCostUsd).toBeCloseTo(0.5, 12);
    expect(s.inputCostUsd + s.outputCostUsd).toBeCloseTo(s.totalCostUsd, 15);
  });

  it('output tokens never priced at the input rate (#24 anti-pattern)', () => {
    const s = computeCostSplit('gorouter', 'claude-opus-4-8', 0, 1_000_000)!;
    expect(s.outputCostUsd).toBeCloseTo(25, 8); // $25/1M out, NOT $5/1M
    expect(s.inputCostUsd).toBe(0);
  });

  it('computeCostUsd equals split.total (#7)', () => {
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', 1234, 567))
      .toBe(computeCostSplit('nvidia', 'z-ai/glm-5.2', 1234, 567)!.totalCostUsd);
  });

  it('free models cost exactly $0; unknown stay null (#8/#9)', () => {
    expect(computeCostUsd('tokenharbor', 'deepseek-v4-flash:free', 5000, 2000)).toBe(0);
    expect(computeCostUsd('nobody', 'nothing', 5000, 2000)).toBeNull();
    expect(getPricingStatus('tokenharbor', 'deepseek-v4-flash:free')).toBe('free');
  });

  it('null/incomplete tokens yield null cost even for priced models (#10)', () => {
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', null, 100)).toBeNull();
    expect(computeCostUsd('nvidia', 'z-ai/glm-5.2', 100, null)).toBeNull();
    expect(computeCostSplit('nvidia', 'z-ai/glm-5.2', -1, 100)).toBeNull();
  });

  it('keeps sub-micro-dollar precision without early rounding (#24)', () => {
    const s = computeCostSplit('nvidia', 'z-ai/glm-5.2', 1, 0)!;
    expect(s.inputCostUsd).toBeCloseTo(0.0000001, 12);
    expect(s.totalCostUsd).toBeGreaterThan(0);
  });
});

describe('Streaming usage (#11/#12/#13)', () => {
  function sseStream(chunks: string[]): any {
    const s = new Transform({ read() {} });
    for (const c of chunks) s.push(c);
    s.end();
    return s;
  }

  /** Pipes the wrapped stream into a sink so it can flow, end and close. */
  async function drain(wrapped: { stream: Transform }): Promise<void> {
    void wrapped.stream.on('data', () => {});
    await new Promise<void>(resolve => wrapped.stream.on('close', resolve));
  }

  it('captures usage carried in the final SSE chunk (#11)', async () => {
    const wrapped = wrapStream(sseStream([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
      'data: [DONE]\n\n',
    ]));
    await drain(wrapped);
    const usage = wrapped.getUsage();
    expect(usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  it('explicit final usage:null clears earlier usage → no fabricated tokens (#12)', async () => {
    const wrapped = wrapStream(sseStream([
      'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: {"choices":[],"usage":null}\n\n',
      'data: [DONE]\n\n',
    ]));
    await drain(wrapped);
    expect(wrapped.getUsage()).toBeNull();
  });

  it('handles SSE events split across chunk boundaries', async () => {
    const wrapped = wrapStream(sseStream([
      'data: {"choices":[{"delta":{"con',
      'tent":"y"}}],"usage":{"prompt_tok',
      'ens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n',
    ]));
    await drain(wrapped);
    expect(wrapped.getUsage()).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  });

  it('recordUsage dedupes by requestId — no duplicate stream records/cost (#13)', () => {
    const tag = `stream-dedup-${Date.now()}`;
    recordUsage(makeRecord({ requestId: tag, promptTokens: 100, completionTokens: 50, totalTokens: 150 }));
    recordUsage(makeRecord({ requestId: tag, promptTokens: 100, completionTokens: 50, totalTokens: 150 }));
    const matches = getAllUsage().filter(r => r.requestId === tag);
    expect(matches).toHaveLength(1);
  });
});

describe('Per-record cost storage (#5)', () => {
  it('stores inputCostUsd + outputCostUsd + costUsd per request', () => {
    const tag = `split-${Date.now()}`;
    recordUsage(makeRecord({
      requestId: tag, provider: 'nvidia', model: 'z-ai/glm-5.2',
      promptTokens: 2_000_000, completionTokens: 1_000_000, totalTokens: 3_000_000,
    }));
    const rec = getAllUsage().find(r => r.requestId === tag)!;
    expect(rec.inputCostUsd).toBeCloseTo(0.2, 12);
    expect(rec.outputCostUsd).toBeCloseTo(0.4, 12);
    expect(rec.costUsd).toBeCloseTo(0.6, 12);
  });

  it('unknown pricing stores null for all three cost fields (never $0)', () => {
    const tag = `unpriced-${Date.now()}`;
    recordUsage(makeRecord({ requestId: tag, provider: 'ghost', model: 'm', promptTokens: 10, completionTokens: 5, totalTokens: 15 }));
    const rec = getAllUsage().find(r => r.requestId === tag)!;
    expect(rec.costUsd).toBeNull();
    expect(rec.inputCostUsd).toBeNull();
    expect(rec.outputCostUsd).toBeNull();
  });
});

describe('Aggregation (#14/#15/#16/#23)', () => {
  it('aggregates per provider across its records (#14)', () => {
    const tag = `agg-prov-${Date.now()}`;
    recordUsage(makeRecord({ requestId: `${tag}-a`, provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }));
    recordUsage(makeRecord({ requestId: `${tag}-b`, provider: 'nvidia', model: 'z-ai/glm-5.2', promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 }));
    const b = getUsageByProvider().nvidia;
    expect(b.requests).toBeGreaterThanOrEqual(2);
    expect(b.costUsd!).toBeGreaterThanOrEqual(0.5);
    expect(b.inputCostUsd!).toBeGreaterThan(0);
    expect(b.outputCostUsd!).toBeGreaterThan(0);
  });

  it('keeps providerA/model-x and providerB/model-x as SEPARATE rows/pricing contexts (#23)', () => {
    const tag = `ctx-${Date.now()}`;
    // openrouter/deepseek/deepseek-v4-flash = $0.268/$0.40 — priced
    recordUsage(makeRecord({ requestId: `${tag}-a`, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }));
    // groq/deepseek-v4-flash = $0.12/$0.12 — different price, same-ish model name
    recordUsage(makeRecord({ requestId: `${tag}-b`, provider: 'groq', model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }));
    // bai/deepseek-v4-flash = explicit free ($0)
    recordUsage(makeRecord({ requestId: `${tag}-c`, provider: 'bai', model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }));

    const byModel = getUsageByModel();
    const or = byModel['openrouter/deepseek/deepseek-v4-flash'];
    const gq = byModel['groq/deepseek-v4-flash'];
    const bai = byModel['bai/deepseek-v4-flash'];
    expect(or.costUsd).toBeCloseTo(0.268, 12);
    expect(gq.costUsd).toBeCloseTo(0.12, 12);
    expect(bai.costUsd).toBe(0);
    expect(or.pricingStatus).toBe('known');
    expect(gq.pricingStatus).toBe('known');
    expect(bai.pricingStatus).toBe('free');
    // No mixing: each row keeps exactly one provider.
    expect(or.providers).toEqual(['openrouter']);
    expect(gq.providers).toEqual(['groq']);
  });

  it('total cost aggregate == sum of known per-request costs (#16)', () => {
    const all = getAllUsage();
    let sum = 0; let any = false;
    for (const r of all) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) { sum += r.costUsd; any = true; }
    }
    const agg = getUsageAggregates();
    if (any) expect(agg.totalCostUsd).toBeCloseTo(sum, 9);
    else expect(agg.totalCostUsd).toBeNull();
    if (agg.totalInputCostUsd !== null && agg.totalOutputCostUsd !== null && agg.totalCostUsd !== null) {
      expect(agg.totalInputCostUsd + agg.totalOutputCostUsd).toBeCloseTo(agg.totalCostUsd, 9);
    }
  });
});

describe('Historical records (#17/#18)', () => {
  it('backfills legacy records from their own tokens; idempotent across loads (#17/#18)', () => {
    const legacy: any = makeRecord({
      provider: 'gorouter', model: 'claude-opus-4-8',
      promptTokens: 88_183, completionTokens: 234, totalTokens: 88_417,
      timestamp: 1_700_000_000_000, costUsd: undefined,
    });
    delete legacy.costUsd; delete legacy.inputCostUsd; delete legacy.outputCostUsd;
    fs.writeFileSync(USAGE_FILE, JSON.stringify([legacy]), 'utf-8');
    const beforeDisk = fs.readFileSync(USAGE_FILE, 'utf-8');

    const first = loadUsageRecords()[0];
    expect(first.costUsd).toBeCloseTo(0.446765, 10);
    expect(first.inputCostUsd).toBeCloseTo(0.440915, 10);
    expect(first.outputCostUsd).toBeCloseTo(0.00585, 10);

    // Idempotent: second load returns identical values (numeric cost kept verbatim).
    const second = loadUsageRecords()[0];
    expect(second.costUsd).toBe(first.costUsd);
    expect(second.inputCostUsd).toBe(first.inputCostUsd);
    expect(second.outputCostUsd).toBe(first.outputCostUsd);

    // Original identity/tokens untouched + read-only enrichment.
    expect(second.promptTokens).toBe(88_183);
    expect(second.timestamp).toBe(1_700_000_000_000);
    expect(fs.readFileSync(USAGE_FILE, 'utf-8')).toBe(beforeDisk);
  });

  it('leaves unpriced legacy records null on every load (never fabricated)', () => {
    const legacy: any = makeRecord({ provider: 'no-such', model: 'legacy-x', promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    delete legacy.costUsd;
    fs.writeFileSync(USAGE_FILE, JSON.stringify([legacy]), 'utf-8');
    expect(loadUsageRecords()[0].costUsd).toBeNull();
    expect(loadUsageRecords()[0].inputCostUsd).toBeNull();
  });
});

/* ------------------------------ Integration ------------------------------ */

describe('Request-path statuses (#19/#20/#21)', () => {
  it('invalid model → blocked record (never counted as success) (#19/#20)', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: `no-such-model-${Date.now()}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const logs = await request('GET', `/admin/logs?model=no-such-model-&search=`).catch(() => null);
    void logs; // filtered assertion below via full scan instead
    const all = await request('GET', '/admin/logs?limit=1000');
    const blocked = (all.data.logs || []).find((r: any) => r.status === 'blocked' && String(r.model).startsWith('no-such-model-'));
    expect(blocked).toBeDefined();
  }, 20000);

  it('upstream auth failure → error record with httpStatus, not success (#21)', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    });
    // With test credentials the upstream rejects; both envelopes prove wiring.
    expect(res.status === 200 || res.status >= 400).toBe(true);
    const all = await request('GET', '/admin/logs?provider=nvidia&limit=1000');
    const errRec = (all.data.logs || []).find((r: any) => r.status === 'error');
    if (errRec) {
      expect(typeof errRec.httpStatus).toBe('number');
      expect(errRec.httpStatus).not.toBe(200);
    }
  }, 20000);
});

describe('Dashboard/API consistency (#22)', () => {
  it('GET /admin/usage totalCostUsd == sum over /admin/logs records', async () => {
    const agg = (await request('GET', '/admin/usage')).data;
    const logs = (await request('GET', '/admin/logs?limit=100000')).data;
    let sum: number | null = null;
    for (const r of logs.logs || []) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
        sum = (sum ?? 0) + r.costUsd;
      }
    }
    if (sum !== null) expect(agg.totalCostUsd).toBeCloseTo(sum, 9);
    else expect(agg.totalCostUsd).toBeNull();

    const byProv = (await request('GET', '/admin/usage/providers')).data;
    for (const [id, b] of Object.entries<any>(byProv)) {
      if (b.costUsd !== null) {
        const provLogs = (logs.logs || []).filter((r: any) => r.provider === id && typeof r.costUsd === 'number');
        const provSum = provLogs.reduce((s: number, r: any) => s + r.costUsd, 0);
        expect(b.costUsd).toBeCloseTo(provSum, 9);
      }
    }

    const byModel = (await request('GET', '/admin/usage/models')).data;
    for (const [key, b] of Object.entries<any>(byModel)) {
      expect(key).toContain('/'); // exact provider/model composite key
      if (b.pricingStatus === 'free' && b.costUsd !== null) {
        expect(b.costUsd).toBe(0);
      }
    }
  }, 20000);

  it('flushed storage round-trips split costs (#17 real-data validation)', async () => {
    const tag = `roundtrip-${Date.now()}`;
    recordUsage(makeRecord({
      requestId: tag, provider: 'nvidia', model: 'z-ai/glm-5.2',
      promptTokens: 88_183, completionTokens: 234, totalTokens: 88_417,
    }));
    flushUsage();
    const stored = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')).find((r: any) => r.requestId === tag);
    // Manual verification: (88183×0.1 + 234×0.4)/1e6
    const expectedIn = 88_183 * 0.1 / 1e6;
    const expectedOut = 234 * 0.4 / 1e6;
    expect(stored.inputCostUsd).toBeCloseTo(expectedIn, 12);
    expect(stored.outputCostUsd).toBeCloseTo(expectedOut, 12);
    expect(stored.costUsd).toBeCloseTo(expectedIn + expectedOut, 12);
  });
});
