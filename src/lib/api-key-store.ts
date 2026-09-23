/* ============================================================================
 * nvidia-api · Provider API Key store (UI-managed credentials)
 * ----------------------------------------------------------------------------
 * Persistent storage for API keys added through the Admin dashboard, following
 * the same JSON-file pattern as `provider-state.ts`.
 *
 * SECURITY CONTRACT:
 *  - The raw key value (`key`) lives ONLY in this server-side file. It exists
 *    here because the runtime (KeyManager) needs it to authenticate upstream
 *    requests. It must NEVER be returned by any Admin API response, written to
 *    logs/usage records, or included in backups (backup.ts intentionally has
 *    no api-keys dataset).
 *  - Everything exposed outside this module is masked metadata only.
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from './data-dir';

const STORE_FILE = path.join(DATA_DIR, 'provider-api-keys.json');

export type ApiKeyStatus = 'active' | 'disabled';

/** Full record — includes the raw key. Server-side only; never serialize this
 *  into an HTTP response. Use `toPublicRecord` at the API boundary. */
export interface ProviderApiKeyRecord {
  id: string;
  providerId: string;
  /** Masked form safe for display (e.g. "sk-a***wxyz"). Never reversible. */
  maskedKey: string;
  label?: string;
  status: ApiKeyStatus;
  createdAt: number;
  updatedAt: number;
  /** Raw credential — runtime use only. NEVER expose via Admin API/logs/UI. */
  key: string;
}

/** Public (safe) shape returned by the Admin API and shown in the UI. */
export interface PublicApiKeyRecord {
  id: string;
  providerId: string;
  maskedKey: string;
  label?: string;
  status: ApiKeyStatus;
  createdAt: number;
  updatedAt: number;
}

interface ApiKeyStoreFile {
  version: 1;
  providers: Record<string, ProviderApiKeyRecord[]>;
  /** Monotonic auto-numbering watermark per provider. Tracks the highest
   *  trailing number ever assigned to a `"<base> <n>"` label, so a deleted
   *  key's number is never reused for a new one. Optional (pre-existing
   *  store files simply lack it — no migration needed). NOT an auth field;
   *  contains no secrets and is safe to expose as a suggestion string. */
  nameCounters?: Record<string, { base: string; n: number }>;
}

const MAX_KEY_LENGTH = 4096;

/** Masks a raw key for display. Mirrors KeyManager's mask format. */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

export function toPublicRecord(rec: ProviderApiKeyRecord): PublicApiKeyRecord {
  return {
    id: rec.id,
    providerId: rec.providerId,
    maskedKey: rec.maskedKey,
    label: rec.label,
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function emptyStore(): ApiKeyStoreFile {
  return { version: 1, providers: {} };
}

export function loadApiKeyStore(): ApiKeyStoreFile {
  try {
    if (!fs.existsSync(STORE_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const providers = parsed.providers && typeof parsed.providers === 'object'
      ? parsed.providers
      : {};
    // Defensive normalization: drop malformed entries instead of crashing.
    const normalized: Record<string, ProviderApiKeyRecord[]> = {};
    for (const [providerId, list] of Object.entries(providers)) {
      if (!Array.isArray(list)) continue;
      const valid = list.filter((r: any) =>
        r && typeof r.id === 'string' && typeof r.key === 'string' && r.key.length > 0,
      ) as ProviderApiKeyRecord[];
      if (valid.length > 0) normalized[providerId] = valid;
    }
    const counters: ApiKeyStoreFile['nameCounters'] = {};
    if (parsed.nameCounters && typeof parsed.nameCounters === 'object') {
      for (const [pid, c] of Object.entries(parsed.nameCounters as Record<string, any>)) {
        if (c && typeof c.base === 'string' && typeof c.n === 'number' && Number.isFinite(c.n)) {
          counters[pid] = { base: c.base, n: c.n };
        }
      }
    }
    return { version: 1, providers: normalized, ...(Object.keys(counters).length > 0 ? { nameCounters: counters } : {}) };
  } catch {
    return emptyStore();
  }
}

function saveApiKeyStore(store: ApiKeyStoreFile): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ApiKeyStore] Failed to save provider API keys:', err);
    throw err;
  }
}

/** All persisted keys grouped by providerId (raw values included — internal use). */
export function loadAllProviderApiKeys(): Record<string, ProviderApiKeyRecord[]> {
  return loadApiKeyStore().providers;
}

export function loadApiKeysForProvider(providerId: string): ProviderApiKeyRecord[] {
  return loadApiKeyStore().providers[providerId] || [];
}

export function getApiKeyCount(providerId: string): number {
  return loadApiKeysForProvider(providerId).length;
}

export function findApiKey(providerId: string, keyId: string): ProviderApiKeyRecord | null {
  return loadApiKeysForProvider(providerId).find(r => r.id === keyId) || null;
}

/** True when the exact raw key is already stored for this provider. */
export function hasRawKey(providerId: string, rawKey: string): boolean {
  return loadApiKeysForProvider(providerId).some(r => r.key === rawKey);
}

/* Resolves the runtime credential seed for a provider.
 *
 * Source rule (env→UI migration contract):
 *  - A provider that HAS UI-managed records ("migrated") uses ONLY those —
 *    env keys are never consulted, never merged, never a fallback for it.
 *  - A provider with ZERO UI records ("not migrated", e.g. fresh installs or
 *    test fixtures) keeps the historical behavior: env keys seed rotation,
 *    with an explicit warning so env use is never silent.
 * After a completed migration every env-backed provider has UI records, so
 * the env branch is unreachable for them and the runtime is fully UI-driven. */
export function resolveRuntimeKeys(providerId: string, envKeys: string[]): string[] {
  const records = loadApiKeysForProvider(providerId);
  const active = records.filter(r => r.status === 'active').map(r => r.key);
  if (active.length > 0) return active;
  if (envKeys.length > 0) {
    console.warn(`[ApiKeyStore] Provider "${providerId}" has no UI-managed keys — seeding rotation from ${envKeys.length} env key(s). Migrate them via Admin UI to retire env as a credential source.`);
  }
  return [...envKeys];
}

/* Reorders provider sections in the store file to a canonical order WITHOUT
 * touching any record (content, status and intra-provider order preserved).
 * Unknown sections are kept at the end, untouched. */
export function reorderProviders(order: string[]): void {
  let raw: any;
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || !raw.providers || typeof raw.providers !== 'object') return;
  const reordered: Record<string, unknown> = {};
  for (const pid of order) {
    if (Object.prototype.hasOwnProperty.call(raw.providers, pid)) reordered[pid] = raw.providers[pid];
  }
  for (const pid of Object.keys(raw.providers)) {
    if (!Object.prototype.hasOwnProperty.call(reordered, pid)) reordered[pid] = raw.providers[pid];
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ ...raw, providers: reordered }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ApiKeyStore] Failed to reorder provider API keys:', err);
    throw err;
  }
}

