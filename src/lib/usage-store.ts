import * as fs from 'fs';
import * as path from 'path';
import { computeCostSplit, getPricingStatus } from './pricing';
import { DATA_DIR } from './data-dir';

const STORAGE_FILE = path.join(DATA_DIR, 'usage-records.json');

export interface UsageRecord {
  timestamp: number;
  provider: string;
  model: string;
  status: 'success' | 'error' | 'blocked';
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  apiKey: string | null;
  httpStatus?: number | null;
  errorMessage?: string | null;
  requestId?: string | null;
  apiKeyMasked?: string | null;
  /**
   * Estimated cost in USD for THIS request only, computed from the exact
   * provider + model price and THIS request's tokens. `null` when the model
   * price is unknown — the dashboard renders that as N/A, never as $0.
   */
  costUsd?: number | null;
  /** Input-dimension portion of costUsd (promptTokens × input rate). */
  inputCostUsd?: number | null;
  /** Output-dimension portion of costUsd (completionTokens × output rate). */
  outputCostUsd?: number | null;
  /* COMBO attribution — record IDs only, never credentials:
   *  comboId        combo_... that pinned the routing (null when n/a)
   *  providerKeyId  key_... of the pinned provider credential (null when the
   *                 combo uses the provider's whole rotation pool). */
  comboId?: string | null;
  providerKeyId?: string | null;
}

export interface UsageQuery {
  provider?: string;
  model?: string;
  status?: string;
  from?: number;
  to?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProviderBreakdown {
  requests: number;
  success: number;
  failed: number;
  blocked: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  /** USD estimate, summed from per-request costs. */
  costUsd: number | null;
  /** Input/output portions of costUsd (null when no known-priced records). */
  inputCostUsd: number | null;
  outputCostUsd: number | null;
}

export interface ModelBreakdown {
  requests: number;
  success: number;
  failed: number;
  blocked: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  providers: string[];
  /** Exact provider/model identity represented by this row. */
  provider?: string;
  model?: string;
  /** USD estimate, summed from per-request costs (null when all wrong/unknown). */
  costUsd: number | null;
  /** Input/output portions of costUsd (null when no known-priced records). */
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  /** Pricing availability for this exact provider/model pair. */
  pricingStatus: 'known' | 'free' | 'unknown';
}

const records: UsageRecord[] = [];
/* Request ids already flushed to disk in THIS process lifetime. The dedup in
 * recordUsage() must consult this too — otherwise a record that was flushed
 * and then re-submitted (stream end racing the 5s flush timer) would be
 * appended a second time. Populated during flushToDisk(); bounded by only
 * keeping ids of records flushed since process start. */
const flushedRequestIds = new Set<string>();
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 5000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (records.length > 0 && Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
      flushToDisk();
    }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function readPersistedRecords(): UsageRecord[] {
  if (!fs.existsSync(STORAGE_FILE)) return [];
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as UsageRecord[];
    console.error('[UsageStore] Persisted usage file has unexpected shape (expected array) — treating as empty');
    return [];
  } catch (err) {
    /* A corrupt usage file must NEVER be silently discarded: every silent
     * data loss here shows up as a dashboard frozen at stale numbers.
     * Quarantine the unreadable file so the (valid) history stays on disk
     * and can be recovered manually, then continue with an empty file. */
    const quarantine = `${STORAGE_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(STORAGE_FILE, quarantine); } catch { /* best effort */ }
    console.error(`[UsageStore] Persisted usage file was corrupt — quarantined to ${quarantine}:`, err);
    return [];
  }
}

function flushToDisk(): void {
  try {
    const dir = path.dirname(STORAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readPersistedRecords();
    for (const r of existing) {
      if (typeof r.requestId === 'string' && r.requestId) flushedRequestIds.add(r.requestId);
    }
    /* Drop buffer entries that raced a previous flush (already persisted). */
    const pending = records.filter(r => !(r.requestId && flushedRequestIds.has(r.requestId)));
    const all = existing.concat(pending);
    /* Atomic replace: write to a temp file in the same directory, then rename.
     * A crash/power-cut mid-write can never leave a half-written (corrupt)
     * usage file behind — which previously zeroed the visible history. */
    const tmp = path.join(dir, `.usage-records.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
    fs.renameSync(tmp, STORAGE_FILE);
    for (const r of pending) {
      if (r.requestId) flushedRequestIds.add(r.requestId);
    }
    records.length = 0;
    lastFlush = Date.now();
  } catch (err) {
    /* Keep the buffered records — the next timer tick retries the flush.
     * Never pretend the data was persisted when it was not. */
    console.error('[UsageStore] Failed to flush (records retained for retry):', err);
  }
}

