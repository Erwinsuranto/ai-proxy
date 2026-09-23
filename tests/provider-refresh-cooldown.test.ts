import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  providerRefreshCooldown,
  PROVIDER_REFRESH_COOLDOWN_MS,
  createProviderRefreshCooldownError,
} from '../src/lib/provider-refresh-cooldown';

describe('provider refresh cooldown', () => {
  beforeEach(() => {
    providerRefreshCooldown.reset();
  });

  it('allows the first refresh and rejects another provider independently', () => {
    expect(providerRefreshCooldown.tryStart('a').allowed).toBe(true);
    expect(providerRefreshCooldown.tryStart('a').allowed).toBe(false);
    expect(providerRefreshCooldown.tryStart('b').allowed).toBe(true);
  });

  it('keeps the full 180 second window and expires at the boundary', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      expect(providerRefreshCooldown.tryStart('a').allowed).toBe(true);
      providerRefreshCooldown.finish('a');
      vi.setSystemTime(new Date('2026-01-01T00:02:59Z'));
      expect(providerRefreshCooldown.tryStart('a').allowed).toBe(false);
      vi.setSystemTime(new Date('2026-01-01T00:03:00Z'));
      expect(providerRefreshCooldown.tryStart('a').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent starts permit only one external operation', async () => {
    const decisions = await Promise.all([
      Promise.resolve(providerRefreshCooldown.tryStart('a')),
      Promise.resolve(providerRefreshCooldown.tryStart('a')),
    ]);
    expect(decisions.filter(d => d.allowed)).toHaveLength(1);
  });

  it('returns a frontend-readable cooldown error without credentials', () => {
    providerRefreshCooldown.tryStart('nvidia');
    const error: any = createProviderRefreshCooldownError('nvidia');
    expect(error.status).toBe(429);
    expect(error.message).toContain('Provider refresh cooldown');
    expect(error.providerRefreshCooldown.remainingSeconds).toBeGreaterThan(0);
    expect(error.message).not.toContain('key');
  });
});
