/* ============================================================================
 * nvidia-api · Full project backup (on-demand ZIP download for admins)
 * ----------------------------------------------------------------------------
 * Builds the downloadable full backup served by GET /admin/backup/download.
 * Unlike the JSON snapshots in backup.ts (usage + provider state only), the
 * full backup bundles every persistent state/config file needed to recover
 * the project — as a streamed ZIP archive with a timestamped filename.
 *
 * SAFETY MODEL (mirrors the existing backup + api-key-store contracts):
 *  - ALLOWLIST ONLY: only the files enumerated in FULL_BACKUP_FILES are ever
 *    added. Anything else on disk (node_modules, .git, dist, logs, cache,
 *    temp files, previous backups, *.zip) can never enter the archive.
 *  - RAW CREDENTIALS ARE NEVER INCLUDED, by design:
 *      * provider-api-keys.json holds raw upstream keys (see the SECURITY
 *        CONTRACT in api-key-store.ts — "must NEVER ... be included in
 *        backups"). Env-provided keys are the canonical source; UI-managed
 *        keys are re-added through the Admin UI after a restore.
 *      * client-api-keys.json holds client key hashes (excluded per the
 *        client-key-store.ts contract). Client keys are re-minted.
 *      * .env / .env.* and codex-seekai.toml (contains a hardcoded token)
 *        are never read.
 *  - Usage records are sanitized (apiKey → null) with the same semantics as
 *    backup.ts before entering the archive.
 *  - Archive entries stream from disk (archiver + createReadStream); the
 *    archive itself is never buffered in memory and no temporary ZIP file is
 *    written to the server.
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Archiver, ZipArchive } from 'archiver';
import { DATA_DIR } from './data-dir';
import { loadUsageRecords, UsageRecord } from './usage-store';
import { sanitizeUsageRecords } from './backup';

export const FULL_BACKUP_VERSION = 1;

/** nvidia-api-backup-YYYY-MM-DD-HH-mm-ss.zip (server local time). */
export const FULL_BACKUP_FILENAME_RE =
  /^nvidia-api-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fullBackupFileName(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `nvidia-api-backup-${stamp}.zip`;
}

/** Project root (works from src/ via tsx and from dist/ when compiled). */
export function projectRootDir(): string {
  return path.resolve(__dirname, '..', '..');
}

export interface FullBackupEntry {
  /** Path inside the ZIP. Always relative, never escapes the archive root. */
  zipPath: string;
  /** Absolute source file on disk (verbatim copy, streamed). */
  absPath?: string;
  /** In-memory payload (generated snapshot/manifest). */
  data?: string;
}

/** Verbatim DATA_DIR state files included when present (raw keys excluded). */
const STATE_FILES = [
  'provider-state.json',
  'combos.json',
  'model-pricing.json',
  'provider-refresh-cooldown-state.json',
] as const;

/** Verbatim project-root files included when present (docs/config only). */
const PROJECT_FILES = [
  'package.json',
  '.env.example',
  'CHANGELOG.md',
  'models.example.json',
] as const;

/** DATA_DIR files that must NEVER enter a backup (raw credentials/snapshots). */
export const FULL_BACKUP_EXCLUDED = [
  'provider-api-keys.json',
  'client-api-keys.json',
  'codex-seekai.toml',
] as const;

