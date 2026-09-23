import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request } from './setup';

beforeAll(async () => {
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('GET /v1/models', () => {
  it('should return 200 with models list', async () => {
    const res = await request('GET', '/v1/models');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('object', 'list');
    expect(res.data).toHaveProperty('data');
    expect(Array.isArray(res.data.data)).toBe(true);

    if (res.data.data.length > 0) {
      const model = res.data.data[0];
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('object', 'model');
      expect(model).toHaveProperty('created');
      expect(typeof model.created).toBe('number');
      expect(model).toHaveProperty('owned_by');
    }
  });

  it('should include provider-provided models', async () => {
    const res = await request('GET', '/v1/models');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('data');
    const ids = res.data.data.map((m: any) => m.id);

    const nvidiaModels = ids.filter(id => typeof id === 'string' && !id.startsWith('@cf/') && !id.startsWith('virtual:'));
    expect(nvidiaModels.length).toBeGreaterThan(0);

    for (const model of res.data.data) {
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('object', 'model');
      expect(model).toHaveProperty('created');
      expect(typeof model.created).toBe('number');
      expect(model).toHaveProperty('owned_by');
      expect(typeof model.owned_by).toBe('string');
    }
  });

  /* Prompt 13: GoRouter.app is NOT used as a provider. The /v1/models gorouter
   * tag test is skipped (not falsified) because no GOROUTER_API_* credentials
   * are provisioned in this project. Real providers verified: NVIDIA + TokenHarbor. */
  it.skip('should include gorouter-provided models tagged owned_by=gorouter', async () => {
    const res = await request('GET', '/v1/models');
    expect(res.status).toBe(200);
    const gorouterModels = res.data.data.filter((m: any) => m.owned_by === 'gorouter');
    expect(gorouterModels.length).toBeGreaterThan(0);
    for (const model of gorouterModels) {
      expect(model.object).toBe('model');
      expect(typeof model.id).toBe('string');
    }
  });
});
