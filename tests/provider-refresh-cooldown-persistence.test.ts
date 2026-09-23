import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProviderRefreshCooldown,
  PROVIDER_REFRESH_COOLDOWN_MS,
  providerRefreshCooldown,
} from '../src/lib/provider-refresh-cooldown';

/* Persistence tests use throwaway files in os.tmpdir — never the shared vitest
 * DATA_DIR and never live production state. Each test gets a fresh directory
 * so "no state file yet" is the true starting condition. */

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prc-persistence-'));
}

describe('provider refresh cooldown persistence', () => {
  let dir: string;
  let stateFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeTempDir();
    stateFile = path.join(dir, 'provider-refresh-cooldown-state.json');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scenario 1+2+6: first refresh PASS, second <180s BLOCKED, state persisted to file', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    expect(fs.existsSync(stateFile)).toBe(false); // nothing written before a real refresh

    const first = cd.tryStart('prov-a');
    expect(first.allowed).toBe(true);
    expect(first.remainingMs).toBe(PROVIDER_REFRESH_COOLDOWN_MS);

    // State file written at the commit point with only id + timestamp.
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.nextAllowedAt['prov-a']).toBeGreaterThan(0);

    // External refresh finishes (inFlight released) but the window remains.
    cd.finish('prov-a');
    const second = cd.tryStart('prov-a');
    expect(second.allowed).toBe(false);
    expect(second.remainingMs).toBeGreaterThan(0);
    expect(second.remainingMs).toBeLessThanOrEqual(PROVIDER_REFRESH_COOLDOWN_MS);
  });

  it('scenario 3: refresh >=180s after expiry is allowed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cd = new ProviderRefreshCooldown(stateFile);
      expect(cd.tryStart('prov-a').allowed).toBe(true);
      cd.finish('prov-a');
      vi.setSystemTime(new Date('2026-01-01T00:02:59Z'));
      expect(cd.tryStart('prov-a').allowed).toBe(false);
      vi.setSystemTime(new Date('2026-01-01T00:03:00Z'));
      expect(cd.tryStart('prov-a').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scenario 4: provider A and B cooldowns are independent', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    expect(cd.tryStart('prov-a').allowed).toBe(true);
    cd.finish('prov-a');
    expect(cd.tryStart('prov-a').allowed).toBe(false);
    expect(cd.tryStart('prov-b').allowed).toBe(true); // B unaffected by A
    cd.finish('prov-b');
    // Wall-clock may tick 1ms between tryStart and this assertion.
    const remainingB = cd.remainingMs('prov-b');
    expect(remainingB).toBeGreaterThan(PROVIDER_REFRESH_COOLDOWN_MS - 10);
    expect(remainingB).toBeLessThanOrEqual(PROVIDER_REFRESH_COOLDOWN_MS);
  });

  it('scenario 5: concurrent starts on one instance yield a single external refresh', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    const decisions = Array.from({ length: 5 }, () => cd.tryStart('prov-a'));
    expect(decisions.filter(d => d.allowed)).toHaveLength(1);
    // And the persisted timestamp reflects exactly one commit.
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(Object.keys(parsed.nextAllowedAt)).toEqual(['prov-a']);
  });

  it('scenario 7: restart <180s — a fresh instance recovers cooldown from the file and stays BLOCKED', () => {
    const instanceA = new ProviderRefreshCooldown(stateFile);
    const startResult = instanceA.tryStart('prov-a');
    expect(startResult.allowed).toBe(true);
    instanceA.finish('prov-a');

    // "Restart": brand-new instance (as after PM2 restart), same state file.
    const instanceB = new ProviderRefreshCooldown(stateFile);
    const blocked = instanceB.tryStart('prov-a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remainingMs).toBeGreaterThan(0);
    expect(blocked.remainingMs).toBeLessThanOrEqual(PROVIDER_REFRESH_COOLDOWN_MS);
    // No external refresh happened — no second commit was persisted.
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(Object.keys(parsed.nextAllowedAt)).toEqual(['prov-a']);
  });

  it('scenario 8: restart >=180s — recovered state is expired, refresh PASS again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const instanceA = new ProviderRefreshCooldown(stateFile);
      expect(instanceA.tryStart('prov-a').allowed).toBe(true);
      instanceA.finish('prov-a');

      vi.setSystemTime(new Date('2026-01-01T00:04:00Z')); // > 180s later
      const instanceB = new ProviderRefreshCooldown(stateFile);
      expect(instanceB.tryStart('prov-a').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scenario 9: missing persistence file means never refreshed (first refresh PASS)', () => {
    expect(fs.existsSync(stateFile)).toBe(false);
    const cd = new ProviderRefreshCooldown(stateFile);
    expect(cd.isCoolingDown('prov-a')).toBe(false);
    expect(cd.tryStart('prov-a').allowed).toBe(true);
  });

  it('scenario 10a: malformed JSON state file warns and starts empty (no crash)', () => {
    fs.writeFileSync(stateFile, '{ this is not valid json !!!', 'utf-8');
    expect(() => new ProviderRefreshCooldown(stateFile)).not.toThrow();
    const cd = new ProviderRefreshCooldown(stateFile);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Could not read state file'))).toBe(true);
    expect(cd.tryStart('prov-a').allowed).toBe(true);
  });

  it('scenario 10b: corrupt-but-valid JSON / invalid entries are dropped safely', () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      nextAllowedAt: {
        'prov-a': 'not-a-number',            // invalid timestamp → dropped
        '': 9999999999999,                   // invalid id → dropped
        'ok-provider': 9999999999999,        // valid future ts → kept
        '../escape': 9999999999999,          // path-like id → dropped
      },
    }), 'utf-8');
    const cd = new ProviderRefreshCooldown(stateFile);
    expect(cd.remainingMs('prov-a')).toBe(0);
    expect(cd.remainingMs('')).toBe(0);
    expect(cd.remainingMs('../escape')).toBe(0);
    expect(cd.remainingMs('ok-provider')).toBeGreaterThan(0);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Dropping invalid state entry'))).toBe(true);
  });

  it('scenario 11: rejected refreshes, finish() and reads never change the persisted timestamp', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    cd.tryStart('prov-a');
    cd.finish('prov-a');
    const before = fs.readFileSync(stateFile, 'utf-8');

    cd.tryStart('prov-a');            // rejected — must NOT rewrite state
    cd.remainingMs('prov-a');         // read
    cd.isCoolingDown('prov-a');       // read
    cd.finish('prov-a');              // no-op state change

    const after = fs.readFileSync(stateFile, 'utf-8');
    expect(after).toBe(before);
  });

  it('scenario 12: per-provider isolation (no cross-provider bleed in cooldown state)', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    cd.tryStart('prov-a');
    cd.finish('prov-a');
    // B has no entry at all and can refresh; A remains cooling down.
    const parsedA = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(parsedA.nextAllowedAt['prov-b']).toBeUndefined();
    expect(cd.tryStart('prov-b').allowed).toBe(true);
    expect(cd.tryStart('prov-a').allowed).toBe(false);
  });

  it('persisted file never contains credentials (only ids + timestamps)', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    cd.tryStart('prov-a');
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(['version', 'updatedAt', 'nextAllowedAt']);
    for (const [id, ts] of Object.entries(parsed.nextAllowedAt)) {
      expect(typeof id).toBe('string');
      expect(typeof ts).toBe('number');
    }
    expect(raw.toLowerCase()).not.toContain('bearer');
    expect(raw.toLowerCase()).not.toContain('apikey');
  });

  it('clear() removes the entry from persistence (admin/test reset path)', () => {
    const cd = new ProviderRefreshCooldown(stateFile);
    cd.tryStart('prov-a');
    cd.finish('prov-a');
    cd.clear('prov-a');
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(parsed.nextAllowedAt['prov-a']).toBeUndefined();
    expect(cd.tryStart('prov-a').allowed).toBe(true);
  });
});

describe('provider refresh cooldown (singleton integration, vitest DATA_DIR)', () => {
  beforeEach(() => {
    providerRefreshCooldown.reset();
  });

  it('singleton keeps working with persistence enabled (existing behavior intact)', () => {
    expect(providerRefreshCooldown.tryStart('singleton-prov').allowed).toBe(true);
    expect(providerRefreshCooldown.tryStart('singleton-prov').allowed).toBe(false);
    expect(providerRefreshCooldown.tryStart('other-prov').allowed).toBe(true);
    providerRefreshCooldown.finish('singleton-prov');
    providerRefreshCooldown.finish('other-prov');
  });
});