function isSafeZipPath(zipPath: string): boolean {
  if (!zipPath || zipPath.length > 200) return false;
  if (zipPath.includes('\\')) return false;
  if (path.isAbsolute(zipPath)) return false;
  const normalized = path.posix.normalize(zipPath);
  if (normalized !== zipPath) return false;
  // No empty, '.' or '..' segments — the archive root can never be escaped.
  if (normalized.split('/').some((p) => p === '' || p === '.' || p === '..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(normalized);
}

/** Sanitized usage snapshot (apiKey → null, same semantics as backup.ts). */
export function buildUsageSnapshot(): { data: string; recordCount: number } {
  let records: UsageRecord[];
  try {
    records = loadUsageRecords();
  } catch {
    records = [];
  }
  const sanitized = sanitizeUsageRecords(records);
  return { data: JSON.stringify(sanitized, null, 2), recordCount: sanitized.length };
}

export interface FullBackupManifest {
  fullBackupVersion: number;
  createdAt: number;
  filename: string;
  sourceVersion: string;
  usageRecordCount: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  excluded: string[];
}

export function buildManifest(opts: {
  filename: string;
  createdAt: number;
  usageRecordCount: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  sourceVersion: string;
}): FullBackupManifest {
  return {
    fullBackupVersion: FULL_BACKUP_VERSION,
    createdAt: opts.createdAt,
    filename: opts.filename,
    sourceVersion: opts.sourceVersion,
    usageRecordCount: opts.usageRecordCount,
    files: opts.files,
    excluded: [
      ...FULL_BACKUP_EXCLUDED,
      'backups/ (previous JSON snapshots)',
      '*.zip (previous archives)',
      '.env / .env.* (secrets live outside backups by design)',
      'node_modules, .git, dist, *.log, cache, temp files',
    ],
  };
}

function sha256File(absPath: string): string | null {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(absPath));
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function packageVersion(projectRoot: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    return typeof raw?.version === 'string' ? raw.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface CollectOptions {
  dataDir?: string;
  projectRoot?: string;
  now?: Date;
}

/**
 * Collects the allowlisted archive entries plus manifest metadata.
 * Missing optional files are skipped; nothing outside the allowlist is
 * ever collected — exclusions hold by construction.
 */
export function collectFullBackupEntries(opts: CollectOptions = {}): {
  filename: string;
  createdAt: number;
  entries: FullBackupEntry[];
  manifest: FullBackupManifest;
} {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const projectRoot = opts.projectRoot ?? projectRootDir();
  const now = opts.now ?? new Date();
  const createdAt = now.getTime();
  const filename = fullBackupFileName(now);

  const entries: FullBackupEntry[] = [];
  const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];

  const addFile = (zipPath: string, absPath: string) => {
    if (!isSafeZipPath(zipPath)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return; // optional file absent — skip
    }
    if (!stat.isFile()) return;
    const digest = sha256File(absPath);
    if (!digest) return;
    entries.push({ zipPath, absPath });
    manifestFiles.push({ path: zipPath, bytes: stat.size, sha256: digest });
  };

  // 1. Persistent state files (DATA_DIR root only — never backups/ or *.zip).
  for (const name of STATE_FILES) {
    addFile(`data/${name}`, path.join(dataDir, name));
  }
  // Model catalogs live in DATA_DIR on this deployment.
  addFile('data/models.json', path.join(dataDir, 'models.json'));
  addFile('data/models.example.json', path.join(dataDir, 'models.example.json'));

  // 2. Project-root docs/config (no secrets by construction).
  for (const name of PROJECT_FILES) {
    addFile(name, path.join(projectRoot, name));
  }

  // 3. Sanitized usage snapshot (never the raw file).
  const usage = buildUsageSnapshot();
  const usageDigest = crypto.createHash('sha256').update(usage.data).digest('hex');
  entries.push({ zipPath: 'data/usage-records.json', data: usage.data });
  manifestFiles.push({
    path: 'data/usage-records.json',
    bytes: Buffer.byteLength(usage.data, 'utf-8'),
    sha256: usageDigest,
  });

  // 4. Manifest (describes exactly what is inside).
  const manifest = buildManifest({
    filename,
    createdAt,
    usageRecordCount: usage.recordCount,
    files: manifestFiles,
    sourceVersion: packageVersion(projectRoot),
  });
  const manifestData = JSON.stringify(manifest, null, 2);
  entries.push({ zipPath: 'manifest.json', data: manifestData });

  return { filename, createdAt, entries, manifest };
}

/** Appends collected entries to an archiver instance (files stream from disk). */
export function appendEntriesToArchive(archive: Archiver, entries: FullBackupEntry[]): void {
  for (const entry of entries) {
    if (!isSafeZipPath(entry.zipPath)) continue;
    if (typeof entry.data === 'string') {
      archive.append(entry.data, { name: entry.zipPath });
    } else if (entry.absPath) {
      archive.file(entry.absPath, { name: entry.zipPath });
    }
  }
}

/** Creates a ZIP archiver with sane defaults for backup streaming. */
export function createFullBackupArchive(): Archiver {
  return new ZipArchive({ zlib: { level: 9 } });
}
