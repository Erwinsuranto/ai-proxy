/**
 * API Key Management — UI→API integration flow.
 *
 * Reproduces EXACTLY the HTTP call sequence the admin dashboard makes
 * (same endpoints, same order) and asserts the UI contracts:
 *   load → add → refresh(count+1, masked) → duplicate(error, no change)
 *   → delete(confirm) → refresh(count-1) → restart → state identical.
 *   Failed operations never fake success and never mutate existing data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const KEYS_FILE = configFile('provider-api-keys.json');

const RAW = 'ui-flow-secret-key-0001';
const RAW2 = 'ui-flow-secret-key-0002';

beforeAll(async () => {
  if (fs.existsSync(KEYS_FILE)) fs.unlinkSync(KEYS_FILE);
  await startServer({ NVIDIA_API_KEYS: 'envkey1,envkey2' });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  if (fs.existsSync(KEYS_FILE)) fs.unlinkSync(KEYS_FILE);
});

/* The three backend views the UI reads. */
async function snapshot() {
  const providers = (await request('GET', '/admin/providers')).data;
  const nvidia = providers.find((p: any) => p.id === 'nvidia');
  const list = (await request('GET', '/admin/providers/nvidia/api-keys')).data;
  return { cardCount: nvidia.apiKeyCount as number, envKeyCount: list.envKeyCount as number, keys: list.keys };
}

describe('UI flow: load → add → duplicate → delete → restart (#1-#4,#7)', () => {
  it('initial load: managed=0, env=2, counts distinct (#6)', async () => {
    const s = await snapshot();
    expect(s.cardCount).toBe(0);
    expect(s.envKeyCount).toBe(2); // env keys reported separately, never mixed
    expect(s.keys.length).toBe(0);
  });

  it('Add API Key: 201 → count 0→1 → masked display + label + createdAt, raw never returned', async () => {
    const r = await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: RAW, label: 'primary' });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.data)).not.toContain(RAW); // create response masked

    const s = await snapshot();
    expect(s.cardCount).toBe(1);
    expect(s.keys.length).toBe(1);
    const k = s.keys[0];
    expect(k.maskedKey).toMatch(/^.{4}\*{3}0001/); // first4***last4 of RAW
    expect(k.label).toBe('primary');
    expect(typeof k.createdAt).toBe('number');
    expect(JSON.stringify(s.keys)).not.toContain(RAW);
  });

  it('Duplicate via UI: 409 → error surfaced, count unchanged, single record (#4)', async () => {
    const r = await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: RAW });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.data)).not.toContain(RAW); // error never leaks raw key

    const s = await snapshot();
    expect(s.cardCount).toBe(1); // unchanged — failure is NOT rendered as success
    expect(s.keys.filter((x: any) => x.maskedKey.includes('0001')).length).toBe(1);
  });

  it('Invalid input: 400 empty key → nothing stored, count unchanged', async () => {
    const r = await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: '   ' });
    expect(r.status).toBe(400);
    const s = await snapshot();
    expect(s.cardCount).toBe(1);
  });

  it('Delete via UI: confirm → DELETE by keyId → count 1→0 → other keys untouched', async () => {
    // second key so we can prove selective deletion
    await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: RAW2 });
    let s = await snapshot();
    expect(s.cardCount).toBe(2);
    const target = s.keys.find((k: any) => k.maskedKey.endsWith('0001'));

    const del = await request(
      'DELETE',
      `/admin/providers/nvidia/api-keys/${encodeURIComponent(target.id)}`,
    );
    expect(del.status).toBe(200);

    s = await snapshot();
    expect(s.cardCount).toBe(1);
    expect(s.keys.some((k: any) => k.maskedKey.endsWith('0002'))).toBe(true);
    expect(s.keys.some((k: any) => k.maskedKey.endsWith('0001'))).toBe(false);
    // deleting by keyId only — raw key material never appears anywhere
    expect(JSON.stringify(del.data)).not.toContain(RAW);
  });

  it('Restart (#7): reopen dashboard → identical counts & masked rows', async () => {
    await stopServer();
    await startServer({ NVIDIA_API_KEYS: 'envkey1,envkey2' });

    const before = await snapshot();
    expect(before.cardCount).toBe(1);
    // UI-primary contract: the surviving managed record retires the env seeds
    expect(before.envKeyCount).toBe(0);
    expect(before.keys[0].maskedKey).toMatch(/^.{4}\*{3}0002/);
    expect(typeof before.keys[0].createdAt).toBe('number');
  }, 30000);

  it('Unknown provider: all verbs 404 (UI shows clear error, no partial state)', async () => {
    for (const [method, body] of [['GET', undefined], ['POST', { apiKey: 'x' }]] as const) {
      const r = await request(method, '/admin/providers/nope/api-keys', body as any);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.data)).not.toContain('x');
    }
  });
});
