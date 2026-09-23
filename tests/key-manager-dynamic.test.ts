import { describe, it, expect } from 'vitest';
import { KeyManager, AllKeysCooldownError } from '../src/lib/key-manager';

/* Unit tests for the dynamic key management operations added for Admin UI
 * API key management (add / remove / disable / enable at runtime). */

describe('KeyManager dynamic operations', () => {
  it('addKey appends a new key to the rotation', async () => {
    const km = new KeyManager(['env-key-1111', 'env-key-2222'], 'Test');
    expect(km.keyCount).toBe(2);

    km.addKey('ui-key-3333');
    expect(km.keyCount).toBe(3);
    expect(km.hasRawKey('ui-key-3333')).toBe(true);

    // Round-robin over all keys: the added key must be served.
    const served = new Set<string>();
    for (let i = 0; i < 3; i++) {
      served.add((await km.getNextKey()).key);
    }
    expect(served.has('ui-key-3333')).toBe(true);
    expect(served.size).toBe(3);
  });

  it('addKey is idempotent for an already-present raw value', () => {
    const km = new KeyManager(['env-key-1111'], 'Test');
    km.addKey('env-key-1111');
    expect(km.keyCount).toBe(1);
  });

  it('removeKeyByValue removes the key from rotation', async () => {
    const km = new KeyManager(['a-1111', 'b-2222', 'c-3333'], 'Test');
    expect(km.removeKeyByValue('b-2222')).toBe(true);
    expect(km.keyCount).toBe(2);
    expect(km.hasRawKey('b-2222')).toBe(false);
    for (let i = 0; i < 5; i++) {
      const k = (await km.getNextKey()).key;
      expect(['a-1111', 'c-3333']).toContain(k);
    }
  });

  it('removeKeyByValue refuses to remove the last remaining key', () => {
    const km = new KeyManager(['only-1111'], 'Test');
    expect(km.removeKeyByValue('only-1111')).toBe(false);
    expect(km.keyCount).toBe(1);
  });

  it('disableKeyByValue skips the key for new requests without deleting it', async () => {
    const km = new KeyManager(['a-1111', 'b-2222'], 'Test');
    expect(km.disableKeyByValue('b-2222')).toBe(true);
    // Every subsequent selection must avoid the disabled key.
    for (let i = 0; i < 5; i++) {
      expect((await km.getNextKey()).key).toBe('a-1111');
    }
    expect(km.keyCount).toBe(2); // still stored

    // All keys disabled → clear rotation error, not a crash.
    km.disableKeyByValue('a-1111');
    await expect(km.getNextKey()).rejects.toBeInstanceOf(AllKeysCooldownError);
  });

  it('enableKeyByValue restores a disabled key into rotation', async () => {
    const km = new KeyManager(['a-1111', 'b-2222'], 'Test');
    km.disableKeyByValue('a-1111');
    km.enableKeyByValue('a-1111');
    const served = new Set<string>();
    for (let i = 0; i < 4; i++) served.add((await km.getNextKey()).key);
    expect(served.size).toBe(2);
  });

  it('enable/disable return false for unknown keys', () => {
    const km = new KeyManager(['a-1111'], 'Test');
    expect(km.disableKeyByValue('unknown')).toBe(false);
    expect(km.enableKeyByValue('unknown')).toBe(false);
  });
});
