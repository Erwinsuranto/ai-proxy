import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, configFile } from './setup';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = configFile('provider-state.json');

beforeAll(async () => {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
});

describe('Admin Provider Management', () => {
  describe('GET /admin/providers', () => {
    it('should list registered providers with id, name, enabled and models', async () => {
      const res = await request('GET', '/admin/providers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBeGreaterThanOrEqual(1);

      const nvidia = res.data.find((p: any) => p.id === 'nvidia');
      expect(nvidia).toBeDefined();
      expect(typeof nvidia.name).toBe('string');
      expect(typeof nvidia.enabled).toBe('boolean');
      expect(Array.isArray(nvidia.models)).toBe(true);
    });
  });

  describe('PATCH /admin/providers/:providerId', () => {
    it('should disable a provider', async () => {
      const res = await request('PATCH', '/admin/providers/nvidia', { enabled: false });
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
      expect(res.data.enabled).toBe(false);

      const list = await request('GET', '/admin/providers');
      const nvidia = list.data.find((p: any) => p.id === 'nvidia');
      expect(nvidia.enabled).toBe(false);
    });

    it('should block new requests to a disabled provider via /v1/models', async () => {
      const list = await request('GET', '/admin/providers');
      const nvidia = list.data.find((p: any) => p.id === 'nvidia');
      if (nvidia.enabled === false) {
        const models = await request('GET', '/v1/models');
        expect(models.status).toBe(200);
        const owned = models.data.data.filter((m: any) => m.owned_by === 'nvidia');
        expect(owned.length).toBe(0);
      }
    });

    it('should re-enable a provider without reconfiguration', async () => {
      const res = await request('PATCH', '/admin/providers/nvidia', { enabled: true });
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
      expect(res.data.enabled).toBe(true);

      const list = await request('GET', '/admin/providers');
      const nvidia = list.data.find((p: any) => p.id === 'nvidia');
      expect(nvidia.enabled).toBe(true);
    });

    it('should persist disabled state to provider-state.json', async () => {
      await request('PATCH', '/admin/providers/nvidia', { enabled: false });
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.disabledProviders).toContain('nvidia');
    });

    it('should return 404 for an unknown provider', async () => {
      const res = await request('PATCH', '/admin/providers/does-not-exist', { enabled: true });
      expect(res.status).toBe(404);
      expect(res.data.error).toBeDefined();
    });

    it('should return 400 when enabled field is missing', async () => {
      const res = await request('PATCH', '/admin/providers/nvidia', {});
      expect(res.status).toBe(400);
      expect(res.data.error).toBeDefined();
    });
  });
});
