/* Provider API Key Management — selection toolbar, bulk actions (via the
 * existing per-key endpoints only) and auto-numbered label defaults.
 * Pure helpers run in Node; endpoint semantics run against the standard
 * tests/setup harness; UI wiring is asserted on the served bundle (project
 * style for the DOM layer). Raw test keys here are FAKE credentials and are
 * never printed. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { startServer, stopServer, request, configFile } from './setup';
import { nextKeyLabelSuggestion, bumpKeyLabel } from '../src/admin/dashboard';

const STORE_FILE = configFile('provider-api-keys.json');

/** served compiled dashboard bundle (for UI-wiring assertions) */
let JS = '';


/** Fake unique credential (never logged). */
const FAKE = (n: number) => `sk-bulktest-fake-${n}-${Date.now()}`;

async function addKey(label: string, n: number): Promise<string> {
  const res = await request('POST', '/admin/providers/nvidia/api-keys', { apiKey: FAKE(n), label });
  expect(res.status).toBe(201);
  return res.data.key.id;
}
async function listKeys(): Promise<any[]> {
  const res = await request('GET', '/admin/providers/nvidia/api-keys');
  expect(res.status).toBe(200);
  return res.data.keys;
}
async function suggestedLabel(): Promise<string> {
  const res = await request('GET', '/admin/providers/nvidia/api-keys');
  return res.data.suggestedLabel;
}

beforeAll(async () => {
  if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE);
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
  JS = String((await request('GET', '/admin/dashboard.js')).data);
  // ensure the provider is registered before any managed-key POST
  const provs = await request('GET', '/admin/providers');
  expect(provs.data.find((p: any) => p.id === 'nvidia')).toBeTruthy();
}, 30000);

afterAll(async () => {
  await stopServer();
  if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE);
});

/* ======================================================================== */
describe('auto-numbered label suggestions (G)', () => {
  it('19. empty store -> Production Key 1', () => {
    expect(nextKeyLabelSuggestion([])).toBe('Production Key 1');
    expect(nextKeyLabelSuggestion([undefined, ''])).toBe('Production Key 1');
  });
  it('20. one existing -> next number', () => {
    expect(nextKeyLabelSuggestion(['Production Key 1'])).toBe('Production Key 2');
  });
  it('21. two existing -> third', () => {
    expect(nextKeyLabelSuggestion(['Production Key 1', 'Production Key 2'])).toBe('Production Key 3');
  });
  it('22. numbering gaps use HIGHEST + 1 (never count+1)', () => {
    expect(nextKeyLabelSuggestion(['Production Key 1', 'Production Key 3'])).toBe('Production Key 4');
  });
  it('23. double digits keep incrementing', () => {
    expect(nextKeyLabelSuggestion(['Production Key 10'])).toBe('Production Key 11');
    expect(nextKeyLabelSuggestion(['Production Key 2', 'Production Key 9', 'Production Key 10'])).toBe('Production Key 11');
  });
  it('25. a 3-key bulk-add sequence numbers 3,4,5', () => {
    const labels = ['Production Key 1', 'Production Key 2'];
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = nextKeyLabelSuggestion(labels);
      out.push(s);
      labels.push(s);
    }
    expect(out).toEqual(['Production Key 3', 'Production Key 4', 'Production Key 5']);
  });
  it('26. helper never rewrites or mutates existing names', () => {
    const labels = ['Production Key 1', 'Legacy Name', 'Production Key 3'];
    const snapshot = [...labels];
    expect(nextKeyLabelSuggestion(labels)).toBe('Production Key 4');
    expect(labels).toEqual(snapshot);
  });
  it('H. collision against taken labels is bumped, existing labels untouched', () => {
    expect(bumpKeyLabel('Production Key 2', new Set(['Production Key 2']))).toBe('Production Key 3');
    expect(bumpKeyLabel('Manual', new Set(['Manual']))).toBe('Manual 2');
    expect(bumpKeyLabel('Unique', new Set(['Other']))).toBe('Unique');
  });
});

