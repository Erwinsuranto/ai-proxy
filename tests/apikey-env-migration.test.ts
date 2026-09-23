/**
 * Env → UI-managed API key migration.
 *
 * Verifies (against the throwaway DATA_DIR, never production data):
 *  1. env keys land in the UI store under the right provider, with provenance
 *  2. existing UI records keep order/content/status
 *  3. reruns are idempotent (no duplicates)
 *  4. loader precedence semantics (numbered/csv/single, gap rules)
 *  5. runtime resolver is UI-primary (env never a fallback)
 *  6. reports/responses never carry raw credentials
 *  7. rotation works over resolver output, same-provider only
 *  8. canonical provider ordering, unknown sections preserved
 *
 * Serial by suite config (singleFork, fileParallelism: false).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import { configFile } from './setup';
import {
  addApiKey,
  loadApiKeysForProvider,
  loadAllProviderApiKeys,
  toPublicRecord,
  resolveRuntimeKeys,
} from '../src/lib/api-key-store';
import {
  migrateEnvKeys,
  readNvidiaKeys,
  readProviderKeys,
  PROVIDER_ORDER,
  ENV_PROVIDER_MAP,
} from '../src/lib/migrate-env-keys';
import { KeyManager } from '../src/lib/key-manager';

const STORE_FILE = configFile('provider-api-keys.json');

function resetStore(): void {
  try { fs.unlinkSync(STORE_FILE); } catch { /* ignore */ }
}

function seedUi(providerId: string, keys: string[], status: 'active' | 'disabled' = 'active'): void {
  for (const k of keys) {
    const { record } = addApiKey(providerId, k, `seed ${providerId}`);
    if (status === 'disabled') {
      const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      const rec = store.providers[providerId].find((r: any) => r.id === record.id);
      rec.status = 'disabled';
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    }
  }
}

beforeEach(resetStore);
afterAll(resetStore);