export function recordUsage(rec: UsageRecord): void {
  const requestId = typeof rec.requestId === 'string' ? rec.requestId.trim() : '';
  /* Anti double-count guard: a single request lifecycle can invoke this more
     than once (e.g. a stream 'end' plus an error/close path). We dedup against
     the in-memory buffer AND the ids already flushed in this process (a stream
     end callback can legitimately race the 5s flush timer). Request ids are
     boot-prefixed (server.ts genReqId), so they are unique across restarts and
     comparing against persisted ids cannot drop a brand-new request. */
  if (requestId && (flushedRequestIds.has(requestId) || records.some(existing => existing.requestId === requestId))) return;
  /* Compute the per-request cost ONCE at record time (input/output split +
     total) so logs and dashboard aggregates always agree (single source of
     truth, no re-derivation drift). */
  const split = computeCostSplit(rec.provider, rec.model, rec.promptTokens, rec.completionTokens);
  const stored: UsageRecord = {
    ...rec,
    costUsd: split ? split.totalCostUsd : null,
    inputCostUsd: split ? split.inputCostUsd : null,
    outputCostUsd: split ? split.outputCostUsd : null,
  };
  records.push(stored);
  ensureTimer();
}

export function flushUsage(): void {
  if (records.length > 0) flushToDisk();
}

/**
 * Read-only cost enrichment (never mutates stored data):
 * (full contract documented on `loadUsageRecords` — applies to the in-memory
 * buffer identically, so a pricing entry saved via the admin UI covers ALL
 * unpriced records for which tokens are known IMMEDIATELY, without waiting
 * for the 5 s flush; aggregation across buffer and file never disagrees.)
 */
function applyCostBackfill(recs: UsageRecord[]): UsageRecord[] {
  return recs.map(r => {
    if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
      const hasSplit =
        typeof r.inputCostUsd === 'number' && Number.isFinite(r.inputCostUsd) &&
        typeof r.outputCostUsd === 'number' && Number.isFinite(r.outputCostUsd);
      if (hasSplit) return r;
      const split = computeCostSplit(r.provider, r.model, r.promptTokens, r.completionTokens);
      if (!split) return r;
      const tolerance = Math.max(1e-12, Math.abs(r.costUsd) * 1e-9);
      if (Math.abs(split.totalCostUsd - r.costUsd) <= tolerance) {
        return { ...r, inputCostUsd: split.inputCostUsd, outputCostUsd: split.outputCostUsd };
      }
      return r;
    }
    const split = computeCostSplit(r.provider, r.model, r.promptTokens, r.completionTokens);
    if (!split) return { ...r, costUsd: null, inputCostUsd: null, outputCostUsd: null };
    return {
      ...r,
      costUsd: split.totalCostUsd,
      inputCostUsd: split.inputCostUsd,
      outputCostUsd: split.outputCostUsd,
    };
  });
}

export function loadUsageRecords(): UsageRecord[] {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return [];
    const recs = readPersistedRecords();
    if (recs.length === 0) return [];
    /* Safe historical backfill (read-only, in-memory):
         A record is (re)priced here ONLY when it carries no usable cost yet:
           - `costUsd === undefined` → written before the cost feature existed;
           - `costUsd === null`      → the model price was unknown at request
                                       time (e.g. `gorouter/claude-opus-4-8`
                                       before it was registered).
         In both cases the per-request tokens are already persisted, so the cost
         is recomputed from those SAME tokens with current pricing — tokens,
         provider, model and timestamp are never invented or modified.
         A record that already carries a finite numeric `costUsd` is the
         immutable source of truth captured at request time and is returned
         verbatim, even if current pricing would yield a different value.
          Still-unpriced models resolve to `null` here, never a fake $0.
          The enrichment is not written back, so the on-disk data is untouched.
          Idempotent: once a record carries a finite costUsd it is returned
          verbatim on every subsequent load.

          Split backfill for legacy records that carry ONLY a numeric costUsd:
          when the stored tokens + CURRENT pricing reproduce EXACTLY the stored
          total (within float tolerance), the missing input/output split is
          filled — the stored total itself is NEVER modified. A mismatch
          (pricing changed since capture) or missing tokens leaves the split
          untouched rather than fabricating values. */
      return applyCostBackfill(recs);
  } catch (err) {
    /* Never silently swallow load failures — a frozen dashboard with no
     * visible cause is worse than an explicit error. */
    console.error('[UsageStore] Failed to load usage records:', err);
    return [];
  }
}

