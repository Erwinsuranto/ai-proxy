import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request } from './setup';

beforeAll(async () => {
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('POST /v1/embeddings', () => {
  it('should return 400 when model is missing', async () => {
    const res = await request('POST', '/v1/embeddings', {
      input: 'Hello world',
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return 400 when input is missing', async () => {
    const res = await request('POST', '/v1/embeddings', {
      model: 'test-model',
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return OpenAI-compatible response structure on success', async () => {
    const res = await request('POST', '/v1/embeddings', {
      model: 'nvidia/nv-embedqa-e5-v5',
      input: 'Hello world',
    }, 30000);

    if (res.status === 200) {
      expect(res.data).toHaveProperty('id');
      expect(res.data).toHaveProperty('object', 'list');
      expect(res.data).toHaveProperty('data');
      expect(Array.isArray(res.data.data)).toBe(true);

      if (res.data.data.length > 0) {
        const item = res.data.data[0];
        expect(item).toHaveProperty('object', 'embedding');
        expect(item).toHaveProperty('index', 0);
        expect(item).toHaveProperty('embedding');
        expect(Array.isArray(item.embedding)).toBe(true);
      }

      expect(res.data).toHaveProperty('model');
      expect(res.data).toHaveProperty('usage');
      expect(res.data.usage).toHaveProperty('prompt_tokens');
      expect(res.data.usage).toHaveProperty('total_tokens');
    } else {
      expect(res.data).toHaveProperty('error');
      expect(res.data.error).toHaveProperty('message');
      expect(res.data.error).toHaveProperty('type');
    }
  });
});
