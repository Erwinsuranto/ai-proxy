/**
 * Provider recovery cooldown (Provider Management) — ~3 menit (180s), per-provider.
 *
 * Acceptance coverage:
 *   1. Provider gagal → masuk cooldown.
 *   2. Tidak ada restart/retry berulang selama 180 detik (fail-fast + tanpa
 *      upstream call, cooldown tidak diperpanjang/di-restart oleh kegagalan
 *      berikutnya).
 *   3. Setelah cooldown selesai provider dapat dicoba kembali.
 *   4. Cooldown Provider A tidak memengaruhi Provider B (per-provider).
 *   5. Multi-key tetap berjalan: rotasi key/round-robin tidak berubah dan
 *      cooldown provider tidak dipicu selama masih ada key tersedia.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, request, configFile } from './setup';

/* ─────────────────────────── Unit: registry ─────────────────────────────── */
import {
  providerCooldown,
  PROVIDER_COOLDOWN_MS,
  createProviderCooldownError,
} from '../src/lib/provider-cooldown';

const COOLING_IDS = ['cd-unit-a', 'cd-unit-b'];

function cleanupUnit(): void {
  for (const id of COOLING_IDS) providerCooldown.clear(id);
}

describe('Provider Cooldown — registry (per-provider, 180s)', () => {
  beforeEach(cleanupUnit);
  afterEach(cleanupUnit);

  it('default window is 180 seconds (3 minutes)', () => {
    expect(PROVIDER_COOLDOWN_MS).toBe(180_000);
  });

  it('provider failure → enters cooldown with ~180s remaining', () => {
    providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited' });
    expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);
    const remaining = providerCooldown.remainingMs('cd-unit-a');
    expect(remaining).toBeGreaterThan(179_000);
    expect(remaining).toBeLessThanOrEqual(180_000);

    const snap = providerCooldown.snapshot('cd-unit-a');
    expect(snap.cooldownUntil).not.toBeNull();
    expect(snap.lastStatus).toBe(429);
    expect(snap.lastError).toBe('rate limited');
    expect(snap.cooldownCount).toBe(1);
  });

  it('cooldown is PER-PROVIDER: A cooling down does not affect B', () => {
    providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited' });
    expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);
    expect(providerCooldown.isCoolingDown('cd-unit-b')).toBe(false);
    expect(providerCooldown.remainingMs('cd-unit-b')).toBe(0);

    providerCooldown.markFailure('cd-unit-b', { status: 503, message: 'overloaded' });
    expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);
    expect(providerCooldown.isCoolingDown('cd-unit-b')).toBe(true);
  });

  it('no repeated restart: a failure during an active cooldown does NOT extend/restart the window', () => {
    providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'first' });
    const firstUntil = providerCooldown.snapshot('cd-unit-a').cooldownUntil;

    // Simulate several more failures (as hammering requests would) — the
    // window must stay anchored to the first failure, not restart.
    for (let i = 0; i < 5; i++) {
      providerCooldown.markFailure('cd-unit-a', { status: 429, message: `again ${i}` });
    }
    const snap = providerCooldown.snapshot('cd-unit-a');
    expect(snap.cooldownUntil).toBe(firstUntil);
    expect(snap.cooldownCount).toBe(1);
  });

  it('after the cooldown expires the provider can be attempted again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited' });
      expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);

      vi.setSystemTime(new Date('2026-01-01T00:03:00Z')); // +180s
      expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(false);
      expect(providerCooldown.remainingMs('cd-unit-a')).toBe(0);

      // And a NEW failure after expiry starts a fresh full window.
      providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited again' });
      expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);
      expect(providerCooldown.snapshot('cd-unit-a').cooldownCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a success on the provider clears its cooldown immediately', () => {
    providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited' });
    expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(true);
    providerCooldown.markSuccess('cd-unit-a');
    expect(providerCooldown.isCoolingDown('cd-unit-a')).toBe(false);
  });

  it('cooldown error is fail-fast 429 with countdown and NO provider identity', () => {
    providerCooldown.markFailure('cd-unit-a', { status: 429, message: 'rate limited' });
    const remaining = providerCooldown.remainingMs('cd-unit-a');
    const err: any = createProviderCooldownError('cd-unit-a', remaining);
    expect(err.status).toBe(429);
    /* Provider leak guard: client-facing message must not name the provider. */
    expect(err.message).not.toContain('cd-unit-a');
    expect(err.message).toMatch(/\d+s/);
    expect(err.clientSafe).toBe(true);
    /* Internal metadata (admin/UI) still carries the providerId. */
    expect(err.providerCooldown.providerId).toBe('cd-unit-a');
    expect(err.providerCooldown.remainingMs).toBeGreaterThan(0);
  });
});