/** Atomically replaces the persisted usage records (temp file + rename). */
export function saveUsageRecords(inRecords: UsageRecord[]): void {
  const dir = path.dirname(STORAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.usage-records.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(inRecords, null, 2), 'utf-8');
  fs.renameSync(tmp, STORAGE_FILE);
  // Clear the in-memory buffer so getAllUsage() does not duplicate records.
  records.length = 0;
  /* The restore/replace invalidates this process's view of persisted ids:
   * rebuild from the new file so the dedup guard stays accurate. */
  flushedRequestIds.clear();
  for (const r of inRecords) {
    if (typeof r.requestId === 'string' && r.requestId) flushedRequestIds.add(r.requestId);
  }
  lastFlush = Date.now();
}

export function getAllUsage(): UsageRecord[] {
  /* The read-only cost backfill applies to the in-memory buffer exactly like
   * it does to persisted records: a pricing entry created AFTER a request was
   * already buffered takes effect immediately, so every aggregation
   * (dashboard, provider/model breakdown, logs API) stays consistent no
   * matter whether a row has flushed yet. The buffered store itself is never
   * mutated — enrichment happens only on the returned copies. */
  return loadUsageRecords().concat(applyCostBackfill(records));
}

function matchesQuery(r: UsageRecord, q: UsageQuery): boolean {
  if (q.provider && r.provider !== q.provider) return false;
  if (q.model && r.model !== q.model) return false;
  if (q.status && r.status !== q.status) return false;
  if (q.from !== undefined && r.timestamp < q.from) return false;
  if (q.to !== undefined && r.timestamp > q.to) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = [
      r.requestId,
      r.errorMessage,
      r.apiKeyMasked,
      r.provider,
      r.model,
      r.comboId,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function queryUsage(q: UsageQuery = {}): { total: number; records: UsageRecord[] } {
  const all = getAllUsage();
  const filtered = all.filter(r => matchesQuery(r, q));
  // Sort newest-first (DESC by timestamp). Pagination MUST happen AFTER
  // sorting, otherwise the newest record can land on page 2 when older
  // flushed records precede the in-memory buffer. A stable comparator is
  // used so records with equal timestamps keep their insertion order.
  filtered.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return 0;
  });
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 100;
  return {
    total: filtered.length,
    records: filtered.slice(offset, offset + limit),
  };
}

/**
 * Returns the record at `index` using the SAME ordering as `queryUsage()`
 * (filtered DESC by timestamp), so a row's `data-index` (computed as
 * `offsetBase + i` against the current `/admin/logs` result) resolves to
 * the exact same record via the detail endpoint. Optional `q` carries the
 * active UI filters so filtered views resolve consistently.
 */