/* ======================================================================== */
describe('watermark: deleted numbers are never reused (E2E, G/H)', () => {
  it('24. delete the highest, suggestion still moves forward', async () => {
    const id1 = await addKey('Production Key 1', 1);
    const id2 = await addKey('Production Key 2', 2);
    const id3 = await addKey('Production Key 3', 3);
    expect(await suggestedLabel()).toBe('Production Key 4');
    expect((await request('DELETE', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id3)}`)).status).toBe(200);
    // current labels are 1..2 — the persisted watermark keeps the suggestion at 4
    expect(await suggestedLabel()).toBe('Production Key 4');
    // counters are plain metadata, never secrets
    const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    expect(store.nameCounters.nvidia.base).toBe('Production Key');
    expect(store.nameCounters.nvidia.n).toBe(3);
    // the surviving keys keep their exact stored numbers
    const left = (await listKeys()).map(k => k.label).sort();
    expect(left).toEqual(['Production Key 1', 'Production Key 2']);
    await request('DELETE', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id1)}`);
    await request('DELETE', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id2)}`);
  });

  it('custom label does not hijack the numbering base', async () => {
    const id = await addKey('My Special Name', 9);
    expect(await suggestedLabel()).toBe('Production Key 4'); // watermark base preserved
    await request('DELETE', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id)}`);
  });
});

/* ======================================================================== */
describe('API keys modal — toolbar & selection wiring (served UI)', () => {
  it('every key row carries a selection checkbox + masked-only identifiers', () => {
    expect(JS).toContain('data-key-select=');
    expect(JS).toContain('aria-label="Select API key ${esc(k.maskedKey)}"');
    // raw key value must not leak into any confirm/selection markup
    expect(JS).toMatch(/listMaskedKeys[^]*?<code>\$\{esc\(e\.masked\)\}<\/code>/);
  });

  it('compact toolbar: Select All, Enable All, Disable Selected, Delete Selected + counter', () => {
    for (const id of ['apikey-select-all', 'apikey-toolbar', 'apikey-enable-all', 'apikey-disable-sel', 'apikey-delete-sel', 'apikey-selection-count']) {
      expect(JS).toContain(id);
    }
    expect(JS).toContain(' selected`');
  });

  it('Select All checks all visible rows; indeterminate reflects partial state', () => {
    expect(JS).toContain('box.checked = selectAll.checked');
    expect(JS).toContain('all.checked = boxes.length > 0 && n === boxes.length');
    expect(JS).toContain('all.indeterminate = n > 0 && n < boxes.length');
  });

  it('1/2. single + multiple selection are tracked independently', () => {
    // per-row change handler recomputes from DOM (any subset supported)
    expect(JS).toContain("[data-key-select]:checked");
    expect(JS).toContain("box.addEventListener('change', () => updateApiKeySelectionUI())");
  });

  it('8/12. zero selection keeps bulk buttons disabled', () => {
    expect(JS).toContain('<button type="button" id="apikey-disable-sel" class="btn btn--xs btn--ghost" disabled>');
    expect(JS).toContain('<button type="button" id="apikey-delete-sel" class="btn btn--xs btn--danger" disabled>');
    const sync = JS.slice(JS.indexOf('function updateApiKeySelectionUI'), JS.indexOf('function updateApiKeySelectionUI') + 1400);
    expect(sync).toContain('disableBtn.disabled = n === 0');
    expect(sync).toContain('deleteBtn.disabled = n === 0');
  });

  it('4. selection resets safely after every action/provider switch', () => {
    // bulk completion RE-RENDERS from the backend — a fresh DOM with empty
    // checkboxes — so no selection can linger or cross providers.
    expect(JS).toContain('async function finishBulkApiKeys');
    const fin = JS.slice(JS.indexOf('async function finishBulkApiKeys'), JS.indexOf('async function finishBulkApiKeys') + 900);
    expect(fin).toContain('await openApiKeysModal(apiKeysProviderId);');
    expect(JS).toMatch(/bulkApplyApiKeys[^]*?const pid = encodeURIComponent\(apiKeysProviderId\)/);
  });
});

