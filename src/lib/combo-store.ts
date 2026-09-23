/* ============================================================================
 * nvidia-api · Combo store (Client → Provider → Model → Provider API Key)
 * ----------------------------------------------------------------------------
 * Persistent storage for admin-defined routing combos. A combo pins ONE
 * client API key to ONE provider + ONE of that provider's models and
 * (optionally) ONE of that provider's API keys:
 *
 *     Client API Key → Provider → Model → Provider API Key
 *
 * Semantics enforced elsewhere (this module only stores/looks up records):
 *  - Routing is provider-locked to `providerId` (services/provider.ts).
 *  - `providerKeyId === null` means the provider's EXISTING multi-key
 *    rotation across ALL of that provider's keys (never another provider).
 *  - A non-null `providerKeyId` pins the credential as first choice; on
 *    failure rotation may move to OTHER KEYS OF THE SAME PROVIDER only.
 *
 * SECURITY CONTRACT: the record stores IDs only — never credentials. The raw
 * provider key stays in api-key-store.ts; the client key secret stays hashed
 * in client-key-store.ts. Everything exposed here is safe metadata.
 *
 * File format mirrors `client-key-store.ts` (single JSON file under DATA_DIR,
 * synchronous read-modify-write, mtime read cache, defensive normalization).
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from './data-dir';

const STORE_FILE = path.join(DATA_DIR, 'combos.json');

export type ComboStatus = 'active' | 'disabled';

export interface ComboRecord {
  id: string;
  clientKeyId: string;
  providerId: string;
  /** Client-facing model id (ModelRegistry name) — MUST belong to providerId. */
  model: string;
  /** Route id within a multi-route provider. Null/undefined = provider default (legacy behavior). */
  routeId?: string | null;
  /** Provider API key record id (`key_...`) or null = provider-wide rotation. */
  providerKeyId: string | null;
  status: ComboStatus;
  createdAt: number;
  updatedAt: number;
  requestCount: number;
  lastUsedAt: number | null;
}

/** Public (safe) shape returned by the Admin API — IDs/masked metadata only. */
export interface PublicComboRecord {
  id: string;
  clientKeyId: string;
  providerId: string;
  model: string;
  routeId?: string | null;
  providerKeyId: string | null;
  status: ComboStatus;
  createdAt: number;
  updatedAt: number;
  requestCount: number;
  lastUsedAt: number | null;
}

interface ComboStoreFile {
  version: 1;
  combos: ComboRecord[];
}

export class ComboValidationError extends Error { }

export function toPublicCombo(rec: ComboRecord): PublicComboRecord {
  return {
    id: rec.id,
    clientKeyId: rec.clientKeyId,
    providerId: rec.providerId,
    model: rec.model,
    routeId: rec.routeId ?? null,
    providerKeyId: rec.providerKeyId ?? null,
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    requestCount: rec.requestCount ?? 0,
    lastUsedAt: rec.lastUsedAt ?? null,
  };
}

/** Active combo (other than `excludeId`) pinning the same client key + model.
 *  Two active combos for one (clientKeyId, model) pair would make routing
 *  ambiguous, so create/update/setStatus all reject on this condition and the
 *  admin PATCH route uses it as an ATOMIC pre-check (no partial writes).
 *  Disabled combos never conflict — re-enabling is checked the same way. */
export function findActiveComboDuplicate(
  clientKeyId: string,
  model: string,
  excludeId?: string,
): ComboRecord | null {
  const wantedClient = String(clientKeyId || '').trim();
  const wantedModel = String(model || '').trim();
  if (!wantedClient || !wantedModel) return null;
  return loadCombos().find(r =>
    r.status === 'active'
    && r.id !== excludeId
    && r.clientKeyId === wantedClient
    && r.model === wantedModel) || null;
}

/* mtime-based read cache: the request guard looks up combos on EVERY /v1
 * request, so avoid re-parsing the JSON file when it has not changed.
 * Invalidated on save. */
let cache: { mtimeMs: number; combos: ComboRecord[] } | null = null;