export function getUsageRecordByIndex(index: number, q: UsageQuery = {}): UsageRecord | undefined {
  const result = queryUsage({ ...q, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  if (index < 0 || index >= result.records.length) return undefined;
  return result.records[index];
}

export function getUsageAggregates(): {
  totalRequests: number;
  totalSuccess: number;
  totalFailed: number;
  totalBlocked: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  totalCostUsd: number | null;
  totalInputCostUsd: number | null;
  totalOutputCostUsd: number | null;
} {
  const all = getAllUsage();
  const totalRequests = all.length;
  const totalSuccess = all.filter(r => r.status === 'success').length;
  const totalFailed = all.filter(r => r.status === 'error').length;
  const totalBlocked = all.filter(r => r.status === 'blocked').length;
  const totalPromptTokens = all.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
  const totalCompletionTokens = all.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
  const totalTokens = all.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
  const totalLatency = all.reduce((s, r) => s + r.latencyMs, 0);
  const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;
  return {
    totalRequests, totalSuccess, totalFailed, totalBlocked,
    totalPromptTokens, totalCompletionTokens, totalTokens, avgLatencyMs,
    /* Sum ONLY known per-request costs; unknown prices never count as $0. */
    totalCostUsd: sumCosts(all),
    totalInputCostUsd: sumCostField(all, 'inputCostUsd'),
    totalOutputCostUsd: sumCostField(all, 'outputCostUsd'),
  };
}

/** Sums known per-request costUsd values; returns null when none are known. */
function sumCosts(all: UsageRecord[]): number | null {
  let total = 0;
  let any = false;
  for (const r of all) {
    if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
      total += r.costUsd;
      any = true;
    }
  }
  return any ? total : null;
}

/** Sums a known per-request cost field ('inputCostUsd'/'outputCostUsd'). */
function sumCostField(all: UsageRecord[], field: 'inputCostUsd' | 'outputCostUsd'): number | null {
  let total = 0;
  let any = false;
  for (const r of all) {
    const v = r[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

export function getUsageByProvider(): Record<string, ProviderBreakdown> {
  const all = getAllUsage();
  const result: Record<string, ProviderBreakdown> = {};
  for (const r of all) {
    if (!result[r.provider]) {
      result[r.provider] = { requests: 0, success: 0, failed: 0, blocked: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: 0, costUsd: null, inputCostUsd: null, outputCostUsd: null };
    }
    const b = result[r.provider];
    b.requests++;
    if (r.status === 'success') b.success++;
    else if (r.status === 'error') b.failed++;
    else if (r.status === 'blocked') b.blocked++;
    b.promptTokens += r.promptTokens ?? 0;
    b.completionTokens += r.completionTokens ?? 0;
    b.totalTokens += r.totalTokens ?? 0;
    accumulateCost(b, r);
  }
  for (const id of Object.keys(result)) {
    result[id].avgLatencyMs = result[id].requests > 0 ? Math.round(sumLatencyForProvider(all, id) / result[id].requests) : 0;
  }
  return result;
}

/** Adds a record's known cost values into a breakdown accumulator. */
function accumulateCost(
  b: { costUsd: number | null; inputCostUsd: number | null; outputCostUsd: number | null },
  r: UsageRecord,
): void {
  const c = r.costUsd;
  if (typeof c === 'number' && Number.isFinite(c)) {
    b.costUsd = (b.costUsd ?? 0) + c;
  }
  for (const field of ['inputCostUsd', 'outputCostUsd'] as const) {
    const v = r[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      b[field] = (b[field] ?? 0) + v;
    }
  }
}

function sumLatencyForProvider(all: UsageRecord[], provider: string): number {
  return all.filter(r => r.provider === provider).reduce((s, r) => s + r.latencyMs, 0);
}

export function getUsageByModel(): Record<string, ModelBreakdown> {
  const all = getAllUsage();
  const result: Record<string, ModelBreakdown> = {};
  for (const r of all) {
    const key = `${r.provider}/${r.model}`;
    if (!result[key]) {
      result[key] = { requests: 0, success: 0, failed: 0, blocked: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: 0, providers: [], provider: r.provider, model: r.model, costUsd: null, inputCostUsd: null, outputCostUsd: null, pricingStatus: 'unknown' };
    }
    const b = result[key];
    b.requests++;
    if (r.status === 'success') b.success++;
    else if (r.status === 'error') b.failed++;
    else if (r.status === 'blocked') b.blocked++;
    b.promptTokens += r.promptTokens ?? 0;
    b.completionTokens += r.completionTokens ?? 0;
    b.totalTokens += r.totalTokens ?? 0;
    accumulateCost(b, r);
    if (!b.providers.includes(r.provider)) b.providers.push(r.provider);
  }
  for (const id of Object.keys(result)) {
    const recs = all.filter(r => `${r.provider}/${r.model}` === id);
    result[id].avgLatencyMs = recs.length > 0 ? Math.round(recs.reduce((s, r) => s + r.latencyMs, 0) / recs.length) : 0;
    /* Pricing status is a property of the exact provider/model pair — rows are
       already keyed by `provider/model`, so the two can never be mixed. */
    const first = recs[0];
    result[id].pricingStatus = getPricingStatus(first?.provider, first?.model);
  }
  return result;
}

process.on('exit', () => flushUsage());
process.on('SIGTERM', () => flushUsage());
process.on('SIGINT', () => { flushUsage(); process.exit(); });