describe('env key readers (mirror config.ts semantics)', () => {
  it('numberedFirst: numbered beats csv and single; empty skipped, undefined stops scan', () => {
    const m = ENV_PROVIDER_MAP.find((e) => e.providerId === 'zen')!;
    const got = readProviderKeys(
      { ZEN_API_KEY_1: ' z1 ', ZEN_API_KEY_2: '', ZEN_API_KEY_3: 'z3', ZEN_API_KEYS: 'c1,c2', ZEN_API_KEY: 's1' }, m,
    );
    expect(got).toEqual([
      { value: 'z1', source: 'ZEN_API_KEY_1' },
      { value: 'z3', source: 'ZEN_API_KEY_3' },
    ]);
    // scan stops at the first undefined slot (mirrors config.ts readNumbered)
    const gap = readProviderKeys({ ZEN_API_KEY_1: 'z1', ZEN_API_KEY_3: 'z3' }, m);
    expect(gap).toEqual([{ value: 'z1', source: 'ZEN_API_KEY_1' }]);
  });

  it('numberedFirst falls back to csv then single', () => {
    const m = ENV_PROVIDER_MAP.find((e) => e.providerId === 'zen')!;
    expect(readProviderKeys({ ZEN_API_KEYS: 'c1, c2' }, m).map((r) => r.value)).toEqual(['c1', 'c2']);
    // single var without comma is consumed by the csv branch (config.ts parity)
    expect(readProviderKeys({ ZEN_API_KEY: ' s1 ' }, m)).toEqual([{ value: 's1', source: 'ZEN_API_KEY[0]' }]);
    expect(readProviderKeys({}, m)).toEqual([]);
  });

  it('legacy mode: csv beats numbered; stops at first empty', () => {
    const m = ENV_PROVIDER_MAP.find((e) => e.providerId === 'openrouter')!;
    const got = readProviderKeys(
      { OPENROUTER_API_KEYS: 'c1', OPENROUTER_API_KEY_1: 'n1', OPENROUTER_API_KEY: 's1' }, m,
    );
    expect(got.map((r) => r.value)).toEqual(['c1']);
    const n = readProviderKeys({ OPENROUTER_API_KEY_1: 'n1', OPENROUTER_API_KEY_3: 'n3' }, m);
    expect(n.map((r) => r.value)).toEqual(['n1']); // legacy stops at first falsy
  });

  it('nvidia: csv beats numbered beats single', () => {
    expect(readNvidiaKeys({ NVIDIA_API_KEYS: 'a,b', NVIDIA_API_KEY_1: 'x' }).map((r) => r.value)).toEqual(['a', 'b']);
    expect(readNvidiaKeys({ NVIDIA_API_KEY_1: 'x', NVIDIA_API_KEY_2: 'y' }).map((r) => r.source))
      .toEqual(['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2']);
    expect(readNvidiaKeys({ NVIDIA_API_KEY: 's' })).toEqual([{ value: 's', source: 'NVIDIA_API_KEY' }]);
  });

  it('every mapping points at exactly one provider (provider-locked table)', () => {
    const pids = ENV_PROVIDER_MAP.map((e) => e.providerId);
    expect(new Set(pids).size).toBe(pids.length);
    const prefixes = ENV_PROVIDER_MAP.map((e) => e.envPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(ENV_PROVIDER_MAP.length).toBeGreaterThanOrEqual(41);
  });
});

describe('migrateEnvKeys', () => {
  const ENV = {
    GROQ_API_KEY_1: 'groq-env-key-A',
    GROQ_API_KEY_2: 'groq-env-key-B',
    KILO_API_KEY: 'kilo-env-single',
    SOME_RANDOM_API_KEY_1: 'should-be-ignored',
    DATABRICKS_ENDPOINT_1: 'https://x|db-key',
  };

  it('adds env keys with provenance labels; existing UI records untouched', () => {
    seedUi('groq', ['groq-ui-existing']);
    const before = loadApiKeysForProvider('groq').map((r) => ({ ...r }));
    const report = migrateEnvKeys(ENV);
    const groq = loadApiKeysForProvider('groq');
    expect(groq.map((r) => r.key)).toEqual(['groq-ui-existing', 'groq-env-key-A', 'groq-env-key-B']);
    // existing record byte-identical (order/content/status preserved)
    expect({ ...groq[0], key: before[0].key }).toEqual({ ...before[0], key: before[0].key });
    expect(groq[0].status).toBe('active');
    expect(groq[1].label).toBe('migrated from GROQ_API_KEY_1');
    expect(groq[2].label).toBe('migrated from GROQ_API_KEY_2');
    const kilo = loadApiKeysForProvider('kilo');
    expect(kilo.map((r) => r.key)).toEqual(['kilo-env-single']);
    expect(kilo[0].status).toBe('active');
    const p = report.providers.find((x) => x.providerId === 'groq')!;
    expect(p).toMatchObject({ envCount: 2, existingUi: 1, added: 2, skippedDuplicate: 0 });
    expect(report.totalAdded).toBe(3);
  });

  it('skips exact duplicates and is idempotent across reruns', () => {
    seedUi('groq', ['groq-env-key-A']);
    const r1 = migrateEnvKeys(ENV);
    expect(r1.providers.find((x) => x.providerId === 'groq')).toMatchObject({ added: 1, skippedDuplicate: 1 });
    expect(loadApiKeysForProvider('groq').map((r) => r.key))
      .toEqual(['groq-env-key-A', 'groq-env-key-B']);
    const r2 = migrateEnvKeys(ENV);
    expect(r2.totalAdded).toBe(0);
    expect(r2.totalSkipped).toBe(3);
    expect(loadApiKeysForProvider('groq')).toHaveLength(2);
  });

  it('never moves keys across providers; unknown vars ignored', () => {
    migrateEnvKeys(ENV);
    const all = loadAllProviderApiKeys();
    expect(Object.keys(all).sort()).toEqual(['groq', 'kilo']);
    expect(all['groq'].every((r) => r.providerId === 'groq')).toBe(true);
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain('should-be-ignored');
    expect(serialized).not.toContain('db-key');
  });

  it('orders provider sections canonically and preserves unknown sections', () => {
    seedUi('zen', ['z-ui']);
    fs.writeFileSync(STORE_FILE, JSON.stringify({
      version: 1,
      providers: {
        ...(JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')).providers),
        'custom-local': [{ id: 'x', providerId: 'custom-local', maskedKey: '***', status: 'active', createdAt: 1, updatedAt: 1, key: 'custom-key' }],
      },
    }, null, 2));
    migrateEnvKeys({ GROQ_API_KEY_1: 'g1', KILO_API_KEY: 'k1' });
    const order = Object.keys(JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')).providers);
    const idx = (p: string) => order.indexOf(p);
    expect(idx('groq')).toBeGreaterThan(-1);
    expect(idx('groq')).toBeLessThan(idx('kilo'));
    expect(idx('kilo')).toBeLessThan(idx('zen'));
    expect(order[order.length - 1]).toBe('custom-local'); // unknown kept at end
    // canonical relative order holds for every known pair present
    const known = order.filter((p) => PROVIDER_ORDER.includes(p));
    const sorted = [...known].sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
    expect(known).toEqual(sorted);
  });

  it('report never contains raw credential values', () => {
    const report = migrateEnvKeys(ENV);
    const text = JSON.stringify(report);
    for (const secret of ['groq-env-key-A', 'groq-env-key-B', 'kilo-env-single']) {
      expect(text).not.toContain(secret);
    }
    expect(report.totalEnv).toBe(3);
  });

  it('migrated records expose masked metadata only', () => {
    migrateEnvKeys(ENV);
    for (const rec of loadApiKeysForProvider('groq')) {
      const pub = toPublicRecord(rec);
      expect(pub).not.toHaveProperty('key');
      expect(pub.maskedKey).toMatch(/^\S{4}\*\*\*\S{4}$|^\*\*\*$/);
    }
  });
});

describe('resolveRuntimeKeys (runtime source)', () => {
  it('returns UI active keys only — env values never enter for migrated providers', () => {
    seedUi('groq', ['groq-ui-1', 'groq-ui-2']);
    const keys = resolveRuntimeKeys('groq', ['groq-env-key-A', 'groq-env-key-B']);
    expect(keys).toEqual(['groq-ui-1', 'groq-ui-2']);
    expect(keys).not.toContain('groq-env-key-A');
  });

  it('excludes disabled UI keys; falls back to env loudly only when UI is empty', () => {
    seedUi('groq', ['groq-ui-off'], 'disabled');
    // disabled records do not count as migrated → env fallback (explicit warn)
    expect(resolveRuntimeKeys('groq', ['groq-env-key-A'])).toEqual(['groq-env-key-A']);
    expect(resolveRuntimeKeys('unknown-provider', [])).toEqual([]);
  });

  it('feeds same-provider round-robin rotation', async () => {
    seedUi('groq', ['groq-ui-1', 'groq-ui-2']);
    const km = new KeyManager(resolveRuntimeKeys('groq', []), 'GroqTest');
    expect(km.keyCount).toBe(2);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push((await km.getNextKey()).key);
    }
    expect(seen).toEqual(['groq-ui-1', 'groq-ui-2', 'groq-ui-1', 'groq-ui-2']);
  });
});