describe('Provider Cooldown — multi-key rotation preserved (KeyManager)', () => {
  it('a single 429 cools only that key; other keys stay available for rotation', async () => {
    const { KeyManager } = await import('../src/lib/key-manager');
    const km = new KeyManager(['k1', 'k2', 'k3'], 'CooldownTest');
    km.markCooldown(0);
    expect(km.availableKeys()).toEqual([1, 2]);
    // Round-robin still hands out the remaining keys (multi-key tetap jalan).
    const k1 = await km.getNextKey();
    expect(k1.index).not.toBe(0);
  });

  it('key cooldown duration uses the shared 180s window', async () => {
    const { KeyManager } = await import('../src/lib/key-manager');
    const km = new KeyManager(['k1', 'k2'], 'CooldownTest');
    const before = Date.now();
    km.markCooldown(0);
    const stats = km.getStats();
    expect(stats[0].cooldown).toBe(true);
    // ~180s window (>= 2 minutes), i.e. NOT the legacy 60s.
    expect((stats[0] as any).cooldown).toBe(true);
    const kmAny = km as any;
    const until = kmAny.keyStats[0].disabledUntil as number;
    expect(until - before).toBeGreaterThanOrEqual(179_000);
    expect(until - before).toBeLessThanOrEqual(180_500);
  });
});

/* ─────────────── E2E: real request path through a mock upstream ─────────── */

type MockMode = 'quota' | 'ok';
let mockMode: MockMode = 'quota';
let chatHits = 0;

const MOCK_SERVER = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'cd-mock-model', object: 'model', owned_by: 'nvidia' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    chatHits++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mockMode === 'quota') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock rate limit' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-cd-ok', object: 'chat.completion', created: 1, model: 'cd-mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;
const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');

/* Short window so the E2E can actually observe expiry; production default
 * stays 180s (asserted by the unit test above). */
const TEST_COOLDOWN_MS = 3000;

