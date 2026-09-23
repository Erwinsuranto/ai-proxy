import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';

const USAGE_FILE = configFile('usage-records.json');

beforeAll(async () => {
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
});

describe('Usage Tracking', () => {
  describe('GET /admin/usage', () => {
    it('should return aggregate usage stats', async () => {
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
      expect(typeof res.data.totalRequests).toBe('number');
    });
  });

  describe('GET /admin/usage/providers', () => {
    it('should return usage per provider', async () => {
      const res = await request('GET', '/admin/usage/providers');
      expect(res.status).toBe(200);
      expect(typeof res.data).toBe('object');
    });
  });

  describe('GET /admin/usage/models', () => {
    it('should return usage per model', async () => {
      const res = await request('GET', '/admin/usage/models');
      expect(res.status).toBe(200);
      expect(typeof res.data).toBe('object');
    });
  });

  describe('GET /admin/usage/records', () => {
    it('should return usage records (may be empty)', async () => {
      const res = await request('GET', '/admin/usage/records');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('total');
      expect(Array.isArray(res.data.records)).toBe(true);
      if (res.data.records.length > 0) {
        expect(res.data.records[0]).toHaveProperty('provider');
        expect(res.data.records[0]).toHaveProperty('model');
        expect(res.data.records[0]).toHaveProperty('status');
        expect(res.data.records[0]).toHaveProperty('timestamp');
      }
    });
  });

  describe('Request tracking', () => {
    it('should record a blocked request when model has no provider', async () => {
      const before = await request('GET', '/admin/usage');
      const beforeTotal = before.data.totalRequests;

      const res = await request('POST', '/v1/chat/completions', {
        model: 'totally-unknown-model-xyz',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(400);

      const after = await request('GET', '/admin/usage');
      expect(after.data.totalRequests).toBeGreaterThanOrEqual(beforeTotal + 1);
      expect(after.data.totalBlocked).toBeGreaterThanOrEqual(before.data.totalBlocked + 1);
    });

    it('should not record a failed validation request as success', async () => {
      const before = await request('GET', '/admin/usage');
      const beforeSuccess = before.data.totalSuccess;

      // Validation failure (missing model) - should NOT be recorded as success
      await request('POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'hi' }],
      });

      const after = await request('GET', '/admin/usage');
      expect(after.data.totalSuccess).toBe(beforeSuccess);
    });

    it('should keep recording usage even after many requests', async () => {
      // Multiple blocked requests should all be counted
      for (let i = 0; i < 3; i++) {
        await request('POST', '/v1/chat/completions', {
          model: `unknown-model-${i}`,
          messages: [{ role: 'user', content: 'hi' }],
        });
      }
      const after = await request('GET', '/admin/usage');
      expect(after.data.totalRequests).toBeGreaterThanOrEqual(after.data.totalBlocked + after.data.totalFailed);
      expect(after.data.totalRequests).toBeGreaterThanOrEqual(4);
    });
  });
});