/* ============================================================================
 * nvidia-api · Model Pricing store (admin-managed)
 * ----------------------------------------------------------------------------
 * Persistent storage for model pricing entries added/edited via the Admin
 * dashboard, following the same JSON-file pattern as `provider-state.ts` and
 * `api-key-store.ts`.
 *
 * SEMANTICS:
 *  - A stored ENABLED entry for an exact provider/model pair OVERRIDES the
 *    built-in PRICING_REGISTRY entry (if any).
 *  - A stored DISABLED entry DISABLES pricing for that pair entirely — the
 *    pair is treated as unknown (cost null), even if a built-in price exists.
 *    Disable is preferred over delete so configuration intent is preserved.
 *  - Deleting a stored entry only removes PRICING CONFIGURATION. Historical
 *    usage records and their already-stored costs are never touched.
 *
 * SECURITY: entries hold only price metadata — no credentials of any kind.
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './data-dir';

const STORE_FILE = path.join(DATA_DIR, 'model-pricing.json');

export interface ModelPricingEntry {
  /** Stable composite id: `${providerId}/${model}` (normalized lowercase). */
  id: string;
  providerId: string;
  /** Exact model ID — must match the ID used in /v1/models and Usage Logs. */
  model: string;
  /** USD per 1M input (prompt) tokens. */
  inputPerM: number;
  /** USD per 1M output (completion) tokens. */
  outputPerM: number;
  currency: 'USD';
  enabled: boolean;
  source: 'admin';
  createdAt: number;
  updatedAt: number;
}

interface PricingStoreFile {
  version: 1;
  entries: ModelPricingEntry[];
}

/* In-memory cache: getModelPrice() is called per usage record; re-reading the
 * file each time would be wasteful. The cache is invalidated on every write,
 * which always happens in this process (single-writer server). */
let cache: ModelPricingEntry[] | null = null;

function emptyStore(): PricingStoreFile {
  return { version: 1, entries: [] };
}

export function loadPricingEntries(): ModelPricingEntry[] {
  if (cache) return cache;
  try {
    if (!fs.existsSync(STORE_FILE)) { cache = []; return cache; }
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    const list: any[] = Array.isArray(parsed) ? parsed : (parsed?.entries ?? []);
    cache = list
      .filter((e: any) => e && typeof e.providerId === 'string' && typeof e.model === 'string'
        && typeof e.inputPerM === 'number' && Number.isFinite(e.inputPerM) && e.inputPerM >= 0
        && typeof e.outputPerM === 'number' && Number.isFinite(e.outputPerM) && e.outputPerM >= 0)
      .map((e: any) => normalizeEntry(e.providerId, e.model, e.inputPerM, e.outputPerM, {
        enabled: e.enabled !== false,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
      }));
    return cache!;
  } catch {
    cache = [];
    return cache;
  }
}

function saveEntries(entries: ModelPricingEntry[]): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
  cache = entries;
}

function normalizeId(providerId: string, model: string): string {
  return `${providerId.trim().toLowerCase()}/${model.trim().toLowerCase()}`;
}

function normalizeEntry(
  providerId: string, model: string, inputPerM: number, outputPerM: number,
  extra?: Partial<Pick<ModelPricingEntry, 'enabled' | 'createdAt' | 'updatedAt'>>,
): ModelPricingEntry {
  const now = Date.now();
  return {
    id: normalizeId(providerId, model),
    providerId: providerId.trim().toLowerCase(),
    model: model.trim(),
    inputPerM,
    outputPerM,
    currency: 'USD',
    enabled: extra?.enabled ?? true,
    source: 'admin',
    createdAt: extra?.createdAt ?? now,
    updatedAt: extra?.updatedAt ?? now,
  };
}

export class PricingValidationError extends Error { }

/** Drops the in-memory cache so the next read re-reads the store file.
 *  Useful after out-of-band file changes and in tests that mutate pricing
 *  through a different process (the admin API already keeps its own cache
 *  coherent via saveEntries). */
export function reloadPricingCache(): void {
  cache = null;
}

/** Validates numeric price input (finite, >= 0). */
export function validatePrice(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PricingValidationError(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function findPricingEntry(providerId: string, model: string): ModelPricingEntry | null {
  const id = normalizeId(providerId, model);
  return loadPricingEntries().find(e => e.id === id) || null;
}

/** Creates or updates the stored entry for the exact pair. Duplicates are
 *  handled as an explicit UPDATE (clear upsert semantics). */
export function upsertPricing(
  providerId: string, model: string, inputPerM: number, outputPerM: number, enabled = true,
): { entry: ModelPricingEntry; created: boolean } {
  validatePrice(inputPerM, 'inputPerM');
  validatePrice(outputPerM, 'outputPerM');
  if (!providerId.trim()) throw new PricingValidationError('providerId must be a non-empty string');
  if (!model.trim()) throw new PricingValidationError('model must be a non-empty string');

  const entries = [...loadPricingEntries()];
  const id = normalizeId(providerId, model);
  const idx = entries.findIndex(e => e.id === id);
  if (idx >= 0) {
    const prev = entries[idx];
    const updated = normalizeEntry(providerId, model, inputPerM, outputPerM, {
      enabled,
      createdAt: prev.createdAt,
      updatedAt: Date.now(),
    });
    entries[idx] = updated;
    saveEntries(entries);
    console.log(`[PricingStore] Updated ${updated.id}: in=$${inputPerM}/1M out=$${outputPerM}/1M enabled=${enabled}`);
    return { entry: updated, created: false };
  }
  const entry = normalizeEntry(providerId, model, inputPerM, outputPerM, { enabled });
  entries.push(entry);
  saveEntries(entries);
  console.log(`[PricingStore] Added ${entry.id}: in=$${inputPerM}/1M out=$${outputPerM}/1M`);
  return { entry, created: true };
}

/** Enable/disable without deleting. Returns null when the id is unknown. */
export function setPricingEnabled(id: string, enabled: boolean): ModelPricingEntry | null {
  const entries = [...loadPricingEntries()];
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], enabled, updatedAt: Date.now() };
  saveEntries(entries);
  console.log(`[PricingStore] ${enabled ? 'Enabled' : 'Disabled'} pricing ${id}`);
  return entries[idx];
}

/** Removes ONLY the pricing configuration — historical usage/costs untouched.
 *  Returns false when the id is unknown. */
export function deletePricing(id: string): boolean {
  const entries = loadPricingEntries();
  const next = entries.filter(e => e.id !== id);
  if (next.length === entries.length) return false;
  saveEntries(next);
  console.log(`[PricingStore] Deleted pricing config ${id} (usage history untouched)`);
  return true;
}