export function loadCombos(): ComboRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const mtimeMs = fs.statSync(STORE_FILE).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.combos;
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.combos)) return [];
    // Defensive normalization: drop malformed entries instead of crashing.
    const combos = parsed.combos.filter((r: any) =>
      r
      && typeof r.id === 'string'
      && typeof r.clientKeyId === 'string'
      && typeof r.providerId === 'string'
      && typeof r.model === 'string',
    ) as ComboRecord[];
    cache = { mtimeMs, combos };
    return combos;
  } catch (err) {
    /* Fail closed (no combos → default routing policy) but never SILENTLY:
     * a corrupt store must be visible in the server log. */
    console.error('[ComboStore] Failed to load combos (failing closed):', err);
    return [];
  }
}

function saveComboStore(combos: ComboRecord[]): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file: ComboStoreFile = { version: 1, combos };
    fs.writeFileSync(STORE_FILE, JSON.stringify(file, null, 2), 'utf-8');
    cache = { mtimeMs: fs.statSync(STORE_FILE).mtimeMs, combos };
  } catch (err) {
    console.error('[ComboStore] Failed to save combos:', err);
    throw err;
  }
}

export function listCombos(): PublicComboRecord[] {
  return loadCombos()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toPublicCombo);
}

export function getComboById(id: string): ComboRecord | null {
  return loadCombos().find(r => r.id === id) || null;
}

export interface CreateComboInput {
  clientKeyId: string;
  providerId: string;
  model: string;
  routeId?: string | null;
  providerKeyId: string | null;
}

/** Persists a new combo. Caller (admin route) validates the entities against
 *  the live registries; this enforces record-level invariants only. */
export function createCombo(input: CreateComboInput): ComboRecord {
  const clientKeyId = typeof input.clientKeyId === 'string' ? input.clientKeyId.trim() : '';
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const providerKeyId = typeof input.providerKeyId === 'string' && input.providerKeyId.trim()
    ? input.providerKeyId.trim()
    : null;
  const routeId = typeof input.routeId === 'string' && input.routeId.trim()
    ? input.routeId.trim()
    : null;

  if (!clientKeyId) throw new ComboValidationError('clientKeyId is required');
  if (!providerId) throw new ComboValidationError('providerId is required');
  if (!model) throw new ComboValidationError('model is required');

  /* One ACTIVE combo per (client key, model): two active combos for the same
   * pair would make routing ambiguous. Disabled combos do not conflict —
   * re-enabling is rejected the same way by updateCombo. */
  const duplicate = findActiveComboDuplicate(clientKeyId, model);
  if (duplicate) {
    throw new ComboValidationError(
      `An active combo for this client API key and model already exists (${duplicate.id})`,
    );
  }

  const now = Date.now();
  const record: ComboRecord = {
    id: `combo_${randomUUID()}`,
    clientKeyId,
    providerId,
    model,
    routeId,
    providerKeyId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    requestCount: 0,
    lastUsedAt: null,
  };
  saveComboStore([...loadCombos(), record]);
  console.log(`[ComboStore] Created combo ${record.id}: client=${clientKeyId} provider=${providerId} model=${model} route=${routeId ?? '(default)'} providerKey=${providerKeyId ?? '(provider rotation)'}`);
  return record;
}

export interface UpdateComboPatch {
  clientKeyId?: string;
  providerId?: string;
  model?: string;
  routeId?: string | null;
  providerKeyId?: string | null;
}

/** Applies an admin edit. Entity validation (provider/model/key ownership)
 *  is the route's job against the live registries; this enforces record
 *  invariants (required fields, uniqueness among active combos). */