/* ======================================================================== */
describe('bulk action semantics (E2E via existing endpoints)', () => {
  let ids: string[] = [];
  const MARKER_MODEL = 'bulk-scope/keep-me-model';
  beforeAll(async () => {
    // Register OUR OWN model: proves later that key deletes never cascade to
    // models. (The harness's seeded models may be pruned by other suites in a
    // full run — we must not depend on global model state.)
    const reg = await request('POST', '/admin/models', { model: MARKER_MODEL, providerId: 'nvidia', priority: 99 });
    expect([200, 201, 409]).toContain(reg.status);
    for (let i = 0; i < 4; i++) ids.push(await addKey(`Production Key ${i + 1}`, 100 + i));
  });

  it('6/7. disable-selected only touches the selected keys', async () => {
    const [a, b] = ids;
    // exact requests the UI fires (Promise.all of existing PATCH endpoint)
    const rs = await Promise.all([
      request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(a)}`, { enabled: false }),
      request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(b)}`, { enabled: false }),
    ]);
    expect(rs.every(r => r.status === 200)).toBe(true);
    const keys = await listKeys();
    const disabled = keys.filter(k => k.status === 'disabled').map(k => k.id).sort();
    expect(disabled).toEqual([a, b].sort());
    expect(keys.filter(k => k.status === 'active').map(k => k.id).sort()).toEqual(ids.slice(2).sort());
  });

  it('9. a bad id in the batch fails individually — endpoint never fakes ok', async () => {
    const good = ids[2];
    const rs = await Promise.all([
      request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(good)}`, { enabled: false }),
      request('PATCH', '/admin/providers/nvidia/api-keys/key_does-not-exist', { enabled: false }),
    ]);
    const ok = rs.filter(r => r.status === 200).map(r => r.status);
    expect(ok).toHaveLength(1);
    expect(rs[1].status).toBe(404);
    // partial count wording is honest (never "all succeeded" when failed>0)
    const bulk = JS.slice(JS.indexOf('async function bulkApplyApiKeys'), JS.indexOf('async function bulkApplyApiKeys') + 900);
    expect(bulk).toContain('failed: ids.length - ok');
    const fin = JS.slice(JS.indexOf('async function finishBulkApiKeys'), JS.indexOf('async function finishBulkApiKeys') + 900);
    expect(fin).toContain('if (res.failed === 0)');
    expect(fin).not.toMatch(/failed > 0[^]*?'\$\{res\.ok\} of \$\{total\} selected keys[^]*?all/i);
  });

  it('10/13. delete-selected removes only the chosen rows; others survive', async () => {
    // re-enable everything first (simulates enable-all loop), then delete two
    for (const id of ids) await request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id)}`, { enabled: true });
    const doomed = ids.slice(0, 2);
    const rs = await Promise.all(doomed.map(id => request('DELETE', `/admin/providers/nvidia/api-keys/${encodeURIComponent(id)}`)));
    expect(rs.every(r => r.status === 200)).toBe(true);
    const left = await listKeys();
    expect(left.map(k => k.id).sort()).toEqual(ids.slice(2).sort());
    expect(left.every(k => k.status === 'active')).toBe(true);
  });

  it('14. provider + models + client keys survive key deletion', async () => {
    const provs = await request('GET', '/admin/providers');
    const nvidia = provs.data.find((p: any) => p.id === 'nvidia');
    expect(nvidia).toBeTruthy();
    // the provider still has models — delete-selected never cascades
    expect(nvidia.models.length).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(nvidia.models)).toContain(MARKER_MODEL);
    const ck = await request('GET', '/admin/client-keys');
    expect(ck.status).toBe(200);
    const models = await request('GET', '/admin/models');
    expect(models.status).toBe(200);
    expect(JSON.stringify(models.data)).toContain(MARKER_MODEL);
  });

  it('15. responses and the store file keep raw keys out of the payload/ids', async () => {
    const keys = await listKeys();
    for (const k of keys) {
      expect(JSON.stringify(k)).not.toMatch(/sk-bulktest/);
      expect(k.maskedKey).toContain("***");
    }
  });

  it('16/17/18. enable-all enables only this provider and is idempotent', async () => {
    await request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(ids[2])}`, { enabled: false });
    const disabled = (await listKeys()).filter(k => k.status === 'disabled');
    expect(disabled).toHaveLength(1);
    const rs = await Promise.all(disabled.map(k => request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(k.id)}`, { enabled: true })));
    expect(rs.every(r => r.status === 200)).toBe(true);
    // second pass on already-active keys: endpoint idempotent (200, still active)
    const all = await listKeys();
    expect(all.every(k => k.status === 'active')).toBe(true);
    const rs2 = await Promise.all(all.map(k => request('PATCH', `/admin/providers/nvidia/api-keys/${encodeURIComponent(k.id)}`, { enabled: true })));
    expect(rs2.every(r => r.status === 200)).toBe(true);
    // UI never sends per-row enables when nothing is disabled — guard + strings
    const enable = JS.slice(JS.indexOf('async function enableAllApiKeys'), JS.indexOf('async function enableAllApiKeys') + 800);
    expect(enable).toContain('if (disabled.length === 0)');
    expect(enable).toContain('already enabled — nothing changed');
  });

  it('32. keys are provider-bound: cross-provider access is rejected', async () => {
    for (const id of ids) {
      const res = await request('DELETE', `/admin/providers/huggingface/api-keys/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      const pat = await request('PATCH', `/admin/providers/huggingface/api-keys/${encodeURIComponent(id)}`, { enabled: false });
      expect(pat.status).toBe(404);
    }
    await request('DELETE', `/admin/models/nvidia/${encodeURIComponent(MARKER_MODEL)}`);
  });
});


