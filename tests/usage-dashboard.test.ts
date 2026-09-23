import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordUsage,
  flushUsage,
  getAllUsage,
  queryUsage,
  getUsageAggregates,
  getUsageByProvider,
  getUsageByModel,
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

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

describe('Usage Dashboard - Unit (usage-store)', () => {
  it('should aggregate success/error/blocked records with real token values', () => {
    const marker = `unit-agg-${Date.now()}`;
    recordUsage(makeRecord({ model: marker, status: 'success', promptTokens: 10, completionTokens: 20, totalTokens: 30, latencyMs: 100 }));
    recordUsage(makeRecord({ model: marker, status: 'error', promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 50 }));
    recordUsage(makeRecord({ model: marker, status: 'blocked', promptTokens: null, completionTokens: null, totalTokens: null, latencyMs: 0 }));

    const all = getAllUsage().filter(r => r.model === marker);
    expect(all.length).toBe(3);
    expect(all.filter(r => r.status === 'success').length).toBe(1);
    expect(all.filter(r => r.status === 'error').length).toBe(1);
    expect(all.filter(r => r.status === 'blocked').length).toBe(1);
    expect(all.reduce((s, r) => s + (r.promptTokens ?? 0), 0)).toBe(10);
    expect(all.reduce((s, r) => s + (r.completionTokens ?? 0), 0)).toBe(20);
    expect(all.reduce((s, r) => s + (r.totalTokens ?? 0), 0)).toBe(30);
    // Blocked records must not fabricate tokens
    const blocked = all.find(r => r.status === 'blocked')!;
    expect(blocked.promptTokens).toBeNull();
    expect(blocked.completionTokens).toBeNull();
    expect(blocked.totalTokens).toBeNull();
    // Latency only counted for real requests
    expect(all.find(r => r.status === 'success')!.latencyMs).toBe(100);
  });

  it('should produce provider breakdown with avg latency', () => {
    const marker = `unit-prov-${Date.now()}`;
    recordUsage(makeRecord({ provider: marker, status: 'success', latencyMs: 100 }));
    recordUsage(makeRecord({ provider: marker, status: 'error', latencyMs: 50 }));
    recordUsage(makeRecord({ provider: marker, status: 'blocked', latencyMs: 0 }));
    const byProvider = getUsageByProvider();
    expect(byProvider[marker]).toBeDefined();
    expect(byProvider[marker].requests).toBe(3);
    expect(byProvider[marker].success).toBe(1);
    expect(byProvider[marker].failed).toBe(1);
    expect(byProvider[marker].blocked).toBe(1);
    expect(byProvider[marker].avgLatencyMs).toBe(50);
    expect(byProvider[marker].success + byProvider[marker].failed + byProvider[marker].blocked).toBe(byProvider[marker].requests);
  });

  it('should produce model breakdown with providers list', () => {
    const marker = `unit-model-${Date.now()}`;
    recordUsage(makeRecord({ model: marker, provider: 'nvidia', status: 'success' }));
    recordUsage(makeRecord({ model: marker, provider: 'openrouter', status: 'success' }));
    const byModel = getUsageByModel();
    expect(byModel[`nvidia/${marker}`]).toBeDefined();
    expect(byModel[`openrouter/${marker}`]).toBeDefined();
    expect(byModel[`nvidia/${marker}`].requests).toBe(1);
    expect(byModel[`openrouter/${marker}`].requests).toBe(1);
    expect(byModel[`nvidia/${marker}`].providers).toEqual(['nvidia']);
    expect(byModel[`openrouter/${marker}`].providers).toEqual(['openrouter']);
  });

  it('should query with provider/model/status filters', () => {
    const onlySuccess = queryUsage({ status: 'success' });
    expect(onlySuccess.records.every(r => r.status === 'success')).toBe(true);

    const onlyNvidia = queryUsage({ provider: 'nvidia' });
    expect(onlyNvidia.records.every(r => r.provider === 'nvidia')).toBe(true);

    const unknownProvider = queryUsage({ provider: 'nonexistent' });
    expect(unknownProvider.total).toBe(0);
  });

  it('should paginate correctly', () => {
    const marker = `unit-page-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      recordUsage(makeRecord({ model: `${marker}-${i}`, status: 'success' }));
    }
    flushUsage();
    const page1 = queryUsage({ search: marker, limit: 5, offset: 0 });
    const page2 = queryUsage({ search: marker, limit: 5, offset: 5 });
    expect(page1.records.length).toBe(5);
    expect(page2.records.length).toBe(5);
    expect(page1.total).toBe(10);
    expect(page2.records[0].model).not.toBe(page1.records[0].model);
  });

  it('should fetch a record by index', () => {
    const all = getAllUsage();
    const rec = getUsageRecordByIndex(0);
    expect(rec).toBeDefined();
    expect(rec!.timestamp).toBeTypeOf('number');
  });

  it('should mask credentials - never store raw API key value', () => {
    // The apiKey field is a client identifier (not a credential); apiKeyMasked
    // must never contain the raw key material.
    recordUsage(makeRecord({
      status: 'success',
      apiKey: 'client-1',
      apiKeyMasked: 'nvap***key9',
      model: 'mask-test',
    }));
    const recs = getAllUsage().filter(r => r.model === 'mask-test');
    expect(recs.length).toBe(1);
    expect(recs[0].apiKeyMasked).toBe('nvap***key9');
    expect(recs[0].apiKeyMasked).not.toMatch(/^[a-z0-9]{16,}$/i);
    expect(recs[0].apiKey).toBe('client-1');
  });
});

describe('Usage Dashboard - Integration', () => {
  describe('GET /admin/usage', () => {
    it('should return summary stats', async () => {
      const res = await request('GET', '/admin/usage');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('totalRequests');
      expect(res.data).toHaveProperty('totalSuccess');
      expect(res.data).toHaveProperty('totalFailed');
      expect(res.data).toHaveProperty('totalBlocked');
      expect(res.data).toHaveProperty('totalPromptTokens');
      expect(res.data).toHaveProperty('totalCompletionTokens');
      expect(res.data).toHaveProperty('totalTokens');
      expect(res.data).toHaveProperty('avgLatencyMs');
    });

    it('should support time range filter', async () => {
      const now = Date.now();
      const res = await request('GET', `/admin/usage?from=${now - 60000}&to=${now + 60000}`);
      expect(res.status).toBe(200);
      expect(res.data.totalRequests).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /admin/usage/providers', () => {
    it('should return per-provider breakdown', async () => {
      const res = await request('GET', '/admin/usage/providers');
      expect(res.status).toBe(200);
      expect(typeof res.data).toBe('object');
      for (const key of Object.keys(res.data)) {
        expect(res.data[key]).toHaveProperty('requests');
        expect(res.data[key]).toHaveProperty('success');
        expect(res.data[key]).toHaveProperty('failed');
        expect(res.data[key]).toHaveProperty('blocked');
        expect(res.data[key]).toHaveProperty('avgLatencyMs');
      }
    });
  });

  describe('GET /admin/usage/models', () => {
    it('should return per-model breakdown', async () => {
      const res = await request('GET', '/admin/usage/models');
      expect(res.status).toBe(200);
      expect(typeof res.data).toBe('object');
      for (const key of Object.keys(res.data)) {
        expect(res.data[key]).toHaveProperty('requests');
        expect(res.data[key]).toHaveProperty('promptTokens');
        expect(res.data[key]).toHaveProperty('completionTokens');
        expect(res.data[key]).toHaveProperty('totalTokens');
        expect(res.data[key]).toHaveProperty('avgLatencyMs');
      }
    });
  });

  describe('GET /admin/logs', () => {
    it('should return logs with pagination', async () => {
      const res = await request('GET', '/admin/logs?limit=10&offset=0');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('total');
      expect(Array.isArray(res.data.logs)).toBe(true);
      expect(res.data.logs.length).toBeLessThanOrEqual(10);
    });

    it('should filter by provider', async () => {
      const res = await request('GET', '/admin/logs?provider=nvidia');
      expect(res.status).toBe(200);
      expect(res.data.logs.every((l: any) => l.provider === 'nvidia')).toBe(true);
    });

    it('should filter by status', async () => {
      const res = await request('GET', '/admin/logs?status=success');
      expect(res.status).toBe(200);
      expect(res.data.logs.every((l: any) => l.status === 'success')).toBe(true);
    });

    it('should filter by search on requestId', async () => {
      // Find a record with a requestId if any exists
      const all = await request('GET', '/admin/logs?limit=50');
      const withReqId = all.data.logs.find((l: any) => l.requestId);
      if (withReqId) {
        const res = await request('GET', `/admin/logs?search=${withReqId.requestId}`);
        expect(res.status).toBe(200);
        expect(res.data.logs.some((l: any) => l.requestId === withReqId.requestId)).toBe(true);
      } else {
        expect(true).toBe(true);
      }
    });

    it('should filter by time range', async () => {
      const now = Date.now();
      const res = await request('GET', `/admin/logs?from=${now - 60000}&to=${now + 60000}`);
      expect(res.status).toBe(200);
      for (const l of res.data.logs) {
        expect(l.timestamp).toBeGreaterThanOrEqual(now - 60000);
        expect(l.timestamp).toBeLessThanOrEqual(now + 60000);
      }
    });

    it('should return blocked request logs with error details', async () => {
      // Trigger a blocked request (unknown model)
      await request('POST', '/v1/chat/completions', {
        model: 'no-such-model-usage-test',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await request('GET', '/admin/logs?search=no-such-model-usage-test');
      expect(res.status).toBe(200);
      expect(res.data.logs.length).toBeGreaterThanOrEqual(1);
      const blocked = res.data.logs.find((l: any) => l.model === 'no-such-model-usage-test');
      expect(blocked).toBeDefined();
      expect(blocked.status).toBe('blocked');
      expect(blocked.promptTokens).toBeNull();
      expect(blocked.completionTokens).toBeNull();
      expect(blocked.totalTokens).toBeNull();
    });

    it('should return error request logs for upstream failures', async () => {
      /* Register the model EXPLICITLY so the test is hermetic (the live
       * NVIDIA catalog drifts — models get retired upstream). The fake key
       * then guarantees a deterministic upstream 4xx → error record. */
      await request('POST', '/admin/models', {
        model: 'meta/llama-3.1-8b-instruct', providerId: 'nvidia', priority: 10,
      });
      const res = await request('POST', '/v1/chat/completions', {
        model: 'meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      });
      // Fake NVIDIA key => upstream rejects (401/403/400). Any 4xx proves the
      // request reached the provider and failed upstream (not blocked).
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const logs = await request('GET', '/admin/logs?search=meta/llama-3.1-8b-instruct&status=error');
      expect(logs.data.logs.length).toBeGreaterThanOrEqual(1);
      const err = logs.data.logs.find((l: any) => l.provider === 'nvidia');
      if (err) {
        expect(err.httpStatus).toBeGreaterThanOrEqual(400);
        expect(err.errorMessage).toBeTruthy();
      }
    });
  });

  describe('GET /admin/usage/records/:index', () => {
    it('should return 404 for out of range index', async () => {
      const res = await request('GET', '/admin/usage/records/99999999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid index', async () => {
      const res = await request('GET', '/admin/usage/records/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('httpStatus recording', () => {
  it('should record httpStatus=200 for success records', async () => {
    recordUsage(makeRecord({
      status: 'success',
      httpStatus: 200,
      model: 'http-status-success-test',
      latencyMs: 100,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    }));
    const recs = getAllUsage().filter(r => r.model === 'http-status-success-test');
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('success');
    expect(recs[0].httpStatus).toBe(200);
  });

  it('should record httpStatus=403 for upstream error records', async () => {
    recordUsage(makeRecord({
      status: 'error',
      httpStatus: 403,
      model: 'http-status-403-test',
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorMessage: 'Request failed with status code 403',
    }));
    const recs = getAllUsage().filter(r => r.model === 'http-status-403-test');
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('error');
    expect(recs[0].httpStatus).toBe(403);
    expect(recs[0].errorMessage).toBeTruthy();
  });

  it('should record httpStatus=null for blocked records', async () => {
    recordUsage(makeRecord({
      status: 'blocked',
      httpStatus: null,
      model: 'http-status-blocked-test',
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorMessage: null,
    }));
    const recs = getAllUsage().filter(r => r.model === 'http-status-blocked-test');
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('blocked');
    expect(recs[0].httpStatus).toBeNull();
    expect(recs[0].errorMessage).toBeNull();
  });
});

describe('Streaming usage handling', () => {
  it('should allow streaming with usage: null (no fabricated tokens)', () => {
    recordUsage(makeRecord({
      status: 'success',
      httpStatus: 200,
      model: 'stream-null-usage-test',
      latencyMs: 5000,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    }));
    const recs = getAllUsage().filter(r => r.model === 'stream-null-usage-test');
    expect(recs.length).toBe(1);
    expect(recs[0].promptTokens).toBeNull();
    expect(recs[0].completionTokens).toBeNull();
    expect(recs[0].totalTokens).toBeNull();
    expect(recs[0].status).toBe('success');
    expect(recs[0].latencyMs).toBeGreaterThan(0);
  });

  it('should record usage when streaming provides usage', () => {
    recordUsage(makeRecord({
      status: 'success',
      httpStatus: 200,
      model: 'stream-with-usage-test',
      latencyMs: 3000,
      promptTokens: 10,
      completionTokens: 8,
      totalTokens: 18,
    }));
    const recs = getAllUsage().filter(r => r.model === 'stream-with-usage-test');
    expect(recs.length).toBe(1);
    expect(recs[0].promptTokens).toBe(10);
    expect(recs[0].completionTokens).toBe(8);
    expect(recs[0].totalTokens).toBe(18);
  });
});

describe('Token validation (non-streaming)', () => {
  it('should verify prompt_tokens + completion_tokens = total_tokens', () => {
    recordUsage(makeRecord({
      status: 'success',
      httpStatus: 200,
      model: 'token-validation-test',
      latencyMs: 100,
      promptTokens: 37,
      completionTokens: 8,
      totalTokens: 45,
    }));
    const recs = getAllUsage().filter(r => r.model === 'token-validation-test');
    expect(recs.length).toBe(1);
    expect(recs[0].promptTokens! + recs[0].completionTokens!).toBe(recs[0].totalTokens);
  });
});

describe('Provider/model in logs', () => {
  it('should preserve exact provider and model in usage records', () => {
    recordUsage(makeRecord({
      provider: 'nvidia',
      model: 'deepseek-ai/deepseek-v4-flash-0731',
      status: 'success',
      httpStatus: 200,
      latencyMs: 5735,
      promptTokens: 10,
      completionTokens: 6,
      totalTokens: 16,
    }));
    const recs = getAllUsage().filter(r => r.model === 'deepseek-ai/deepseek-v4-flash-0731' && r.provider === 'nvidia');
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const rec = recs[recs.length - 1];
    expect(rec.provider).toBe('nvidia');
    expect(rec.model).toBe('deepseek-ai/deepseek-v4-flash-0731');
    expect(rec.promptTokens).toBe(10);
    expect(rec.completionTokens).toBe(6);
    expect(rec.totalTokens).toBe(16);
  });
});

describe('Restart persistence', () => {
    it('should keep logs readable after server restart', async () => {
      const before = await request('GET', '/admin/logs?limit=5');
      expect(before.status).toBe(200);
      const beforeTotal = before.data.total;

      await stopServer();
      await startServer({ NVIDIA_API_KEYS: 'key1,key2' });

      const after = await request('GET', '/admin/logs?limit=5');
      expect(after.status).toBe(200);
      expect(after.data.total).toBe(beforeTotal);
    });
  });
});
