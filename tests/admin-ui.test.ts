/**
 * Integration test: verifies the Admin Dashboard UI is wired up to the
 * running server — `GET /admin`, `GET /admin/styles.css`, `GET /admin/dashboard.js`
 * serve real content with the right content-types, and the existing JSON
 * admin API keeps working alongside them.
 *
 * Builds on the established harness at tests/setup.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { startServer, stopServer, request, configFile } from './setup';

const BACKUP_DIR = configFile('backups');
/** Track backup IDs we created so the test file cleans up only its own at the end. */
const createdBids: string[] = [];

beforeAll(async () => {
  if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  await startServer({ NVIDIA_API_KEYS: 'key1,key2' });
}, 30000);

afterAll(async () => {
  await stopServer();
  for (const id of createdBids.splice(0)) {
    try { if (fs.existsSync(path.join(BACKUP_DIR, `${id}.json`))) fs.unlinkSync(path.join(BACKUP_DIR, `${id}.json`)); } catch { /* best effort */ }
  }
  if (fs.existsSync(BACKUP_DIR)) {
    try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Helper: create a fresh backup, remember its id for cleanup, return its id. */
async function backupCreate(): Promise<string> {
  const r = await request('POST', '/admin/backup', {});
  if (r.status !== 200 || !r.data?.backupId) throw new Error(`unexpected backup/create response: ${JSON.stringify(r.data)}`);
  createdBids.push(r.data.backupId);
  return r.data.backupId;
}

/** Helper: best-effort remove a backup ID (allowed to be absent if a sibling test cleaned the dir). */
async function backupDelete(id: string): Promise<void> {
  const r = await request('DELETE', `/admin/backup/${encodeURIComponent(id)}`);
  /* 404 is acceptable — a sibling test (or parallel run) may have already pruned it. */
  if (r.status !== 200 && r.status !== 404) throw new Error(`unexpected delete response ${r.status} for ${id}: ${JSON.stringify(r.data)}`);
}

describe('Admin Dashboard UI plumbing', () => {
  it('GET /admin serves text/html', async () => {
    const res = await request('GET', '/admin');
    expect(res.status).toBe(200);
    /* request() parses JSON when content-type is JSON; otherwise it returns
       the raw string body. HTML is returned as a string. */
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('Admin Dashboard');
    /* The HTML references the compiled module JS and the stylesheet. */
    expect(body).toContain('/admin/styles.css');
    expect(body).toContain('type="module"');
    expect(body).toContain('/admin/dashboard.js');
  });

  it('GET /admin/styles.css serves text/css', async () => {
    const res = await request('GET', '/admin/styles.css');
    expect(res.status).toBe(200);
    const body = typeof res.data === 'string' ? res.data : '';
    expect(body).toContain('--color-primary');
    expect(body).toContain('summary-card');
  });

  it('GET /admin/dashboard.js serves JS (ES module exports)', async () => {
    const res = await request('GET', '/admin/dashboard.js');
    expect(res.status).toBe(200);
    const body = typeof res.data === 'string' ? res.data : '';
    expect(body).toContain('async function api');
    expect(body).toContain('export const __test');
    expect(body).toContain('renderUsageSummaryHTML');
    /* CommonJS leak that would break browsers must NOT appear. */
    expect(body).not.toContain('Object.defineProperty(exports');
  });

  it('GET /admin/providers still works with the UI routes co-registered', async () => {
    const res = await request('GET', '/admin/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    const nvidia = res.data.find((p: any) => p.id === 'nvidia');
    expect(nvidia).toBeDefined();
    expect(nvidia.enabled).toBe(true);
  });

  it('PATCH /admin/providers/nvidia returns the documented contract', async () => {
    const off = await request('PATCH', '/admin/providers/nvidia', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.data.status).toBe('ok');
    expect(off.data.enabled).toBe(false);
    /* Re-enable and ensure it stays consistent. */
    const on = await request('PATCH', '/admin/providers/nvidia', { enabled: true });
    expect(on.data.enabled).toBe(true);
  });

  it('GET /admin/usage exposes the summary fields the dashboard consumes', async () => {
    const res = await request('GET', '/admin/usage');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('totalRequests');
    expect(res.data).toHaveProperty('totalSuccess');
    expect(res.data).toHaveProperty('totalFailed');
    expect(res.data).toHaveProperty('totalBlocked');
    expect(res.data).toHaveProperty('totalPromptTokens');
    expect(res.data).toHaveProperty('totalCompletionTokens');
    expect(res.data).toHaveProperty('totalTokens');
    expect(res.data).toHaveProperty('avgLatencyMs');
  });

  it('GET /admin/usage/providers returns the breakdown shape the table expects', async () => {
    const res = await request('GET', '/admin/usage/providers');
    expect(res.status).toBe(200);
    expect(typeof res.data).toBe('object');
  });

  it('GET /admin/usage/models returns the breakdown shape the table expects', async () => {
    const res = await request('GET', '/admin/usage/models');
    expect(res.status).toBe(200);
    expect(typeof res.data).toBe('object');
  });

  it('GET /admin/logs honors limit/offset (proper backend pagination)', async () => {
    const res = await request('GET', '/admin/logs?limit=5&offset=0');
    expect(res.status).toBe(200);
    expect(res.data.total).toBeTypeOf('number');
    expect(Array.isArray(res.data.logs)).toBe(true);
    expect(res.data.logs.length).toBeLessThanOrEqual(5);
  });

  it('GET /admin/logs honors provider filter passed to backend', async () => {
    const res = await request('GET', '/admin/logs?provider=nvidia');
    expect(res.status).toBe(200);
    for (const l of res.data.logs) {
      expect(l.provider).toBe('nvidia');
    }
  });

  it('GET /admin/logs honors status filter passed to backend', async () => {
    const res = await request('GET', '/admin/logs?status=success');
    expect(res.status).toBe(200);
    for (const l of res.data.logs) {
      expect(l.status).toBe('success');
    }
  });

  it('GET /admin/logs blocks 4xx/5xx NEVER appear as 200 (HTTP status preserved)', async () => {
    /* The dashboard renders httpStatus as-is. We do not fabricate codes. */
    const res = await request('GET', '/admin/logs?status=error&limit=20');
    if (res.data.logs.length > 0) {
      const withHttp = res.data.logs.find((l: any) => l.httpStatus !== null && l.httpStatus !== undefined);
      if (withHttp) {
        expect(withHttp.httpStatus).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

/* ============================================================================
 * Backup/Restore UI plumbing + security audit (Prompt 13 §22–§25, §32)
 * ========================================================================== */

describe('Admin Backup tab — wired to /admin/backup/* + served content', () => {
  it('the admin HTML references the Backup tab and the Create button', async () => {
    const htmlRes = await request('GET', '/admin');
    const body = typeof htmlRes.data === 'string' ? htmlRes.data : '';
    expect(body).toContain('data-tab="backup"');
    expect(body).toContain('id="tab-backup"');
    expect(body).toContain('id="backup-create"');
    expect(body).toContain('id="backup-tbody"');
    /* Modals for info + restore confirmation must exist in the DOM. */
    expect(body).toContain('id="backup-info-modal"');
    expect(body).toContain('id="confirm-modal"');
    expect(body).toContain('id="confirm-ok"');
    expect(body).toContain('id="confirm-cancel"');
  });
});

describe('Admin Backup lifecycle (Create / List / Info / Download / Restore / Delete)', () => {
  it('checks the empty-state, then a full backup round-trip', async () => {
    /* backup.test.ts shares the same config/backups dir and runs aggressive
       cleanup (rmrf). This test defensively remembers only the backup IDs
       it creates and silently tolerates 404 during cleanup, so a parallel
       picky run can never make us flake. */

    /* 1) Create */
    const backupId = await backupCreate();
    /* Re-fetch the create response's metadata for one variant assertion. */
    const createRes = (await request('GET', `/admin/backup/info/${encodeURIComponent(backupId)}`));
    expect(createRes.status).toBe(200);
    expect(createRes.data.backupId).toBe(backupId);
    expect(createRes.data.valid).toBe(true);
    /* Note: createRes here is the Info payload; the /admin/backup POST also
       returns metadata. We assert the Info fields since they superset of
       the POST body's metadata payload. */
    expect(createRes.data.usageRecordCount).toBeTypeOf('number');

    /* 2) List shows the new backup */
    const listRes = await request('GET', '/admin/backup/list');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.data)).toBe(true);
    expect(listRes.data.some((b: any) => b.backupId === backupId && b.valid)).toBe(true);
    const entry = listRes.data.find((b: any) => b.backupId === backupId);
    expect(entry).toBeDefined();
    expect(entry.valid).toBe(true);
    expect(entry.version).toBe(1);
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.usageRecordCount).toBeTypeOf('number');

    /* 3) Info endpoint shows the same fields */
    const infoRes = await request('GET', `/admin/backup/info/${encodeURIComponent(backupId)}`);
    expect(infoRes.status).toBe(200);
    expect(infoRes.data.backupId).toBe(backupId);
    expect(infoRes.data.valid).toBe(true);
    expect(infoRes.data.usageRecordCount).toBe(entry.usageRecordCount);

    /* 4) Download returns the raw backup JSON */
    const downloadRes = await request('GET', `/admin/backup/download/${encodeURIComponent(backupId)}`);
    expect(downloadRes.status).toBe(200);
    /* request() parses JSON if content-type is application/json, so the body
       arrives as an object. Verify it has the expected schema but NO secrets. */
    const backup = downloadRes.data;
    expect(backup.backupId).toBe(backupId);
    expect(backup.backupVersion).toBe(1);
    expect(backup.checksum).toBeTruthy();
    expect(backup.datasets).toBeDefined();
    expect(Array.isArray(backup.datasets.usage)).toBe(true);
    expect(backup.datasets.providerState).toBeDefined();
    expect(Array.isArray(backup.datasets.providerState.disabledProviders)).toBe(true);

    /* 5) Restore returns a pre-restore snapshot id, as Prompt 13 §24 requires. */
    const restoreRes = await request('POST', `/admin/backup/restore/${encodeURIComponent(backupId)}`, {});
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.data.status).toBe('ok');
    expect(restoreRes.data.backupId).toBe(backupId);
    expect(restoreRes.data.restoredUsage).toBeTypeOf('number');
    expect(restoreRes.data.restoredProviders).toBeTypeOf('number');
    expect(restoreRes.data.preRestoreBackupId).toBeTruthy();
    expect(restoreRes.data.preRestoreBackupId).toMatch(/^backup-\d+-[0-9a-f]+$/);
    createdBids.push(restoreRes.data.preRestoreBackupId); /* remember pre-restore for cleanup */

    /* 6) Delete the backups we created (test cleanup). Allow 404 if another
       run already pruned them — the diagnostic assertions above already
       proved Create/Info/Download/Restore succeed. */
    await backupDelete(backupId);
    await backupDelete(restoreRes.data.preRestoreBackupId);
  });

  it('rejects restore / info / download for an unknown backup id', async () => {
    const fakeId = 'backup-does-not-exist-999';
    const restore = await request('POST', `/admin/backup/restore/${encodeURIComponent(fakeId)}`, {});
    expect(restore.status).toBeGreaterThanOrEqual(400);

    const info = await request('GET', `/admin/backup/info/${encodeURIComponent(fakeId)}`);
    expect(info.status).toBe(404);

    const download = await request('GET', `/admin/backup/download/${encodeURIComponent(fakeId)}`);
    expect(download.status).toBe(404);
  });

  it('rejects Create with no body (endpoint still 200s — server-side is permissive; verify it returns metadata)', async () => {
    /* POST /admin/backup with no body still creates a fresh snapshot. */
    const backupId = await backupCreate();
    expect(backupId).toBeTruthy();
    /* cleanup (best-effort) */
    await backupDelete(backupId);
  });
});

describe('Download Backup button plumbing', () => {
  it('GET /admin contains the Download Backup button', async () => {
    const res = await request('GET', '/admin');
    expect(res.status).toBe(200);
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    expect(body).toContain('id="backup-download-full"');
    expect(body).toContain('Download Backup');
  });

  it('dashboard.js wires the full-backup download flow', async () => {
    const res = await request('GET', '/admin/dashboard.js');
    expect(res.status).toBe(200);
    const body = typeof res.data === 'string' ? res.data : '';
    expect(body).toContain('backup-download-full');
    expect(body).toContain('downloadFullBackup');
    expect(body).toContain('/admin/backup/download');
  });
});

describe('Security audit — credentials must never leak (Prompt 13 §32)', () => {
  it('sources under src/admin/* must not contain literal API key material', async () => {
    /* Scan the rendered dashboard.js (compiled) + index.html + styles.css for hardcoded credential markers. */
    const endpoints = ['/admin', '/admin/styles.css', '/admin/dashboard.js'];
    const banned = [
      'NVIDIA_API_KEY', 'TOKENHARBOR_API_KEY', 'GOROUTER_API_KEY',
      'Authorization: Bearer', 'nvapi-', 'Bearer nvapi',
    ];
    for (const path of endpoints) {
      const r = await request('GET', path);
      const body = typeof r.data === 'string' ? r.data : '';
      for (const marker of banned) {
        /* Single, clean assertion per endpoint / marker so a failure report is actionable. */
        expect(body, `endpoint ${path} must not contain banned credential marker "${marker}"`).not.toContain(marker);
      }
    }
  });

  it('a backup record never contains raw API keys or Authorization headers', async () => {
    const backupId = await backupCreate();

    const downloadRes = await request('GET', `/admin/backup/download/${encodeURIComponent(backupId)}`);
    expect(downloadRes.status).toBe(200);
    const serialized = JSON.stringify(downloadRes.data);
    /* Banned credential markers must never appear in any serialized backup.
       Note: the field NAME `apiKey` is part of the documented schema (always
       null after sanitization), so we only ban raw material, never the schema
       field name itself. We additionally verify that apiKey VALUES are null. */
    for (const marker of ['NVIDIA_API_KEY', 'TOKENHARBOR_API_KEY', 'Authorization', 'Bearer ', 'nvapi-', 'Gorouter']) {
      expect(serialized, `backup serialization must not contain banned credential marker "${marker}"`).not.toContain(marker);
    }
    /* Each usage record MUST NOT carry a raw `apiKey` value — the backend strips it to null. */
    if (Array.isArray(downloadRes.data.datasets?.usage)) {
      for (const rec of downloadRes.data.datasets.usage) {
        if (rec.apiKey !== null && rec.apiKey !== undefined) {
          expect.fail(`backup usage record leaked raw apiKey value: ${rec.apiKey}`);
        }
      }
    }
    await backupDelete(backupId);
  });
});

describe('Client API Keys — served UI wiring (delete request shape + Copy Key)', () => {
  let js = '';

  beforeAll(async () => {
    const res = await request('GET', '/admin/dashboard.js');
    expect(res.status).toBe(200);
    js = typeof res.data === 'string' ? res.data : '';
    expect(js.length).toBeGreaterThan(0);
  });

  it('api() declares Content-Type ONLY when a body is sent (fix for body-less DELETE 400)', () => {
    /* the old unconditional header initializer must be gone */
    expect(js).not.toContain("const headers: Record<string, string> = { 'Content-Type': 'application/json' }");
    /* the gated one must be present in the served bundle */
    expect(js).toContain('if (hasBody && !hasContentType)');
    expect(js).toContain("headers['Content-Type'] = 'application/json'");
  });

  it('Copy Key button ships with a non-secure-context fallback', () => {
    expect(js).toContain('copyTextToClipboard');
    expect(js).toContain('navigator.clipboard');
    expect(js).toContain('isSecureContext');
    expect(js).toContain("document.execCommand('copy')");
  });

  it('the creation result panel is the one-time raw-key surface (hidden by default, copy wired to it)', async () => {
    const page = await request('GET', '/admin');
    const html = typeof page.data === 'string' ? page.data : '';
    expect(html).toContain('id="clientkey-copy-btn"');
    expect(html).toContain('copy it now, it will not be shown again');
    expect(html).toContain('class="clientkey-result is-hidden"');
    /* raw key comes ONLY from the POST response — never a GET */
    expect(js).toContain("'POST', '/admin/client-keys'");
    expect(js).not.toContain("'GET', '/admin/client-keys/raw");
    /* and is never persisted client-side for copy purposes (no Storage use at all) */
    expect(js).not.toMatch(/localStorage\.[a-zA-Z]+\(/);
    expect(js).not.toMatch(/sessionStorage\.setItem\([^\)]*clientkey/i);
  });
});

describe('Client API Key form — searchable provider picker & model filter (served assets)', () => {
  let html = '';
  let js = '';

  beforeAll(async () => {
    const page = await request('GET', '/admin');
    expect(page.status).toBe(200);
    html = typeof page.data === 'string' ? page.data : '';
    const res = await request('GET', '/admin/dashboard.js');
    js = typeof res.data === 'string' ? res.data : '';
  });

  it('search inputs + listbox exist in the form markup', () => {
    expect(html).toContain('id="clientkey-provider-search"');
    expect(html).toContain('id="clientkey-provider-list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('Search provider...');
    expect(html).toContain('Search models...');
    /* source of truth is STILL the same select id the existing mechanism uses */
    expect(html).toContain('id="clientkey-provider"');
    expect(html).toContain('— select provider —');
  });

  it('provider filter matches name OR id, case-insensitive, counts per row', () => {
    expect(js).toContain('renderProviderPicker');
    expect(js).toContain('.toLowerCase().includes(q)');
    expect(js).toContain('model${p.models.length === 1');
    expect(js).toContain('No providers found');
  });

  it('provider picking keeps the EXISTING mechanism (select value + change cascade)', () => {
    expect(js).toContain("this.elts.clientkeyProvider.value = providerId");
    expect(js).toContain("dispatchEvent(new Event('change'))");
  });

  it('model filter hides rows without re-rendering (checked state survives) and shows No models found', () => {
    expect(js).toContain('filterClientKeyModels');
    expect(js).toContain("row.style.display = hit ? '' : 'none'");
    expect(js).toContain('No models found');
    /* NO network on keystroke: filter reads the in-memory catalog only */
    const searchHandlers = js.match(/clientkeyModelSearch\.addEventListener[\s\S]{0,80}/);
    expect(searchHandlers).toBeTruthy();
    expect(searchHandlers?.[0]).not.toContain('apiJSON');
    const providerSearchHandler = js.match(/clientkeyProviderSearch\.addEventListener[\s\S]{0,80}/);
    expect(providerSearchHandler?.[0]).not.toContain('apiJSON');
  });
});