export class ApiKeyValidationError extends Error { }
export class ApiKeyDuplicateError extends Error { }

export interface AddApiKeyResult {
  record: ProviderApiKeyRecord;
}

/** Validates + persists a new API key for a provider. Throws
 *  ApiKeyValidationError for malformed input and ApiKeyDuplicateError when the
 *  same raw key already exists for that provider. */
export function addApiKey(providerId: string, rawApiKey: string, label?: string): AddApiKeyResult {
  const trimmed = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  if (!trimmed) {
    throw new ApiKeyValidationError('apiKey must be a non-empty string');
  }
  if (trimmed.length > MAX_KEY_LENGTH) {
    throw new ApiKeyValidationError(`apiKey exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
  }

  const store = loadApiKeyStore();
  const existing = store.providers[providerId] || [];
  if (existing.some(r => r.key === trimmed)) {
    throw new ApiKeyDuplicateError('This API key already exists for this provider');
  }

  const now = Date.now();
  const record: ProviderApiKeyRecord = {
    id: `key_${randomUUID()}`,
    providerId,
    maskedKey: maskApiKey(trimmed),
    label: label && label.trim() ? label.trim().slice(0, 200) : undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    key: trimmed,
  };
  store.providers[providerId] = [...existing, record];
  /* Advance the numbering watermark when the caller-supplied label follows a
     trailing-number pattern ("<base> <n>"). Existing counters are only bumped
     for the SAME base — custom names never hijack the suggestion. */
  if (record.label) {
    const m = record.label.match(/^(.*?)\s(\d+)$/);
    if (m) {
      const base = (m[1] || '').trim();
      const n = Number(m[2]);
      if (base && Number.isFinite(n)) {
        const counters = store.nameCounters || (store.nameCounters = {});
        const cur = counters[providerId];
        if (!cur) counters[providerId] = { base, n };
        else if (cur.base === base && n > cur.n) counters[providerId] = { base, n };
      }
    }
  }
  saveApiKeyStore(store);
  console.log(`[ApiKeyStore] Added API key ${record.maskedKey} for provider "${providerId}"`);
  return { record };
}

/** Next sequential label suggestion for a provider ("Production Key 4").
 *  Uses the persisted watermark when known (so numbers of DELETED keys are
 *  never reused), else the highest trailing number among current labels.
 *  Purely a UI suggestion — the label itself remains caller/backend data.
 *  Contains no secrets. */
export function computeKeyLabelSuggestion(providerId: string): string {
  const store = loadApiKeyStore();
  const cur = store.nameCounters?.[providerId];
  if (cur) return `${cur.base} ${cur.n + 1}`;
  let base = 'Production Key';
  let max = 0;
  for (const rec of store.providers[providerId] || []) {
    const m = (rec.label || '').match(/^(.*?)\s(\d+)$/);
    if (m) {
      const b = (m[1] || '').trim();
      const n = Number(m[2]);
      if (b && Number.isFinite(n) && n > max) { base = b; max = n; }
    }
  }
  return `${base} ${max + 1}`;
}

/** Removes a persisted key. Returns false when the key does not exist or does
 *  not belong to the given provider (ownership check prevents ID collision
 *  manipulation across providers). */
export function deleteApiKey(providerId: string, keyId: string): boolean {
  const store = loadApiKeyStore();
  const list = store.providers[providerId];
  if (!list) return false;
  const idx = list.findIndex(r => r.id === keyId && r.providerId === providerId);
  if (idx === -1) return false;
  const removed = list[idx];
  const next = [...list.slice(0, idx), ...list.slice(idx + 1)];
  if (next.length > 0) store.providers[providerId] = next;
  else delete store.providers[providerId];
  saveApiKeyStore(store);
  console.log(`[ApiKeyStore] Deleted API key ${removed.maskedKey} from provider "${providerId}"`);
  return true;
}

/** Enables/disables a persisted key without deleting it. Returns null when the
 *  key is missing or belongs to another provider. */
export function setApiKeyStatus(providerId: string, keyId: string, enabled: boolean): ProviderApiKeyRecord | null {
  const store = loadApiKeyStore();
  const list = store.providers[providerId];
  if (!list) return null;
  const rec = list.find(r => r.id === keyId && r.providerId === providerId);
  if (!rec) return null;
  rec.status = enabled ? 'active' : 'disabled';
  rec.updatedAt = Date.now();
  saveApiKeyStore(store);
  console.log(`[ApiKeyStore] ${enabled ? 'Enabled' : 'Disabled'} API key ${rec.maskedKey} for provider "${providerId}"`);
  return rec;
}
