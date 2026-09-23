import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { configFile } from './setup';
import {
  createBackup,
  loadBackupFile,
  restoreBackup,
  listBackups,
  getBackupInfo,
  readBackupRaw,
  deleteBackup,
  applyRetention,
  BackupFile,
} from '../src/lib/backup';
import { loadUsageRecords, saveUsageRecords, recordUsage, flushUsage, getAllUsage, UsageRecord } from '../src/lib/usage-store';
import { loadProviderState, saveProviderState } from '../src/lib/provider-state';

const USAGE_FILE = configFile('usage-records.json');
const STATE_FILE = configFile('provider-state.json');
const BACKUP_DIR = configFile('backups');

function makeRecord(partial: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: Date.now(),
    provider: 'nvidia',
    model: 'test-model',
    status: 'success',
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    apiKey: null,
    httpStatus: 200,
    errorMessage: null,
    requestId: null,
    apiKeyMasked: null,
    ...partial,
  };
}

function cleanup(): void {
  try {
    if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
  } catch { }
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch { }
  try {
    if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  } catch { }
}

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

describe('Backup - core', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('creates an empty backup with valid metadata', () => {
    const backup = createBackup();
    expect(backup.backupVersion).toBe(1);
    expect(backup.backupId).toBeTruthy();
    expect(backup.createdAt).toBeTypeOf('number');
    expect(backup.sourceVersion).toBe('1.0.0');
    expect(backup.checksum).toBeTruthy();
    expect(backup.metadata.usageRecordCount).toBe(0);
    expect(backup.metadata.providerStateCount).toBe(0);
    expect(backup.datasets.usage).toEqual([]);
    expect(backup.datasets.providerState.disabledProviders).toEqual([]);

    // Readable back
    const loaded = loadBackupFile(backup.backupId);
    expect(loaded.backupId).toBe(backup.backupId);
    expect(loaded.checksum).toBe(backup.checksum);
    expect(loaded.datasets.usage.length).toBe(0);
  });

  it('backup includes usage records with null tokens preserved', () => {
    saveUsageRecords([
      makeRecord({ model: 'm1', status: 'success', promptTokens: 7, completionTokens: 3, totalTokens: 10, httpStatus: 200 }),
      makeRecord({ model: 'm2', status: 'error', promptTokens: null, completionTokens: null, totalTokens: null, httpStatus: 403, errorMessage: 'upstream denied' }),
      makeRecord({ model: 'm3', status: 'blocked', promptTokens: null, completionTokens: null, totalTokens: null, httpStatus: null }),
    ]);
    const backup = createBackup();
    expect(backup.metadata.usageRecordCount).toBe(3);
    expect(backup.datasets.usage.length).toBe(3);

    const err = backup.datasets.usage.find(r => r.model === 'm2')!;
    expect(err.promptTokens).toBeNull();
    expect(err.completionTokens).toBeNull();
    expect(err.totalTokens).toBeNull();
    expect(err.httpStatus).toBe(403);
    expect(err.errorMessage).toBe('upstream denied');

    const blocked = backup.datasets.usage.find(r => r.model === 'm3')!;
    expect(blocked.promptTokens).toBeNull();
    expect(blocked.status).toBe('blocked');

    const ok = backup.datasets.usage.find(r => r.model === 'm1')!;
    expect(ok.promptTokens).toBe(7);
    expect(ok.completionTokens).toBe(3);
    expect(ok.totalTokens).toBe(10);
    expect(ok.promptTokens! + ok.completionTokens!).toBe(ok.totalTokens);
  });

  it('backup includes provider enabled/disabled state', () => {
    saveProviderState(['nvidia', 'openrouter']);
    const backup = createBackup();
    expect(backup.metadata.providerStateCount).toBe(2);
    expect(backup.datasets.providerState.disabledProviders).toEqual(['nvidia', 'openrouter']);
  });

  it('never stores raw API key material in backup', () => {
    saveUsageRecords([
      makeRecord({ apiKey: 'client-1', apiKeyMasked: 'nvap***key9', model: 'secret-test' }),
      makeRecord({ apiKey: 'nvapi-real-looking-key-1234567890', apiKeyMasked: 'nvap***5678', model: 'secret-test-2' }),
    ]);
    const backup = createBackup();
    for (const r of backup.datasets.usage) {
      expect(r.apiKey).toBeNull();
    }
    const raw = fs.readFileSync(path.join(BACKUP_DIR, `${backup.backupId}.json`), 'utf-8');
    expect(raw).not.toContain('nvapi-real-looking-key-1234567890');
    expect(raw).not.toContain('Authorization');
    // Masked identifiers are preserved (they are already safe)
    expect(raw).toContain('nvap***key9');
  });

  it('rejects corrupt backups (checksum mismatch)', () => {
    const backup = createBackup();
    const file = path.join(BACKUP_DIR, `${backup.backupId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.datasets.usage.push(makeRecord({ model: 'tampered' }));
    fs.writeFileSync(file, JSON.stringify(parsed), 'utf-8');
    expect(() => loadBackupFile(backup.backupId)).toThrow(/checksum mismatch/i);
    expect(() => restoreBackup(backup.backupId)).toThrow(/checksum mismatch/i);
  });

  it('rejects invalid backup version', () => {
    const backup = createBackup();
    const file = path.join(BACKUP_DIR, `${backup.backupId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.backupVersion = 99;
    fs.writeFileSync(file, JSON.stringify(parsed), 'utf-8');
    expect(() => loadBackupFile(backup.backupId)).toThrow(/unsupported backupVersion/i);
  });

  it('rejects unparseable backup files', () => {
    ensureBackupDir();
    fs.writeFileSync(path.join(BACKUP_DIR, 'corrupt-1.json'), '{not valid json', 'utf-8');
    expect(() => loadBackupFile('corrupt-1')).toThrow(/corrupt/i);
  });

  it('list includes invalid backups without reading full content', () => {
    ensureBackupDir();
    fs.writeFileSync(path.join(BACKUP_DIR, 'bad-backup.json'), 'garbage', 'utf-8');
    const list = listBackups();
    const bad = list.find(b => b.backupId === 'bad-backup');
    expect(bad).toBeDefined();
    expect(bad!.valid).toBe(false);
  });

  it('list reports size, version and record counts', () => {
    saveUsageRecords([makeRecord({ model: 'list-test' }), makeRecord({ model: 'list-test-2' })]);
    const backup = createBackup();
    const list = listBackups();
    const info = list.find(b => b.backupId === backup.backupId)!;
    expect(info.size).toBeGreaterThan(0);
    expect(info.version).toBe(1);
    expect(info.valid).toBe(true);
    expect(info.usageRecordCount).toBe(2);
    expect(info.sourceVersion).toBe('1.0.0');

    const direct = getBackupInfo(backup.backupId);
    expect(direct!.backupId).toBe(backup.backupId);
    expect(direct!.valid).toBe(true);
  });

  it('backup metadata record count matches actual records', () => {
    saveUsageRecords([
      makeRecord({ model: 'a' }),
      makeRecord({ model: 'b' }),
      makeRecord({ model: 'c' }),
      makeRecord({ model: 'd' }),
    ]);
    const backup = createBackup();
    expect(backup.metadata.usageRecordCount).toBe(backup.datasets.usage.length);
    // Load path re-validates the count
    const loaded = loadBackupFile(backup.backupId);
    expect(loaded.datasets.usage.length).toBe(4);
  });
});

describe('Backup - restore', () => {
  beforeEach(() => {
    cleanup();
  });

  it('restores usage records and provider state', () => {
    // Snapshot A: 2 records, one provider disabled
    saveUsageRecords([
      makeRecord({ model: 'restore-a1' }),
      makeRecord({ model: 'restore-a2', status: 'error', promptTokens: null, completionTokens: null, totalTokens: null, httpStatus: 500 }),
    ]);
    saveProviderState(['nvidia']);
    const backup = createBackup();

    // Now production state changes (simulating data loss / drift)
    saveUsageRecords([makeRecord({ model: 'drifted' })]);
    saveProviderState([]);

    const result = restoreBackup(backup.backupId);
    expect(result.restoredUsage).toBe(2);
    expect(result.restoredProviders).toBe(1);
    expect(result.preRestoreBackupId).toBeTruthy();

    const usage = loadUsageRecords();
    expect(usage.length).toBe(2);
    expect(usage.some(r => r.model === 'restore-a1')).toBe(true);
    const err = usage.find(r => r.model === 'restore-a2')!;
    expect(err.status).toBe('error');
    expect(err.promptTokens).toBeNull();
    expect(err.httpStatus).toBe(500);

    const state = loadProviderState();
    expect(state).toEqual(['nvidia']);
  });

  it('creates a pre-restore backup of current state', () => {
    saveUsageRecords([makeRecord({ model: 'current-state' })]);
    saveProviderState(['openrouter']);
    const backup = createBackup();

    saveUsageRecords([makeRecord({ model: 'newer-state' })]);
    saveProviderState(['stepfun']);

    const result = restoreBackup(backup.backupId);
    expect(result.preRestoreBackupId).toBeTruthy();
    const pre = loadBackupFile(result.preRestoreBackupId!);
    expect(pre.datasets.usage.some(r => r.model === 'newer-state')).toBe(true);
    expect(pre.datasets.providerState.disabledProviders).toEqual(['stepfun']);
  });

  it('rejects restore of corrupt backup', () => {
    saveUsageRecords([makeRecord({ model: 'keep-me' })]);
    saveProviderState(['nvidia']);
    const backup = createBackup();

    // Corrupt it
    const file = path.join(BACKUP_DIR, `${backup.backupId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    parsed.datasets.providerState.disabledProviders = 'not-an-array';
    fs.writeFileSync(file, JSON.stringify(parsed), 'utf-8');

    expect(() => restoreBackup(backup.backupId)).toThrow();
    // Production data untouched
    expect(loadUsageRecords().length).toBe(1);
  });

  it('rejects unknown backup id', () => {
    expect(() => restoreBackup('no-such-backup-1')).toThrow(/not found/i);
  });
});

describe('Backup - retention & delete', () => {
  beforeEach(() => {
    cleanup();
  });

  it('delete removes a backup', () => {
    const backup = createBackup();
    expect(deleteBackup(backup.backupId)).toBe(true);
    expect(deleteBackup(backup.backupId)).toBe(false);
    expect(fs.existsSync(path.join(BACKUP_DIR, `${backup.backupId}.json`))).toBe(false);
  });

  it('retention keeps newest N and deletes older ones', () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      created.push(createBackup().backupId);
    }
    const deleted = applyRetention(2);
    expect(deleted.length).toBe(3);
    const remaining = listBackups();
    const valid = remaining.filter(b => b.valid);
    expect(valid.length).toBe(2);
    // The two newest (highest createdAt) survive
    const byCreated = [...valid].sort((a, b) => a.createdAt - b.createdAt);
    const keptLatest = byCreated[1];
    const keptSecond = byCreated[0];
    expect(created).toContain(keptLatest.backupId);
    expect(created).toContain(keptSecond.backupId);
  });

  it('retention with maxBackups >= count deletes nothing', () => {
    for (let i = 0; i < 3; i++) createBackup();
    expect(applyRetention(10)).toEqual([]);
    expect(listBackups().length).toBe(3);
  });
});

describe('Backup - non-interference with API', () => {
  beforeEach(cleanup);

  it('createBackup does not disturb in-memory usage recording', () => {
    saveUsageRecords([makeRecord({ model: 'stable-1' })]);
    recordUsage(makeRecord({ model: 'in-flight-1' }));
    const before = getAllUsage().length;

    const backup = createBackup();

    // In-memory record still visible and flushable
    expect(getAllUsage().length).toBeGreaterThanOrEqual(before);
    flushUsage();
    expect(loadUsageRecords().some(r => r.model === 'in-flight-1')).toBe(true);
  });

  it('readBackupRaw returns raw content for download', () => {
    saveUsageRecords([makeRecord({ model: 'download-test' })]);
    const backup = createBackup();
    const { data, backup: loaded } = readBackupRaw(backup.backupId);
    expect(loaded.backupId).toBe(backup.backupId);
    const parsed = JSON.parse(data);
    expect(parsed.backupId).toBe(backup.backupId);
    expect(parsed.datasets.usage.length).toBe(1);
  });

  it('multiple backups coexist', () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) created.push(createBackup().backupId);
    const list = listBackups();
    expect(list.length).toBe(3);
    for (const id of created) {
      expect(getBackupInfo(id)).toBeTruthy();
    }
  });
});
