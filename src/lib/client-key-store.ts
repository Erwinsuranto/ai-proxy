/* ============================================================================
 * nvidia-api · Client API Key store (per-client credentials created via Admin)
 * ----------------------------------------------------------------------------
 * Persistent storage for API keys minted by the "Create API Key" feature.
 * Each client key is bound to EXACTLY ONE provider and a whitelist of that
 * provider's models:
 *
 *     API Key → Provider → Allowed Models
 *
 * SECURITY CONTRACT (differs from provider keys):
 *  - Unlike upstream provider credentials, client keys are never needed at
 *    runtime in raw form (verification only compares SHA-256 hashes), so the
 *    plaintext secret is NEVER persisted — only `keyHash` survives. The raw
 *    key is returned exactly once by the create endpoint.
 *  - Public responses expose masked metadata only (`maskedKey`, model list).
 *    `keyHash` is one-way but still omitted from API responses.
 *
 * File format mirrors `api-key-store.ts` / `provider-state.ts` (single JSON
 * file under DATA_DIR, synchronous read-modify-write, defensive normalization
 * on load).
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DATA_DIR } from './data-dir';
import { maskApiKey } from './api-key-store';
import { recordUsage } from './usage-store';

const STORE_FILE = path.join(DATA_DIR, 'client-api-keys.json');

export type ClientKeyStatus = 'active' | 'disabled';

/** Full record (server-side only; `keyHash` never leaves this module's API). */
export interface ClientApiKeyRecord {
  id: string;
  /** Display-safe masked form (e.g. "sk-a***wxyz"). Never reversible. */
  maskedKey: string;
  /** SHA-256 hex of the raw secret — the only persisted credential trace. */
  keyHash: string;
  providerId: string;
  /** Exact model ids (client-facing registry names) this key may request. */
  allowedModels: string[];
  label?: string;
  status: ClientKeyStatus;
  createdAt: number;
  updatedAt: number;
  /** Usage metadata (populated on authenticated requests). */
  lastUsedAt: number | null;
  requestCount: number;
}

/** Public (safe) shape returned by the Admin API — no `keyHash`. */
export interface PublicClientKeyRecord {
  id: string;
  maskedKey: string;
  providerId: string;
  allowedModels: string[];
  label?: string;
  status: ClientKeyStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  requestCount: number;
}

interface ClientKeyStoreFile {
  version: 1;
  keys: ClientApiKeyRecord[];
}

export class ClientKeyValidationError extends Error { }

function emptyStore(): ClientKeyStoreFile {
  return { version: 1, keys: [] };
}

function hashClientKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf-8').digest('hex');
}

function toPublicRecord(rec: ClientApiKeyRecord): PublicClientKeyRecord {
  return {
    id: rec.id,
    maskedKey: rec.maskedKey,
    providerId: rec.providerId,
    allowedModels: [...rec.allowedModels],
    label: rec.label,
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastUsedAt: rec.lastUsedAt ?? null,
    requestCount: rec.requestCount ?? 0,
  };
}

/* mtime-based read cache: the auth hook runs on EVERY /v1 request, so avoid
 * re-parsing the JSON file when it has not changed. Invalidated on save. */
let cache: { mtimeMs: number; keys: ClientApiKeyRecord[] } | null = null;

export function loadClientKeyStore(): ClientApiKeyRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const mtimeMs = fs.statSync(STORE_FILE).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.keys;
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) return [];
    // Defensive normalization: drop malformed entries instead of crashing.
    const keys = parsed.keys.filter((r: any) =>
      r
      && typeof r.id === 'string'
      && typeof r.keyHash === 'string'
      && typeof r.providerId === 'string'
      && Array.isArray(r.allowedModels),
    ) as ClientApiKeyRecord[];
    cache = { mtimeMs, keys };
    return keys;
  } catch {
    return [];
  }
}

function saveClientKeyStore(keys: ClientApiKeyRecord[]): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file: ClientKeyStoreFile = { version: 1, keys };
    fs.writeFileSync(STORE_FILE, JSON.stringify(file, null, 2), 'utf-8');
    cache = { mtimeMs: fs.statSync(STORE_FILE).mtimeMs, keys };
  } catch (err) {
    console.error('[ClientKeyStore] Failed to save client API keys:', err);
    throw err;
  }
}

/** True when at least one client key exists (drives UI empty-states). */
export function hasAnyClientKeys(): boolean {
  return loadClientKeyStore().length > 0;
}

export interface CreateClientKeyInput {
  providerId: string;
  allowedModels: string[];
  label?: string;
}

export interface CreateClientKeyResult {
  record: ClientApiKeyRecord;
  /** Raw secret — returned ONCE by the create endpoint, never persisted. */
  rawKey: string;
}

/** Mints a new client key. Caller (admin route) is responsible for validating
 *  providerId + allowedModels against the live registries. */
export function createClientKey(input: CreateClientKeyInput): CreateClientKeyResult {
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
  if (!providerId) throw new ClientKeyValidationError('providerId is required');

  const models = Array.isArray(input.allowedModels)
    ? [...new Set(input.allowedModels.map(m => String(m).trim()).filter(Boolean))]
    : [];
  if (models.length === 0) {
    throw new ClientKeyValidationError('allowedModels must contain at least one model');
  }

  const rawKey = 'sk-' + randomBytes(24).toString('hex');
  const now = Date.now();
  const record: ClientApiKeyRecord = {
    id: `ck_${randomUUID()}`,
    maskedKey: maskApiKey(rawKey),
    keyHash: hashClientKey(rawKey),
    providerId,
    allowedModels: models,
    label: input.label && input.label.trim() ? input.label.trim().slice(0, 200) : undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    requestCount: 0,
  };
  saveClientKeyStore([...loadClientKeyStore(), record]);
  console.log(`[ClientKeyStore] Created client key ${record.maskedKey} for provider "${providerId}" (${models.length} allowed models)`);
  return { record, rawKey };
}

