/**
 * Full-project backup download (GET /admin/backup/download).
 *
 * Covers: admin-only access, ZIP validity, allowlisted contents, exclusion of
 * secrets/previous backups/repo clutter, timestamped filename, no server-side
 * leftovers. Serial by suite config (singleFork, fileParallelism: false).
 *
 * Builds on the established harness at tests/setup.ts (spawned server from
 * dist/ against the throwaway DATA_DIR, never live production data).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';
import { startServer, stopServer, configFile, getBaseUrl } from './setup';
import {
  fullBackupFileName,
  FULL_BACKUP_FILENAME_RE,
  FULL_BACKUP_EXCLUDED,
  collectFullBackupEntries,
  buildManifest,
} from '../src/lib/full-backup';
import { saveUsageRecords, UsageRecord } from '../src/lib/usage-store';

const ADMIN_KEY = 'test-full-backup-admin-key-001';
const DATA_DIR = configFile('');
const BACKUP_DIR = configFile('backups');

const RAW_UPSTREAM_DECOY = 'RAW-UPSTREAM-KEY-SHOULD-NEVER-LEAK-9f8e7d6c5b4a';
const CLIENT_HASH_DECOY = 'CLIENT-KEY-HASH-DECOY-abcdef0123456789';
const CLIENT_ID_DECOY = 'SUPER-SECRET-CLIENT-ID-12345';
const CODEX_TOKEN_DECOY = 'CODEX-HARDCODED-TOKEN-DECOY-zz99';

/* ------------------------- tiny ZIP reader (no deps) ------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number; // local header offset
}

/** Parses the central directory; returns entries in archive order. */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65558; i--) {
    if (buf[i] === 0x50 && buf.subarray(i, i + 4).equals(EOCD)) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found — not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    entries.push({ name, method, compressedSize: compSize, offset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extracts one entry by name via the central directory (robust against
 *  data-descriptor local headers produced by streaming writers). */
function extractZipEntry(buf: Buffer, name: string): Buffer {
  const entry = parseCentralDirectory(buf).find((e) => e.name === name);
  if (!entry) throw new Error(`entry not found in ZIP: ${name}`);
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported method ${entry.method} for ${name}`);
}

/* ------------------------------- HTTP helper ------------------------------ */

function rawGet(pathname: string, auth?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, getBaseUrl());
    const headers: Record<string, string> = {};
    if (auth !== undefined) headers['Authorization'] = auth;
    const req = http.request({ method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });
}

/* --------------------------------- fixtures ------------------------------- */

function makeRecord(partial: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: Date.now(),
    provider: 'nvidia',
    model: 'full-backup-probe',
    status: 'success',
    latencyMs: 42,
    promptTokens: 5,
    completionTokens: 3,
    totalTokens: 8,
    apiKey: null,
    httpStatus: 200,
    errorMessage: null,
    requestId: null,
    apiKeyMasked: null,
    ...partial,
  };
}

function writeSeedFiles(): void {
  saveUsageRecords([
    makeRecord({ model: 'seed-model-a', apiKey: CLIENT_ID_DECOY, apiKeyMasked: 'SUPE***2345' }),
    makeRecord({ model: 'seed-model-b' }),
  ]);
  fs.writeFileSync(configFile('provider-state.json'), JSON.stringify(['openrouter']), 'utf-8');
  fs.writeFileSync(configFile('combos.json'), JSON.stringify({ version: 1, combos: [] }), 'utf-8');
  fs.writeFileSync(configFile('model-pricing.json'), JSON.stringify({ version: 1, entries: [] }), 'utf-8');
  fs.writeFileSync(configFile('models.json'), JSON.stringify({ note: 'seed catalog' }), 'utf-8');
  fs.writeFileSync(configFile('provider-refresh-cooldown-state.json'), JSON.stringify({}), 'utf-8');
  // Secret decoys that must NEVER enter the archive:
  fs.writeFileSync(configFile('provider-api-keys.json'), JSON.stringify({
    version: 1,
    providers: { nvidia: [{ id: 'k1', providerId: 'nvidia', maskedKey: 'RAW-***-xyz', status: 'active', createdAt: 1, updatedAt: 1, key: RAW_UPSTREAM_DECOY }] },
  }), 'utf-8');
  fs.writeFileSync(configFile('client-api-keys.json'), JSON.stringify([{
    id: 'c1', maskedKey: 'sk-a***wxyz', keyHash: CLIENT_HASH_DECOY, providerId: 'nvidia',
  }]), 'utf-8');
  fs.writeFileSync(configFile('codex-seekai.toml'), `experimental_bearer_token = "${CODEX_TOKEN_DECOY}"\n`, 'utf-8');
  // Repo-clutter decoys (must never enter the archive):
  fs.mkdirSync(configFile('node_modules/fake-pkg'), { recursive: true });
  fs.writeFileSync(configFile('node_modules/fake-pkg/index.js'), 'x', 'utf-8');
  fs.mkdirSync(configFile('.git/objects'), { recursive: true });
  fs.writeFileSync(configFile('.git/config'), '[core]', 'utf-8');
  fs.writeFileSync(configFile('server.log'), 'log line', 'utf-8');
  fs.writeFileSync(configFile('stale-backup.zip'), 'PK fake', 'utf-8');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, 'backup-old.json'), JSON.stringify({ stale: true }), 'utf-8');
}

function removeSeedFiles(): void {
  for (const f of [
    'usage-records.json', 'provider-state.json', 'combos.json', 'model-pricing.json',
    'models.json', 'provider-refresh-cooldown-state.json', 'provider-api-keys.json',
    'client-api-keys.json', 'codex-seekai.toml', 'server.log', 'stale-backup.zip',
  ]) {
    try { fs.unlinkSync(configFile(f)); } catch { /* ignore */ }
  }
  for (const d of ['node_modules', '.git']) {
    try { fs.rmSync(configFile(d), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(path.join(BACKUP_DIR, 'backup-old.json')); } catch { /* ignore */ }
}

function listBackupsDir(): string[] {
  try { return fs.readdirSync(BACKUP_DIR).sort(); } catch { return []; }
}

/* --------------------------------- lib tests ------------------------------ */

describe('full-backup lib', () => {
  it('produces the required timestamped filename', () => {
    expect(fullBackupFileName(new Date(2026, 8, 10, 22, 57, 11)))
      .toBe('nvidia-api-backup-2026-09-10-22-57-11.zip');
    const now = fullBackupFileName();
    expect(FULL_BACKUP_FILENAME_RE.test(now)).toBe(true);
    expect(FULL_BACKUP_FILENAME_RE.test('nvidia-api-backup-2026-09-10-22-57-11.zip')).toBe(true);
    expect(FULL_BACKUP_FILENAME_RE.test('nvidia-api-backup-2026-09-10.zip')).toBe(false);
    expect(FULL_BACKUP_FILENAME_RE.test('../evil.zip')).toBe(false);
  });

  it('collects only allowlisted files on a fixture dir', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'full-backup-fixture-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'full-backup-proj-'));
    try {
      fs.writeFileSync(path.join(fixture, 'provider-state.json'), '{}');
      fs.writeFileSync(path.join(fixture, 'provider-api-keys.json'), RAW_UPSTREAM_DECOY);
      fs.writeFileSync(path.join(fixture, '.env'), 'SECRET=x');
      fs.mkdirSync(path.join(fixture, 'backups'));
      fs.writeFileSync(path.join(fixture, 'backups', 'old.json'), '{}');
      fs.writeFileSync(path.join(fixture, 'evil.zip'), 'PK');
      fs.writeFileSync(path.join(proj, 'package.json'), '{"version":"9.9.9"}');
      const { filename, entries, manifest } = collectFullBackupEntries({ dataDir: fixture, projectRoot: proj });
      expect(FULL_BACKUP_FILENAME_RE.test(filename)).toBe(true);
      const names = entries.map((e) => e.zipPath);
      expect(names).toContain('data/provider-state.json');
      expect(names).toContain('data/usage-records.json');
      expect(names).toContain('manifest.json');
      expect(names).toContain('package.json');
      for (const n of names) {
        expect(n).not.toContain('..');
        expect(path.isAbsolute(n)).toBe(false);
      }
      const joined = names.join('\n');
      expect(joined).not.toContain('provider-api-keys');
      expect(joined).not.toContain('backups');
      expect(joined).not.toContain('.env');
      expect(joined).not.toContain('.zip');
      expect(manifest.filename).toBe(filename);
      expect(manifest.files.length).toBe(names.length - 1); // minus manifest.json itself
      for (const f of manifest.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(FULL_BACKUP_EXCLUDED).toContain('provider-api-keys.json');
      expect(FULL_BACKUP_EXCLUDED).toContain('client-api-keys.json');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('buildManifest records the exclusion policy', () => {
    const m = buildManifest({ filename: 'nvidia-api-backup-2026-01-01-00-00-00.zip', createdAt: 1, usageRecordCount: 2, files: [], sourceVersion: '1.0.0' });
    expect(m.fullBackupVersion).toBe(1);
    expect(m.excluded.join(' ')).toContain('provider-api-keys.json');
  });
});

/* ------------------------------ endpoint tests ---------------------------- */

describe('GET /admin/backup/download', () => {
  let backupsBefore: string[] = [];

  beforeAll(async () => {
    removeSeedFiles();
    writeSeedFiles();
    backupsBefore = listBackupsDir();
    await startServer({ API_KEY: ADMIN_KEY, NVIDIA_API_KEYS: 'key1,key2' });
  }, 60000);

  afterAll(async () => {
    await stopServer();
    removeSeedFiles();
  });

  it('rejects unauthenticated and wrong-key requests (admin only)', async () => {
    const anon = await rawGet('/admin/backup/download');
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toContain('application/json');
    const wrong = await rawGet('/admin/backup/download', 'Bearer wrong-key');
    expect(wrong.status).toBe(401);
  });

  it('streams a valid ZIP with the timestamped attachment filename', async () => {
    const r = await rawGet('/admin/backup/download', `Bearer ${ADMIN_KEY}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/zip');
    const cd = String(r.headers['content-disposition'] || '');
    expect(cd).toMatch(/^attachment; filename="nvidia-api-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip"$/);
    expect(r.bytes.subarray(0, 4).toString('binary')).toBe('PK\x03\x04');
    const entries = parseCentralDirectory(r.bytes);
    expect(entries.length).toBeGreaterThan(3);
    const names = entries.map((e) => e.name);
    // important data/config present
    for (const want of [
      'data/usage-records.json', 'data/provider-state.json', 'data/combos.json',
      'data/model-pricing.json', 'data/provider-refresh-cooldown-state.json',
      'data/models.json', 'package.json', '.env.example', 'manifest.json',
    ]) {
      expect(names).toContain(want);
    }
    // secrets / clutter excluded (.env.example is an allowlisted secret-free
    // template; any other .env* file is banned)
    for (const n of names) {
      expect(n).not.toMatch(/provider-api-keys|client-api-keys|codex-seekai|backups|node_modules|\.git|\.log$|\.zip$/);
      expect(n).not.toBe('.env');
      if (n.startsWith('.env.') && n !== '.env.example') expect.fail(`banned dotenv file in backup: ${n}`);
    }
  });

  it('sanitizes usage records and leaks no secret into the ZIP bytes', async () => {
    const r = await rawGet('/admin/backup/download', `Bearer ${ADMIN_KEY}`);
    expect(r.status).toBe(200);
    const usage = JSON.parse(extractZipEntry(r.bytes, 'data/usage-records.json').toString('utf-8'));
    expect(Array.isArray(usage)).toBe(true);
    expect(usage.length).toBeGreaterThanOrEqual(2);
    const seeded = usage.filter((u: any) => u.model === 'seed-model-a' || u.model === 'seed-model-b');
    expect(seeded.length).toBe(2);
    for (const u of usage) expect(u.apiKey).toBeNull();
    const masked = usage.find((u: any) => u.model === 'seed-model-a');
    expect(masked.apiKeyMasked).toBe('SUPE***2345');
    const manifest = JSON.parse(extractZipEntry(r.bytes, 'manifest.json').toString('utf-8'));
    expect(manifest.fullBackupVersion).toBe(1);
    expect(manifest.usageRecordCount).toBeGreaterThanOrEqual(2);
    // raw bytes must not contain any secret material
    const latin = r.bytes.toString('latin1');
    for (const secret of [RAW_UPSTREAM_DECOY, CLIENT_HASH_DECOY, CLIENT_ID_DECOY, CODEX_TOKEN_DECOY]) {
      expect(latin).not.toContain(secret);
    }
  });

  it('writes no server-side files (no temp ZIP, no new snapshots)', async () => {
    const before = new Set(listBackupsDir());
    await rawGet('/admin/backup/download', `Bearer ${ADMIN_KEY}`);
    expect(new Set(listBackupsDir())).toEqual(before);
    const leftovers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
        else if (e.name.endsWith('.zip') && e.name.startsWith('nvidia-api-backup-')) leftovers.push(p);
      }
    };
    walk(DATA_DIR);
    expect(leftovers).toEqual([]);
  });
});