beforeAll(async () => {
  await new Promise<void>((resolve) => MOCK_SERVER.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK_SERVER.address() as any).port;
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await startServer({
    PROVIDER_COOLDOWN_MS: String(TEST_COOLDOWN_MS),
    /* NVIDIA rotates keys WITHIN one request, so a single request with two
     * keys exhausts the whole pool and proves multi-key behavior + cooldown. */
    NVIDIA_API_KEYS: 'cdkey1,cdkey2',
    NVIDIA_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    /* Second provider with a healthy independent pool — proves cooldown of
     * provider A does not affect provider B (no global cooldown).
     * NOTE: OpenRouter's legacy loader reads the CSV from OPENROUTER_API_KEY. */
    OPENROUTER_API_KEY: 'okkey1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await request('POST', '/admin/models', { model: 'cd-mock-model', providerId: 'nvidia', priority: 10 });
  await request('POST', '/admin/models', { model: 'cd-isolated-model', providerId: 'openrouter', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer();
  MOCK_SERVER.close();
  for (const f of [USAGE_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function chat(): Promise<{ status: number; body: any }> {
  const res = await request('POST', '/v1/chat/completions', {
    model: 'cd-mock-model',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
  }, 15000);
  return { status: res.status, body: res.data };
}

describe('Provider Cooldown — request path (E2E)', () => {
  beforeEach(() => { mockMode = 'quota'; chatHits = 0; });

  it('provider fails (429 on all keys) → enters cooldown; no repeated retry during the window; retry allowed after expiry; other providers unaffected', async () => {
    /* 1. First request: both keys hit the upstream and get 429 → whole pool
     *    exhausted → provider enters cooldown. */
    const first = await chat();
    expect(first.status).toBe(429);
    const hitsAfterFirst = chatHits;
    expect(hitsAfterFirst).toBe(2); // multi-key: both keys were really tried once

    /* 2. Provider Management status shows the cooldown for THAT provider. */
    const list = await request('GET', '/admin/providers');
    const nvidia = (list.data as any[]).find((p) => p.id === 'nvidia');
    expect(nvidia.cooldown.active).toBe(true);
    expect(nvidia.cooldown.remainingMs).toBeGreaterThan(0);
    expect(nvidia.cooldown.remainingMs).toBeLessThanOrEqual(TEST_COOLDOWN_MS);
    expect(nvidia.cooldown.lastStatus).toBe(429);
    /* 4. Cooldown Provider A (nvidia) tidak memengaruhi provider lain. */
    const others = (list.data as any[]).filter((p) => p.id !== 'nvidia');
    for (const p of others) expect(p.cooldown.active).toBe(false);

    /* 3. During cooldown: requests fail FAST (429 + countdown message) and
     *    DO NOT touch the upstream at all — no restart/retry berulang. */
    const hitsBeforeBlocked = chatHits;
    const blocked = await chat();
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(blocked.body)).toContain('rate-limited');
    expect(chatHits).toBe(hitsBeforeBlocked); // zero upstream calls while cooling

    /* 5. Multi-key rotation is NOT replaced by cross-provider fallback: the
     *    request stays on its provider-locked provider and errors out.
     *    (The client body must NOT reveal which provider is cooling.) */
    expect(JSON.stringify(blocked.body)).not.toContain('nvidia');

    /* 4b. Provider B (openrouter) keeps working normally while A cools. */
    mockMode = 'ok';
    const provB = await request('POST', '/v1/chat/completions', {
      model: 'cd-isolated-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    }, 15000);
    expect(provB.status).toBe(200);
    expect(JSON.stringify(provB.data)).toContain('MOCK_OK');
    mockMode = 'quota';

    /* 6. After the window expires the provider may be attempted again. */
    await new Promise((r) => setTimeout(r, TEST_COOLDOWN_MS + 700));
    const listAfter = await request('GET', '/admin/providers');
    const nvidiaAfter = (listAfter.data as any[]).find((p) => p.id === 'nvidia');
    expect(nvidiaAfter.cooldown.active).toBe(false);

    /* 7. Recovery attempt really happens upstream and the provider re-enters
     *    cooldown from the new failure. (chatHits: first request tried 2
     *    keys, provider-B sanity request added 1 more — total 5 hits.) */
    const after = await chat();
    expect(after.status).toBe(429);
    expect(chatHits).toBe(hitsBeforeBlocked + 3);
    const listRecovered = await request('GET', '/admin/providers');
    const nvidiaRecovered = (listRecovered.data as any[]).find((p) => p.id === 'nvidia');
    expect(nvidiaRecovered.cooldown.active).toBe(true);
    expect(nvidiaRecovered.cooldown.cooldownCount).toBe(2);
  }, 30000);

  it('a success clears the cooldown immediately (recovery works)', async () => {
    // Enter cooldown first.
    await chat();
    const list1 = await request('GET', '/admin/providers');
    expect((list1.data as any[]).find((p) => p.id === 'nvidia').cooldown.active).toBe(true);

    // Requests during cooldown fail fast without upstream hits.
    const hits1 = chatHits;
    const blocked = await chat();
    expect(blocked.status).toBe(429);
    expect(chatHits).toBe(hits1);

    // Let the window expire, flip the mock to healthy.
    await new Promise((r) => setTimeout(r, TEST_COOLDOWN_MS + 700));
    mockMode = 'ok';
    const ok = await chat();
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).toContain('MOCK_OK');

    // Success → cooldown stays cleared; further requests flow normally.
    const ok2 = await chat();
    expect(ok2.status).toBe(200);
    const list2 = await request('GET', '/admin/providers');
    const nv = (list2.data as any[]).find((p) => p.id === 'nvidia');
    expect(nv.cooldown.active).toBe(false);
  }, 30000);
});
