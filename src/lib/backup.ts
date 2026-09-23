import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadUsageRecords, saveUsageRecords, UsageRecord } from './usage-store';
import { loadProviderState, saveProviderState } from './provider-state';
import { DATA_DIR } from './data-dir';

const BACKUP_VERSION = 1;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');

export interface BackupDataset {
  usage: UsageRecord[];
  providerState: { disabledProviders: string[] };
}

export interface BackupMetadata {
  backupId: string;
  createdAt: number;
  sourceVersion: string;
  usageRecordCount: number;
  providerStateCount: number;
}

export interface BackupFile {
  backupVersion: number;
  backupId: string;
  createdAt: number;
  sourceVersion: string;
  checksum: string;
  metadata: BackupMetadata;
  datasets: BackupDataset;
}

export interface BackupInfo {
  backupId: string;
  createdAt: number;
  size: number;
  usageRecordCount: number;
  providerStateCount: number;
  version: number;
  valid: boolean;
  sourceVersion: string;
}

export interface RestoreResult {
  backupId: string;
  restoredUsage: number;
  restoredProviders: number;
  preRestoreBackupId: string | null;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function backupFileName(id: string): string {
  return `${id}.json`;
}

function backupPath(id: string): string {
  return path.join(BACKUP_DIR, backupFileName(id));
}

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,100}$/.test(id);
}

function checksum(datasets: BackupDataset): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(datasets));
  return hash.digest('hex');
}

export function sanitizeUsageRecords(records: UsageRecord[]): UsageRecord[] {
  // Backups must never contain raw API key/credential material. The usage
  // store may carry a client identifier in `apiKey` (not a credential, but it
  // is not needed for restore) — strip it. Masked identifiers stay.
  return records.map(r => ({
    ...r,
    apiKey: null,
  }));
}

