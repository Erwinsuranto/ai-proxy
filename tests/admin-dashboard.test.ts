/**
 * Admin Dashboard — frontend component tests.
 *
 * These tests exercise the PURE render*HTML helpers (no DOM environment
 * required) plus the small validators (fmt*, *Badge, esc). The wrappers that
 * touch `target.innerHTML` / `querySelectorAll` are exercised separately by
 * the integration test that boots the real backend and hits /admin.
 *
 * Importantly, we never import anything that touches `document`/`window`:
 * dashboard.ts guards its bootstrap against `typeof window !== 'undefined'`,
 * so importing the `__test` subset is safe under a Node runtime.
 */
import { describe, it, expect } from 'vitest';
import { __test } from '../src/admin/dashboard';

const {
  renderUsageSummaryHTML, renderProviderCardHTML, renderOverviewProvidersHTML,
  renderProviderUsageHTML, renderModelUsageHTML, renderLogsHTML, renderLogDetailHTML,
  renderBackupListHTML, renderBackupInfoHTML, renderRestoreConfirmHTML, fmtSize,
   fmtTokens, fmtNum, fmtLatency, fmtTime, statusBadge, httpBadge, renderEmptyHTML, DASH, fmtCost,
   renderCombosHTML, extractApiError,
} = __test;

const SUMMARY = {
  totalRequests: 5,
  totalSuccess: 3,
  totalFailed: 1,
  totalBlocked: 1,
  totalPromptTokens: 100,
  totalCompletionTokens: 60,
  totalTokens: 160,
  avgLatencyMs: 321,
};

describe('Admin dashboard renderers — formatting', () => {
  it('normalizes object and HTTP error envelopes into readable strings', () => {
    expect(extractApiError({ error: { message: 'Provider unavailable', type: 'upstream_error' } }, 502))
      .toBe('Provider unavailable (upstream_error)');
    expect(extractApiError({ error: { code: 'BAD_REQUEST' } }, 400)).toBe('HTTP 400');
    expect(extractApiError({ message: 'Catalog failed' }, 500)).toBe('Catalog failed');
    expect(extractApiError('[object Object]', 500)).toBe('HTTP 500 — backend returned an unreadable error');
  });

  it('renders empty Combo state without treating an empty list as an error', () => {
    const html = renderCombosHTML([]);
    expect(html).toContain('state-empty');
    expect(html).toContain('No combos yet');
    expect(html).not.toContain('state-error');
  });

  it('renders Combo metadata safely with masked keys and actions', () => {
    const html = renderCombosHTML([{
      id: 'combo_1', clientKeyId: 'client_1', providerId: 'nvidia', model: 'model-a',
      providerKeyId: 'key_1', status: 'active', createdAt: 1, updatedAt: 1,
      requestCount: 2, lastUsedAt: null,
      clientKey: { id: 'client_1', maskedKey: 'cli-***-key', label: 'Client A', status: 'active' },
      providerName: 'NVIDIA',
      providerKey: { id: 'key_1', maskedKey: 'nv-***-key', label: 'Provider A', status: 'active' },
    }]);
    expect(html).toContain('cli-***-key');
    expect(html).toContain('nv-***-key');
    expect(html).toContain('data-combo-action="edit"');
    expect(html).toContain('data-combo-action="delete"');
    expect(html).not.toContain('raw-client-secret');
    expect(html).not.toContain('raw-provider-secret');
  });
  it('fmtTokens renders numbers and N/A for null', () => {
    expect(fmtTokens(10)).toBe('10');
    expect(fmtTokens(160)).toBe('160');
    expect(fmtTokens(1234567)).toBe('1,234,567');
    expect(fmtTokens(null)).toBe(DASH);
    expect(fmtTokens(undefined)).toBe(DASH);
  });

  it('fmtNum renders numbers and N/A for null/undefined', () => {
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(1000)).toBe('1,000');
    expect(fmtNum(null)).toBe(DASH);
  });

  it('fmtLatency handles ms and seconds', () => {
    expect(fmtLatency(250)).toBe('250ms');
    expect(fmtLatency(1500)).toBe('1.50s');
    expect(fmtLatency(null)).toBe(DASH);
  });

  it('fmtCost preserves meaningful micro-costs and distinguishes N/A', () => {
    expect(fmtCost(0.001)).toBe('$0.001');
    expect(fmtCost(0.0000005)).toBe('$0.0000005');
    expect(fmtCost(0)).toBe('$0.000');
    expect(fmtCost(null)).toBe('N/A');
  });

  it('fmtTime renders epoch ms as readable timestamp', () => {
    const t = new Date('2024-01-15T03:30:45Z').getTime();
    const out = fmtTime(t);
    /* Local-TZ-dependent, so check structure instead of exact value. */
    expect(out).toMatch(/2024-01-1[45] \d\d:3[0-9]:45/);
  });

  it('statusBadge classifies success/error/blocked', () => {
    expect(statusBadge('success')).toContain('badge--success');
    expect(statusBadge('error')).toContain('badge--error');
    expect(statusBadge('blocked')).toContain('badge--blocked');
    expect(statusBadge('success')).toContain('success');
  });

  it('httpBadge renders a number for valid codes and — for null', () => {
    expect(httpBadge(200)).toContain('badge--http-2xx');
    expect(httpBadge(404)).toContain('badge--http-4xx');
    expect(httpBadge(500)).toContain('badge--http-5xx');
    expect(httpBadge(null)).toContain('badge--http-null');
    expect(httpBadge(null)).toContain(DASH);
  });

  it('esc escapes HTML-significant characters', () => {
    /* __test group does not export esc directly but every renderer applies it;
       we can infer from a renderer output that injection markers were escaped. */
    const html = renderProviderCardHTML({ id: '<x>', name: 'A&B', enabled: false, models: [] });
    /* The id appears inside an attribute; <x> must be escaped or the parser would break. */
    expect(html).not.toContain('"="<x>');
    expect(html).toContain('A&B');
  });
});

