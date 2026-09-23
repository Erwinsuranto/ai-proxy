import { describe, it, expect } from 'vitest';
import { KeyManager, AllKeysCooldownError } from '../src/lib/key-manager';
import { isRetryableError, isQuotaError } from '../src/lib/retry';

describe('NvidiaKeyManager - Single Key', () => {
  it('should initialize with one key', () => {
    const km = new KeyManager(['key1'], 'Test');
    expect(km.keyCount).toBe(1);
  });

  it('should throw if no keys provided', () => {
    expect(() => new KeyManager([], 'Test')).toThrow('At least one API key is required for Test');
  });

  it('should return the same key on repeated calls', async () => {
    const km = new KeyManager(['key1'], 'Test');
    const k1 = await km.getNextKey();
    const k2 = await km.getNextKey();
    expect(k1.key).toBe('key1');
    expect(k2.key).toBe('key1');
    expect(k1.index).toBe(0);
    expect(k2.index).toBe(0);
  });
});

describe('NvidiaKeyManager - Round Robin', () => {
  it('should distribute requests round-robin across 2 keys', async () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    const k1 = await km.getNextKey();
    expect(k1.key).toBe('key1');
    expect(k1.index).toBe(0);

    const k2 = await km.getNextKey();
    expect(k2.key).toBe('key2');
    expect(k2.index).toBe(1);

    const k3 = await km.getNextKey();
    expect(k3.key).toBe('key1');
    expect(k3.index).toBe(0);
  });

  it('should distribute requests round-robin across 5 keys', async () => {
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const km = new KeyManager(keys, 'Test');
    const order: number[] = [];
    for (let i = 0; i < 7; i++) {
      const k = await km.getNextKey();
      order.push(k.index);
    }
    expect(order).toEqual([0, 1, 2, 3, 4, 0, 1]);
  });
});

describe('NvidiaKeyManager - Stats', () => {
  it('should track request and success counts', async () => {
    const km = new KeyManager(['key1'], 'Test');
    await km.getNextKey();
    km.markSuccess(0, 150);

    const stats = km.getStats();
    expect(stats[0].requests).toBe(1);
    expect(stats[0].success).toBe(1);
    expect(stats[0].averageLatency).toBe(150);
  });

  it('should track failures', async () => {
    const km = new KeyManager(['key1'], 'Test');
    await km.getNextKey();
    km.markFailure(0, 'rate limited');

    const stats = km.getStats();
    expect(stats[0].failed).toBe(1);
  });

  it('should track retries', async () => {
    const km = new KeyManager(['key1'], 'Test');
    await km.getNextKey();
    km.markRetry(0);

    const stats = km.getStats();
    expect(stats[0].retry).toBe(1);
  });

  it('should compute average latency correctly', async () => {
    const km = new KeyManager(['key1'], 'Test');
    await km.getNextKey();
    km.markSuccess(0, 100);
    await km.getNextKey();
    km.markSuccess(0, 200);

    const stats = km.getStats();
    expect(stats[0].averageLatency).toBe(150);
    expect(stats[0].success).toBe(2);
    expect(stats[0].requests).toBe(2);
  });
});

describe('NvidiaKeyManager - Cooldown', () => {
  it('should skip key in cooldown and use next available', async () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    km.markCooldown(0);

    const k = await km.getNextKey();
    expect(k.index).toBe(1);
    expect(k.key).toBe('key2');
  });

  it('should throw AllKeysCooldownError when all keys are in cooldown', async () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    km.markCooldown(0);
    km.markCooldown(1);

    await expect(km.getNextKey()).rejects.toThrow(AllKeysCooldownError);
  });

  it('should reactivate key after cooldown expires', async () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    km.markCooldown(0);

    await expect(km.getNextKey()).resolves.toHaveProperty('index', 1);

    km.resetCooldowns();
    const k = await km.getNextKey();
    expect(k.index).toBe(0);
  });

  it('should report cooldown status', () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    km.markCooldown(0);

    const stats = km.getStats();
    expect(stats[0].cooldown).toBe(true);
    expect(stats[0].active).toBe(false);
    expect(stats[1].cooldown).toBe(false);
    expect(stats[1].active).toBe(true);
  });
});

describe('NvidiaKeyManager - Health', () => {
  it('should report correct health metrics', () => {
    const km = new KeyManager(['key1', 'key2', 'key3'], 'Test');
    km.markCooldown(0);
    km.markCooldown(1);

    const h = km.health();
    expect(h.totalKeys).toBe(3);
    expect(h.activeKeys).toBe(1);
    expect(h.cooldownKeys).toBe(2);
    expect(h.requests).toBe(0);
  });

  it('should report total requests', async () => {
    const km = new KeyManager(['key1', 'key2'], 'Test');
    await km.getNextKey();
    await km.getNextKey();

    const h = km.health();
    expect(h.requests).toBe(2);
  });
});

describe('NvidiaKeyManager - Failover', () => {
  it('should skip failed key and use next available', async () => {
    const km = new KeyManager(['key1', 'key2', 'key3'], 'Test');
    km.markCooldown(0);
    km.markCooldown(1);

    const k = await km.getNextKey();
    expect(k.index).toBe(2);
  });

  it('should return different keys for each call when some are cooldown', async () => {
    const km = new KeyManager(['k1', 'k2', 'k3', 'k4', 'k5'], 'Test');
    km.markCooldown(2);
    km.markCooldown(4);

    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const k = await km.getNextKey();
      order.push(k.index);
    }
    expect(order).toEqual([0, 1, 3, 0, 1, 3]);
  });
});

describe('Retry Logic - isRetryableError', () => {
  it('should return true for retryable HTTP statuses', () => {
    expect(isRetryableError({ status: 401 })).toBe(true);
    expect(isRetryableError({ status: 403 })).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 504 })).toBe(true);
  });

  it('should return false for non-retryable statuses', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 422 })).toBe(false);
  });

  it('should return true for timeout errors', () => {
    expect(isRetryableError({ message: 'timeout of 30000ms exceeded' })).toBe(true);
    expect(isRetryableError({ message: 'network error' })).toBe(true);
  });
});

describe('Retry Logic - isQuotaError', () => {
  it('should return true for 429 status', () => {
    expect(isQuotaError({ status: 429 })).toBe(true);
  });

  it('should return true for rate limit messages', () => {
    expect(isQuotaError({ message: 'rate limit exceeded' })).toBe(true);
    expect(isQuotaError({ message: 'quota exceeded' })).toBe(true);
    expect(isQuotaError({ message: 'too many requests' })).toBe(true);
  });

  it('should return false for non-quota errors', () => {
    expect(isQuotaError({ status: 500 })).toBe(false);
    expect(isQuotaError({ message: 'server error' })).toBe(false);
  });
});

describe('KeyManager - getKey info', () => {
  it('should mask key properly', () => {
    const km = new KeyManager(['nvapi-abcdefghijklmnop'], 'Test');
    const info = km.getKey(0);
    expect(info.masked).toBe('nvap***mnop');
    expect(info.tag).toBe('Using Test Key #1');
    expect(info.key).toBe('nvapi-abcdefghijklmnop');
  });

  it('should short mask for short keys', () => {
    const km = new KeyManager(['short'], 'Test');
    const info = km.getKey(0);
    expect(info.masked).toBe('***');
  });
});
