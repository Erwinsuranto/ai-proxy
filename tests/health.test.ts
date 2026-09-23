import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, getBaseUrl } from './setup';

beforeAll(async () => {
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('GET /health', () => {
  it('should return 200 with status ok and no internal details', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('status', 'ok');
    /* Provider leak guard: /health must not reveal internal provider info. */
    expect(res.data).not.toHaveProperty('provider');
  });
});