/** Hash-based lookup. Returns the record for BOTH active and disabled keys so
 *  the auth hook can distinguish "disabled" from "unknown" credentials. */
export function findClientKeyByRaw(rawKey: string): ClientApiKeyRecord | null {
  if (!rawKey) return null;
  const hash = hashClientKey(rawKey);
  return loadClientKeyStore().find(r => r.keyHash === hash) || null;
}

/** Server-side lookup by record id (includes `keyHash` — never serialize the
 *  result into a response). Used by the combo admin routes for validation. */
export function getClientKeyById(keyId: string): ClientApiKeyRecord | null {
  if (!keyId) return null;
  return loadClientKeyStore().find(r => r.id === keyId) || null;
}

export function listClientKeys(): PublicClientKeyRecord[] {
  return loadClientKeyStore()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toPublicRecord);
}

export function setClientKeyStatus(keyId: string, enabled: boolean): PublicClientKeyRecord | null {
  const keys = loadClientKeyStore();
  const rec = keys.find(r => r.id === keyId);
  if (!rec) return null;
  rec.status = enabled ? 'active' : 'disabled';
  rec.updatedAt = Date.now();
  saveClientKeyStore(keys);
  console.log(`[ClientKeyStore] ${enabled ? 'Enabled' : 'Disabled'} client key ${rec.maskedKey}`);
  return toPublicRecord(rec);
}

export function deleteClientKey(keyId: string): boolean {
  const keys = loadClientKeyStore();
  const idx = keys.findIndex(r => r.id === keyId);
  if (idx === -1) return false;
  const removed = keys[idx];
  saveClientKeyStore(keys.filter(r => r.id !== keyId));
  console.log(`[ClientKeyStore] Deleted client key ${removed.maskedKey} (provider "${removed.providerId}")`);
  return true;
}

/** Usage metadata update on successful authentication. Cheap sync write — the
 *  store is tiny and every other store in this codebase follows the same
 *  read-modify-write pattern. */
export function touchClientKey(keyId: string): void {
  try {
    const keys = loadClientKeyStore();
    const rec = keys.find(r => r.id === keyId);
    if (!rec) return;
    rec.lastUsedAt = Date.now();
    rec.requestCount = (rec.requestCount ?? 0) + 1;
    saveClientKeyStore(keys);
  } catch {
    // Never break the request path for usage metadata.
  }
}

/* ─── Request-time permission enforcement ────────────────────────────────── */

export interface ModelAccessDenial {
  status: number;
  type: string;
  message: string;
}

/**
 * Validates a requested model against a client key's permissions.
 *
 * Rules:
 *  - disabled key  → 401 (auth hook handles this, but keep defense in depth)
 *  - exact model match in allowedModels → allowed
 *  - "anything/model" prefixed forms are allowed when the BASE model is in
 *    allowedModels. The prefix itself is an internal compatibility detail and
 *    carries NO information: accepting or rejecting never depends on which
 *    provider a prefix names, so the key's provider binding cannot be probed
 *    by trying different prefixes. (Routing resolves by the base id.)
 *  - anything else → 403 with a clear, actionable message
 *
 * Client-facing messages NEVER mention the key's bound provider (internal
 * mapping) — they only echo the client's own request + allowed models.
 * Returns null when access is granted.
 */
export function checkClientKeyModelAccess(
  record: Pick<ClientApiKeyRecord, 'providerId' | 'allowedModels' | 'status' | 'maskedKey'>,
  requestedModel: string,
): ModelAccessDenial | null {
  if (record.status !== 'active') {
    return { status: 401, type: 'auth_error', message: 'API key is disabled' };
  }
  const model = String(requestedModel || '').trim();
  const allowed = new Set(record.allowedModels);

  if (allowed.has(model)) return null;

  /* Prefixed form "prefix/base": the BASE model decides. The prefix name is
   * never inspected — it cannot reveal (or gate on) the key's provider. */
  const slash = model.indexOf('/');
  if (slash > 0) {
    const base = model.slice(slash + 1);
    if (base && allowed.has(base)) return null;
  }

  return {
    status: 403,
    type: 'invalid_request_error',
    message: `Model "${model}" is not allowed for this API key. Allowed models: ${record.allowedModels.join(', ')}.`,
  };
}

/** Records a permission-denied request as a 'blocked' usage row so the logs
 *  dashboard attributes it to the client key (non-breaking best effort). */
export function recordClientKeyBlocked(
  record: Pick<ClientApiKeyRecord, 'id' | 'providerId' | 'maskedKey'>,
  model: string,
  httpStatus: number,
  errorMessage: string,
  requestId?: string | null,
): void {
  try {
    recordUsage({
      timestamp: Date.now(),
      provider: record.providerId,
      model: model || 'unknown',
      status: 'blocked',
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      apiKey: record.id,
      httpStatus,
      errorMessage,
      requestId: requestId ?? null,
      apiKeyMasked: record.maskedKey,
    });
  } catch {
    // Usage recording must never break the request path.
  }
}