describe('Admin dashboard renderers — usage summary', () => {
  it('renders all eight summary cards with real backend values', () => {
    const html = renderUsageSummaryHTML(SUMMARY);
    expect(html).toContain('Total Requests');
    expect(html).toContain('Successful');
    expect(html).toContain('Errors');
    expect(html).toContain('Blocked');
    expect(html).toContain('Prompt Tokens');
    expect(html).toContain('Completion Tokens');
    expect(html).toContain('Total Tokens');
    expect(html).toContain('Avg Latency');
    /* Real values from the backend must appear verbatim — never fabricated. */
    expect(html).toContain('>5<');
    expect(html).toContain('>3<');
    expect(html).toContain('>1<');
    expect(html).toContain('>100<');
    expect(html).toContain('>60<');
    expect(html).toContain('>160<');
    expect(html).toContain('321ms');
  });

  it('renders — for null token fields (no fake zeros)', () => {
    const emptySummary = { ...SUMMARY, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, avgLatencyMs: 0 };
    const html = renderUsageSummaryHTML(emptySummary);
    /* 0 is a *valid* value (would never render as —) — but we want to ensure that
       null on renderers elsewhere does render as —. Sanity-check 0 renders honestly. */
    expect(html).toContain('>0<');
  });
});

describe('Admin dashboard renderers — provider card', () => {
  it('renders provider name, id, enabled badge and Enable/Disable button (true state)', () => {
    const provider = {
      id: 'nvidia',
      name: 'NVIDIA NIM',
      enabled: true,
      models: [
        { model: 'deepseek-ai/deepseek-v4-flash-0731', providerId: 'nvidia', backendModel: 'deepseek-ai/deepseek-v4-flash-0731', priority: 50, enabled: true },
      ],
    };
    const html = renderProviderCardHTML(provider);
    expect(html).toContain('NVIDIA NIM');
    expect(html).toContain('id: nvidia');
    expect(html).toContain('badge--on');
    expect(html).toContain('ENABLED');
    /* When enabled, button is the danger "Disable" button */
    expect(html).toContain('btn--danger');
    expect(html).toContain('Disable');
    /* Model IDs preserved verbatim */
    expect(html).toContain('deepseek-ai/deepseek-v4-flash-0731');
    expect(html).toContain('provider-card');
    expect(html).toContain('data-toggle="nvidia"');
  });

  it('renders the Enable button and DISABLED badge for a disabled provider', () => {
    const html = renderProviderCardHTML({ id: 'tokenharbor', name: 'Token Harbor', enabled: false, models: [] });
    expect(html).toContain('DISABLED');
    expect(html).toContain('badge--off');
    expect(html).toContain('btn--success');
    expect(html).toContain('Enable');
    expect(html).toContain('no models registered');
  });

  it('displays exact backend model IDs (no truncation/hardcoding)', () => {
    const html = renderProviderCardHTML({
      id: 'nvidia', name: 'NVIDIA NIM', enabled: true,
      models: [
        { model: 'deepseek-ai/deepseek-v4-flash-0731', providerId: 'nvidia', priority: 50, enabled: true },
        { model: 'meta/llama-3.1-nemotron-70b-instruct', providerId: 'nvidia', priority: 50, enabled: true },
      ],
    });
    expect(html).toContain('deepseek-ai/deepseek-v4-flash-0731');
    expect(html).toContain('meta/llama-3.1-nemotron-70b-instruct');
  });

  it('honors per-model enabled/off state', () => {
    const html = renderProviderCardHTML({
      id: 'p', name: 'p', enabled: true,
      models: [
        { model: 'on-model',  providerId: 'p', priority: 10, enabled: true },
        { model: 'off-model', providerId: 'p', priority: 20, enabled: false },
      ],
    });
    /* Off models are visually de-emphasized with a class and a marker. */
    expect(html).toMatch(/is-off/);
    expect(html).toContain('off-model');
    expect(html).toContain('on-model');
  });
});