function validateBackup(raw: any): { ok: boolean; error?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'backup is not an object' };
  if (raw.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backupVersion ${raw.backupVersion} (expected ${BACKUP_VERSION})` };
  }
  if (typeof raw.backupId !== 'string' || raw.backupId.length === 0) {
    return { ok: false, error: 'backupId missing' };
  }
  if (typeof raw.createdAt !== 'number' || isNaN(raw.createdAt)) {
    return { ok: false, error: 'createdAt missing or invalid' };
  }
  if (typeof raw.checksum !== 'string' || raw.checksum.length === 0) {
    return { ok: false, error: 'checksum missing' };
  }
  if (!raw.datasets || typeof raw.datasets !== 'object') {
    return { ok: false, error: 'datasets missing' };
  }
  if (!Array.isArray(raw.datasets.usage)) {
    return { ok: false, error: 'datasets.usage is not an array' };
  }
  if (!raw.datasets.providerState || typeof raw.datasets.providerState !== 'object') {
    return { ok: false, error: 'datasets.providerState missing' };
  }
  if (!Array.isArray(raw.datasets.providerState.disabledProviders)) {
    return { ok: false, error: 'datasets.providerState.disabledProviders is not an array' };
  }
  const expected = checksum(raw.datasets);
  if (raw.checksum !== expected) {
    return { ok: false, error: 'checksum mismatch — backup corrupted or tampered' };
  }
  if (raw.metadata) {
    if (raw.metadata.usageRecordCount !== raw.datasets.usage.length) {
      return { ok: false, error: `metadata.usageRecordCount ${raw.metadata.usageRecordCount} does not match actual records ${raw.datasets.usage.length}` };
    }
    if (raw.metadata.providerStateCount !== raw.datasets.providerState.disabledProviders.length) {
      return { ok: false, error: `metadata.providerStateCount ${raw.metadata.providerStateCount} does not match actual disabled providers ${raw.datasets.providerState.disabledProviders.length}` };
    }
  }
  return { ok: true };
}

export function createBackup(): BackupFile {
  ensureDir(BACKUP_DIR);
  const now = Date.now();
  const backupId = `backup-${now}-${crypto.randomBytes(3).toString('hex')}`;
  const usage = sanitizeUsageRecords(loadUsageRecords());
  const disabledProviders = loadProviderState();
  const datasets: BackupDataset = { usage, providerState: { disabledProviders } };
  const backup: BackupFile = {
    backupVersion: BACKUP_VERSION,
    backupId,
    createdAt: now,
    sourceVersion: '1.0.0',
    checksum: checksum(datasets),
    metadata: {
      backupId,
      createdAt: now,
      sourceVersion: '1.0.0',
      usageRecordCount: usage.length,
      providerStateCount: disabledProviders.length,
    },
    datasets,
  };
  const file = backupPath(backupId);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf-8');
  return backup;
}

export function loadBackupFile(backupId: string): BackupFile {
  if (!safeId(backupId)) throw new Error(`Invalid backup ID: ${backupId}`);
  const file = backupPath(backupId);
  if (!fs.existsSync(file)) throw new Error(`Backup not found: ${backupId}`);
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`Backup ${backupId} is corrupt (unparseable)`);
  }
  const validation = validateBackup(parsed);
  if (!validation.ok) throw new Error(`Backup ${backupId} rejected: ${validation.error}`);
  return parsed as BackupFile;
}

export function restoreBackup(backupId: string): RestoreResult {
  const backup = loadBackupFile(backupId);

  // Always snapshot the current state before touching production data so a
  // failed restore never leaves the system without a recoverable state.
  const preBackup = createBackup();
  const preBackupId = preBackup.backupId;

  // Restore provider state first (writes a small file). Then restore usage
  // records atomically via temp-file + rename. A failure in either step throws
  // and leaves the other dataset untouched (both datasets are independently
  // atomic, so no half-restored state is left behind).
  try {
    saveProviderState(backup.datasets.providerState.disabledProviders);
  } catch (e: any) {
    throw new Error(`Restore failed for provider state: ${e.message}`);
  }
  try {
    saveUsageRecords(backup.datasets.usage);
  } catch (e: any) {
    throw new Error(`Restore failed for usage records: ${e.message}`);
  }

  return { backupId, restoredUsage: backup.datasets.usage.length, restoredProviders: backup.datasets.providerState.disabledProviders.length, preRestoreBackupId: preBackupId };
}

export function listBackups(): BackupInfo[] {
  ensureDir(BACKUP_DIR);
  const entries = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
  const result: BackupInfo[] = [];
  for (const entry of entries) {
    const file = path.join(BACKUP_DIR, entry);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const stat = fs.statSync(file);
      let valid = false;
      let usageRecordCount = 0;
      let providerStateCount = 0;
      let version = 0;
      let sourceVersion = '';
      if (parsed && parsed.backupId && parsed.datasets) {
        const v = validateBackup(parsed);
        valid = v.ok;
        usageRecordCount = parsed.datasets?.usage?.length ?? 0;
        providerStateCount = parsed.datasets?.providerState?.disabledProviders?.length ?? 0;
        version = parsed.backupVersion ?? 0;
        sourceVersion = parsed.sourceVersion ?? '';
      }
      result.push({
        backupId: parsed?.backupId ?? entry.replace(/\.json$/, ''),
        createdAt: parsed?.createdAt ?? stat.mtimeMs,
        size: stat.size,
        usageRecordCount,
        providerStateCount,
        version,
        valid,
        sourceVersion,
      });
    } catch {
      // Corrupt/unreadable file: still listed so admins can see it, marked invalid.
      const stat = fs.statSync(file);
      result.push({
        backupId: entry.replace(/\.json$/, ''),
        createdAt: stat.mtimeMs,
        size: stat.size,
        usageRecordCount: 0,
        providerStateCount: 0,
        version: 0,
        valid: false,
        sourceVersion: '',
      });
    }
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

export function getBackupInfo(backupId: string): BackupInfo | null {
  if (!safeId(backupId)) return null;
  const file = backupPath(backupId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const stat = fs.statSync(file);
    const v = validateBackup(parsed);
    return {
      backupId,
      createdAt: parsed?.createdAt ?? stat.mtimeMs,
      size: stat.size,
      usageRecordCount: parsed?.datasets?.usage?.length ?? 0,
      providerStateCount: parsed?.datasets?.providerState?.disabledProviders?.length ?? 0,
      version: parsed?.backupVersion ?? 0,
      valid: v.ok,
      sourceVersion: parsed?.sourceVersion ?? '',
    };
  } catch {
    return null;
  }
}

export function readBackupRaw(backupId: string): { data: string; backup: BackupFile } {
  const backup = loadBackupFile(backupId);
  return { data: JSON.stringify(backup, null, 2), backup };
}

export function deleteBackup(backupId: string): boolean {
  if (!safeId(backupId)) return false;
  const file = backupPath(backupId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** Removes old backups beyond the configured retention count (newest kept first). */
export function applyRetention(maxBackups: number): string[] {
  if (!maxBackups || maxBackups < 1) return [];
  const backups = listBackups().filter(b => b.valid);
  if (backups.length <= maxBackups) return [];
  const toDelete = backups.slice(maxBackups);
  const deleted: string[] = [];
  for (const b of toDelete) {
    if (deleteBackup(b.backupId)) deleted.push(b.backupId);
  }
  return deleted;
}

export { BACKUP_DIR, BACKUP_VERSION };