export function updateCombo(id: string, patch: UpdateComboPatch): PublicComboRecord | null {
  const combos = loadCombos();
  const rec = combos.find(r => r.id === id);
  if (!rec) return null;

  const next = {
    clientKeyId: patch.clientKeyId !== undefined ? String(patch.clientKeyId).trim() : rec.clientKeyId,
    providerId: patch.providerId !== undefined ? String(patch.providerId).trim() : rec.providerId,
    model: patch.model !== undefined ? String(patch.model).trim() : rec.model,
    routeId: patch.routeId !== undefined
      ? (typeof patch.routeId === 'string' && patch.routeId.trim() ? patch.routeId.trim() : null)
      : (rec.routeId ?? null),
    providerKeyId: patch.providerKeyId !== undefined
      ? (typeof patch.providerKeyId === 'string' && patch.providerKeyId.trim() ? patch.providerKeyId.trim() : null)
      : rec.providerKeyId,
  };
  if (!next.clientKeyId) throw new ComboValidationError('clientKeyId is required');
  if (!next.providerId) throw new ComboValidationError('providerId is required');
  if (!next.model) throw new ComboValidationError('model is required');

  const duplicate = findActiveComboDuplicate(next.clientKeyId, next.model, id);
  if (duplicate && rec.status === 'active') {
    throw new ComboValidationError(
      `An active combo for this client API key and model already exists (${duplicate.id})`,
    );
  }

  rec.clientKeyId = next.clientKeyId;
  rec.providerId = next.providerId;
  rec.model = next.model;
  rec.routeId = next.routeId;
  rec.providerKeyId = next.providerKeyId;
  rec.updatedAt = Date.now();
  saveComboStore(combos);
  console.log(`[ComboStore] Updated combo ${rec.id}`);
  return toPublicCombo(rec);
}

/** Enables/disables a combo. Disabled combos stop enforcing routing AND stop
 *  granting model access — the client key's own allowlist policy applies.
 *  Re-enabling is rejected (ComboValidationError) when another ACTIVE combo
 *  already pins the same client key + model, so two active combos can never
 *  coexist for one pair. */
export function setComboStatus(id: string, enabled: boolean): PublicComboRecord | null {
  const combos = loadCombos();
  const rec = combos.find(r => r.id === id);
  if (!rec) return null;
  if (enabled) {
    const duplicate = findActiveComboDuplicate(rec.clientKeyId, rec.model, id);
    if (duplicate) {
      throw new ComboValidationError(
        `An active combo for this client API key and model already exists (${duplicate.id})`,
      );
    }
  }
  rec.status = enabled ? 'active' : 'disabled';
  rec.updatedAt = Date.now();
  saveComboStore(combos);
  console.log(`[ComboStore] ${enabled ? 'Enabled' : 'Disabled'} combo ${rec.id}`);
  return toPublicCombo(rec);
}

export function deleteCombo(id: string): boolean {
  const combos = loadCombos();
  const idx = combos.findIndex(r => r.id === id);
  if (idx === -1) return false;
  const removed = combos[idx];
  saveComboStore(combos.filter(r => r.id !== id));
  console.log(`[ComboStore] Deleted combo ${removed.id} (provider "${removed.providerId}", model "${removed.model}")`);
  return true;
}

/** Active combo for a client key + model. Combos store BASE model ids; when
 *  the request uses a "prefix/model" form the caller passes the base id. */
export function findActiveComboForModel(clientKeyId: string, model: string): ComboRecord | null {
  if (!clientKeyId || !model) return null;
  const wanted = String(model).trim();
  return loadCombos().find(r =>
    r.status === 'active'
    && r.clientKeyId === clientKeyId
    && r.model === wanted) || null;
}

/** Distinct model ids granted to a client key by its ACTIVE combos — used by
 *  /v1/models to expose the effective catalog for that key. */
export function listActiveComboModels(clientKeyId: string): string[] {
  const set = new Set<string>();
  for (const r of loadCombos()) {
    if (r.status === 'active' && r.clientKeyId === clientKeyId) set.add(r.model);
  }
  return [...set];
}

/** Usage metadata update on a successful combo-routed request. Cheap sync
 *  write — same read-modify-write pattern as touchClientKey. Never breaks the
 *  request path. */
export function touchCombo(comboId: string): void {
  try {
    const combos = loadCombos();
    const rec = combos.find(r => r.id === comboId);
    if (!rec) return;
    rec.lastUsedAt = Date.now();
    rec.requestCount = (rec.requestCount ?? 0) + 1;
    saveComboStore(combos);
  } catch {
    // Usage metadata must never break the request path.
  }
}