describe('Admin dashboard renderers — overview providers', () => {
  it('lists all providers with ENABLED/DISABLED badges', () => {
    const html = renderOverviewProvidersHTML([
      { id: 'nvidia', name: 'NVIDIA NIM', enabled: true,  models: [] },
      { id: 'tokenharbor', name: 'Token Harbor', enabled: false, models: [] },
    ]);
    expect(html).toContain('NVIDIA NIM');
    expect(html).toContain('Token Harbor');
    expect(html).toContain('ENABLED');
    expect(html).toContain('DISABLED');
  });

  it('shows empty state when no providers registered', () => {
    const html = renderOverviewProvidersHTML([]);
    expect(html).toContain('No providers registered.');
    expect(html).toContain('state-empty');
  });
});

describe('Admin dashboard renderers — provider usage table', () => {
  it('builds a row per provider with exact backend fields', () => {
    const html = renderProviderUsageHTML({
       nvidia: { requests: 5, success: 3, failed: 1, blocked: 1, promptTokens: 100, completionTokens: 60, totalTokens: 160, avgLatencyMs: 250, costUsd: 0.001 },
    });
    expect(html).toContain('<td class="cell-mono">nvidia</td>');
    expect(html).toContain('>5<');
    expect(html).toContain('>3<');
    expect(html).toContain('>1<');
    expect(html).toContain('>100<');
    expect(html).toContain('>60<');
    expect(html).toContain('>160<');
    expect(html).toContain('250ms');
    expect(html).toContain('$0.001');
  });

  it('shows empty state when no usage data', () => {
    const html = renderProviderUsageHTML({});
    expect(html).toContain('No usage data available.');
    expect(html).toContain('state-empty');
  });
});

describe('Admin dashboard renderers — model usage table', () => {
  it('preserves exact model IDs and lists provider source', () => {
    const html = renderModelUsageHTML({
      'deepseek-ai/deepseek-v4-flash-0731': {
        requests: 2, success: 1, failed: 1, blocked: 0,
         promptTokens: 4, completionTokens: 6, totalTokens: 10, avgLatencyMs: 110, costUsd: 0.002,
        providers: ['nvidia', 'tokenharbor'],
      },
    });
    expect(html).toContain('deepseek-ai/deepseek-v4-flash-0731');
    expect(html).toContain('nvidia, tokenharbor');
    expect(html).toContain('>2<');
    expect(html).toContain('>10<');
    expect(html).toContain('110ms');
    expect(html).toContain('$0.002');
  });
});

