import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request } from './setup';

beforeAll(async () => {
  await startServer({ NVIDIA_API_KEYS: 'key1,key2,key3' });
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('Internal API Endpoints', () => {
  describe('GET /internal/keys', () => {
    it('should return key stats without revealing keys', async () => {
      const res = await request('GET', '/internal/keys');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBeGreaterThanOrEqual(3);

      for (const k of res.data) {
        expect(k).toHaveProperty('id');
        expect(k).toHaveProperty('active');
        expect(k).toHaveProperty('cooldown');
        expect(k).toHaveProperty('requests');
        expect(k).toHaveProperty('success');
        expect(k).toHaveProperty('failed');
        expect(k).toHaveProperty('retry');
        expect(k).toHaveProperty('averageLatency');
        expect(Object.keys(k)).not.toContain('key');
      }
    });

    it('should report correct initial stats', async () => {
      const res = await request('GET', '/internal/keys');
      expect(res.data[0].requests).toBeTypeOf('number');
      expect(res.data[0].success).toBeTypeOf('number');
      expect(res.data[0].failed).toBeTypeOf('number');
    });
  });

  describe('GET /internal/health', () => {
    it('should return health info', async () => {
      const res = await request('GET', '/internal/health');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('provider');
      expect(res.data).toHaveProperty('totalKeys');
      expect(res.data.totalKeys).toBeGreaterThanOrEqual(3);
      expect(res.data).toHaveProperty('activeKeys');
      expect(res.data).toHaveProperty('cooldownKeys');
      expect(res.data).toHaveProperty('requests');
      expect(res.data).toHaveProperty('uptime');
      expect(typeof res.data.uptime).toBe('number');
      expect(Array.isArray(res.data.providers)).toBe(true);
      expect(res.data.providers.length).toBeGreaterThanOrEqual(1);
      expect(res.data.providers[0]).toHaveProperty('provider');
      expect(res.data.providers[0]).toHaveProperty('totalKeys');
    });
  });
});