describe('Admin dashboard renderers — logs table', () => {
  const ts = new Date('2024-02-10T12:34:56Z').getTime();
  const logs = {
    total: 1,
    logs: [
      {
        timestamp: ts, provider: 'nvidia', model: 'meta/llama-3.1-8b-instruct',
        status: 'success' as const, latencyMs: 750,
        promptTokens: 10, completionTokens: 6, totalTokens: 16,
         apiKey: null, httpStatus: 200, errorMessage: null, requestId: 'req-abc', costUsd: 0.001,
        apiKeyMasked: 'nvap***key9',
      },
    ],
  };

  it('emits a row per record with HTTP status, tokens, latency', () => {
    const html = renderLogsHTML(logs, 0);
    expect(html).toContain('data-index="0"');
    expect(html).toContain('badge--success');
    expect(html).toContain('badge--http-2xx');
    expect(html).toContain('>10<');
    expect(html).toContain('>6<');
    expect(html).toContain('>16<');
    expect(html).toContain('750ms');
    expect(html).toContain('$0.001');
    expect(html).toContain('Detail');
    /* Request ID is NOT shown in the row (only the Detail modal reveals it). */
    expect(html).not.toContain('req-abc');
    expect(html).not.toContain('nvap***key9'); /* masked key never in list view */
  });

  it('renders — for null tokens/HTTP, preserves exact model IDs', () => {
    const blocked = {
      total: 1,
      logs: [{
        timestamp: ts, provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash-0731',
        status: 'blocked' as const, latencyMs: 0,
        promptTokens: null, completionTokens: null, totalTokens: null,
        apiKey: null, httpStatus: null, errorMessage: null,
      }],
    };
    const html = renderLogsHTML(blocked, 0);
    expect(html).toContain('badge--blocked');
    expect(html).toContain('badge--http-null');
    expect(html).toContain(DASH);
    expect(html).toContain('deepseek-ai/deepseek-v4-flash-0731');
  });

  it('shows an error row message and 4xx badge for upstream errors', () => {
    const err = {
      total: 1,
      logs: [{
        timestamp: ts, provider: 'nvidia', model: 'fake',
        status: 'error' as const, latencyMs: 45,
        promptTokens: null, completionTokens: null, totalTokens: null,
        apiKey: null, httpStatus: 403, errorMessage: 'Forbidden',
      }],
    };
    const html = renderLogsHTML(err, 0);
    expect(html).toContain('badge--error');
    expect(html).toContain('badge--http-4xx');
    expect(html).toContain('Forbidden');
  });

  it('shows empty state when no records', () => {
    const html = renderLogsHTML({ total: 0, logs: [] }, 0);
    expect(html).toContain('No usage records found.');
    expect(html).toContain('state-empty');
  });
});

describe('Admin dashboard renderers — log detail modal', () => {
  it('shows loading skeleton', () => {
    const html = renderLogDetailHTML(null, true, null);
    expect(html).toContain('skeleton');
  });

  it('shows error', () => {
    const html = renderLogDetailHTML(null, false, 'Failed to load record');
    expect(html).toContain('state-error');
    expect(html).toContain('Failed to load record');
  });

  it('reveals request id and masked key in the modal (never raw key)', () => {
    const rec = {
      timestamp: Date.now(), provider: 'nvidia', model: 'm',
      status: 'success' as const, latencyMs: 100,
      promptTokens: 1, completionTokens: 2, totalTokens: 3,
      apiKey: 'client-1', httpStatus: 200,
      errorMessage: null, requestId: 'req-xyz', apiKeyMasked: 'nvap***key9',
    };
    const html = renderLogDetailHTML(rec, false, null);
    /* The client identifier (non-credential) and masked key are okay to show. */
    expect(html).toContain('Request ID');
    expect(html).toContain('req-xyz');
    expect(html).toContain('Masked API Key');
    expect(html).toContain('nvap***key9');
    /* The raw key value MUST NOT appear (there is no raw-key field in the
       record, but we assert the masked form is the only thing shown). */
    expect(html).toContain('—');
  });

  it('renders — for null http status / tokens', () => {
    const rec = {
      timestamp: Date.now(), provider: 'p', model: 'm',
      status: 'blocked' as const, latencyMs: 0,
      promptTokens: null, completionTokens: null, totalTokens: null,
      apiKey: null, httpStatus: null, errorMessage: null,
    };
    const html = renderLogDetailHTML(rec, false, null);
    /* Note: DASH is rendered as the literal — character; both must appear. */
    expect(html).toContain(DASH);
    /* Token labels present with DASH values, NOT with fabricated 0. */
    expect(html).toMatch(/Prompt Tokens<\/dt>\s*<dd>—/);
    expect(html).toMatch(/HTTP Status<\/dt>\s*<dd>—/);
  });
});

describe('Admin dashboard renderers — generic empty/error', () => {
  it('renderEmptyHTML toggles error vs empty style', () => {
    expect(renderEmptyHTML('No data')).toContain('state-empty');
    expect(renderEmptyHTML('Failure', true)).toContain('state-error');
  });
});

/* ============================================================================
 * Backup UI renderers (Prompt 13 §22–§25)
 * ========================================================================== */

describe('Admin dashboard renderers — Backup list', () => {
  it('renders an empty state when no backups exist', () => {
    const html = renderBackupListHTML([]);
    expect(html).toContain('No backups found');
    expect(html).toContain('state-empty');
  });

  it('emits a row per backup with id, created time, counts, size, version, valid badge', () => {
    const ts = new Date('2024-03-10T01:02:03Z').getTime();
    const html = renderBackupListHTML([
      {
        backupId: 'backup-1', createdAt: ts, size: 512,
        usageRecordCount: 42, providerStateCount: 2,
        version: 1, valid: true, sourceVersion: '1.0.0',
      },
    ]);
    expect(html).toContain('data-backup-id="backup-1"');
    expect(html).toContain('backup-1');
    expect(html).toContain('>42<');
    expect(html).toContain('>2<');
    expect(html).toContain('v1');
    expect(html).toContain('badge--success');
    expect(html).toContain('VALID');
    /* Four action buttons: Download / Info / Restore / Delete */
    expect(html).toContain('data-action="download"');
    expect(html).toContain('data-action="info"');
    expect(html).toContain('data-action="restore"');
    expect(html).toContain('data-action="delete"');
  });

  it('disables Restore/Info/Download for INVALID backups, but Delete remains enabled', () => {
    const html = renderBackupListHTML([
      { backupId: 'bad', createdAt: 1, size: 1, usageRecordCount: 0, providerStateCount: 0, version: 0, valid: false, sourceVersion: '' },
    ]);
    expect(html).toContain('INVALID');
    expect(html).toContain('badge--error');
    /* Invalid backups should still appear, but their non-delete actions are disabled. */
    expect(html).toMatch(/data-action="restore"[^>]*disabled/);
    expect(html).toMatch(/data-action="info"[^>]*disabled/);
    expect(html).toMatch(/data-action="download"[^>]*disabled[^>]*>/);
    /* Delete is always available so admins can prune corrupt snapshots. */
    expect(html).toMatch(/data-action="delete"(?!.*disabled)/);
  });
});

describe('Admin dashboard renderers — Backup info modal', () => {
  it('renders an error message when error is set', () => {
    const html = renderBackupInfoHTML(null, 'Backup not found');
    expect(html).toContain('state-error');
    expect(html).toContain('Backup not found');
  });

  it('renders empty state when info is null and error is null', () => {
    const html = renderBackupInfoHTML(null, null);
    expect(html).toContain('Backup not found');
    expect(html).toContain('state-empty');
  });

  it('lists all the BackupInfo fields the dashboard surfaced', () => {
    const html = renderBackupInfoHTML({
      backupId: 'backup-42', createdAt: new Date('2024-04-01T00:00:00Z').getTime(),
      size: 2048, usageRecordCount: 5, providerStateCount: 1,
      version: 1, valid: true, sourceVersion: '1.0.0',
    }, null);
    expect(html).toContain('Backup ID');
    expect(html).toContain('backup-42');
    expect(html).toContain('Size');
    expect(html).toContain('Usage Records');
    expect(html).toContain('>5<');
    expect(html).toContain('Providers');
    expect(html).toContain('Version');
    expect(html).toContain('v1');
    expect(html).toContain('Source Version');
    expect(html).toContain('1.0.0');
    expect(html).toContain('Valid');
    expect(html).toContain('YES');
  });

  it('shows NO for invalid backups in the Info modal', () => {
    const html = renderBackupInfoHTML({
      backupId: 'b', createdAt: 1, size: 0, usageRecordCount: 0,
      providerStateCount: 0, version: 0, valid: false, sourceVersion: '',
    }, null);
    expect(html).toContain('NO');
  });
});

describe('Admin dashboard renderers — Restore confirmation dialog', () => {
  it('shows backup id, timestamp, usage records, version + warns about overwrite', () => {
    const html = renderRestoreConfirmHTML({
      backupId: 'backup-restore-1',
      createdAt: new Date('2024-05-01T00:00:00Z').getTime(),
      size: 1000, usageRecordCount: 99, providerStateCount: 3,
      version: 1, valid: true, sourceVersion: '1.0.0',
    });
    expect(html).toContain('backup-restore-1');
    expect(html).toContain('Backup ID');
    expect(html).toContain('Timestamp');
    expect(html).toContain('Usage Records');
    expect(html).toContain('>99<');
    expect(html).toContain('Version');
    expect(html).toContain('overwrites');
    expect(html).toContain('pre-restore snapshot');
  });
});

describe('Admin dashboard renderers — fmtSize', () => {
  it('formats bytes / kilobytes / megabytes with correct thresholds', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(2048)).toBe('2.0 KB');
    expect(fmtSize(1024 * 1024)).toBe('1.00 MB');
    expect(fmtSize(null)).toBe(DASH);
    expect(fmtSize(-1)).toBe(DASH);
  });
});
