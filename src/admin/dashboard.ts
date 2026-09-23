/* ============================================================================
 * nvidia-api · Admin Dashboard frontend logic
 * ----------------------------------------------------------------------------
 * Vanilla TS (no external deps). Consumes the existing `/admin/*` JSON API plus
 * `/internal/*` diagnostics. All data is REAL backend data — no dummies,
 * no token estimation, no client-side fabrication.
 *
 * The file is intentionally organized as small render helpers + a single
 * App controller so each piece stays testable and the file does not become a
 * monolith.
 * ========================================================================== */

/* ----------------------------------------------------------------------------
 * Types — mirror backend response shapes (see src/routes/admin.ts + src/lib/usage-store.ts)
 * ------------------------------------------------------------------------- */

interface ModelRegistration {
  model: string;
  providerId: string;
  backendModel?: string;
  priority: number;
  enabled: boolean;
  protocol?: string;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

interface AdminProvider {
  id: string;
  name: string;
  enabled: boolean;
  models: ModelRegistration[];
  apiKeyCount?: number;
  /* Recovery cooldown status (GET /admin/providers). Present since the
   * provider-cooldown feature; optional so older payloads still render. */
  cooldown?: ProviderCooldownStatus;
  refreshCooldown?: { active: boolean; remainingMs: number; remainingSeconds: number; cooldownMs: number };
}

interface ProviderCooldownStatus {
  active: boolean;
  remainingMs: number;
  remainingSec: number;
  cooldownUntil: number | null;
  cooldownMs: number;
  lastFailureAt: number | null;
  lastStatus: number;
  lastError: string | null;
  cooldownCount: number;
}

/* Provider API key contracts (mirror src/lib/api-key-store.ts safe shape).
 * NOTE: raw API keys are NEVER part of any admin response. */
interface ApiKeyRecord {
  id: string;
  providerId: string;
  maskedKey: string;
  label?: string;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
}

interface ApiKeysResponse {
  providerId: string;
  keys: ApiKeyRecord[];
  envKeyCount: number;
  /** Sequential label suggestion computed server-side (current labels + persisted
   *  watermark, so deleted numbers are never reused). Plain text, no secrets. */
  suggestedLabel?: string;
}

/* Client API key contracts (mirror src/lib/client-key-store.ts safe shape +
 * GET /admin/client-keys response). The raw key appears ONLY in the create
 * response and is never persisted or displayed again. */
interface ClientKeyRecord {
  id: string;
  maskedKey: string;
  providerId: string;
  allowedModels: string[];
  label?: string;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  requestCount: number;
}

interface ClientKeyCatalog {
  providers: Array<{ id: string; name: string; models: string[] }>;
}

/* COMBO contracts (mirror src/lib/combo-store.ts safe shape + admin routes).
 * Only IDs + masked metadata cross the wire — never provider credentials. */
interface ComboRecord {
  id: string;
  clientKeyId: string;
  providerId: string;
  model: string;
  providerKeyId: string | null;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
  requestCount: number;
  lastUsedAt: number | null;
  clientKey: { id: string; maskedKey: string; label?: string; status: string } | null;
  providerName: string;
  providerKey: { id: string; maskedKey: string; label?: string; status: string } | null;
}

interface ComboCatalog {
  providers: Array<{
    id: string;
    name: string;
    models: string[];
    apiKeys: Array<{ id: string; maskedKey: string; label?: string }>;
  }>;
  clientKeys: ClientKeyRecord[];
}

/* Model pricing contracts (mirror src/lib/pricing-store.ts + admin route).
 * Price metadata only — no credentials involved. */
interface PricingEntry {
  id: string;
  providerId: string;
  model: string;
  inputPerM: number | null;
  outputPerM: number | null;
  currency: string;
  enabled?: boolean;
  source?: 'admin' | 'builtin';
  overridden?: boolean;
  updatedAt?: number;
}

interface PricingResponse {
  entries: PricingEntry[];
  builtin: PricingEntry[];
  disclaimer?: string;
}

interface UsageSummary {
  totalRequests: number;
  totalSuccess: number;
  totalFailed: number;
  totalBlocked: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  totalCostUsd?: number | null;
  totalInputCostUsd?: number | null;
  totalOutputCostUsd?: number | null;
}

interface ProviderBreakdown {
  requests: number;
  success: number;
  failed: number;
  blocked: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  costUsd?: number | null;
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
}

interface ModelBreakdown extends ProviderBreakdown {
  providers: string[];
  provider?: string;
  model?: string;
  /** 'known' → priced · 'free' → $0 · 'unknown' → N/A (never $0) */
  pricingStatus?: 'known' | 'free' | 'unknown';
}

interface UsageRecord {
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
  costUsd?: number | null;
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
  /* COMBO attribution (record ids only — never credentials). */
  comboId?: string | null;
  providerKeyId?: string | null;
}

interface LogsResponse {
  total: number;
  logs: UsageRecord[];
}

interface RecordsResponse {
  total: number;
  records: UsageRecord[];
}

/* Backup contracts (mirror src/lib/backup.ts) */
interface BackupInfo {
  backupId: string;
  createdAt: number;
  size: number;
  usageRecordCount: number;
  providerStateCount: number;
  version: number;
  valid: boolean;
  sourceVersion: string;
}

interface RestoreResult {
  backupId: string;
  restoredUsage: number;
  restoredProviders: number;
  preRestoreBackupId: string | null;
}

/* ----------------------------------------------------------------------------
 * API key management — stored in sessionStorage, never persisted to disk.
 * ------------------------------------------------------------------------- */

function getApiKey(): string {
  return sessionStorage.getItem('admin_api_key') || '';
}

function setApiKey(key: string): void {
  sessionStorage.setItem('admin_api_key', key);
}

function clearApiKey(): void {
  sessionStorage.removeItem('admin_api_key');
}

/* ----------------------------------------------------------------------------
 * API client (single fetch-based client using same-origin /admin/* and /internal/*)
 * No axios — the project has axios for the backend proxy but no frontend lib.
 * We do not duplicate the backend axios client on the frontend.
 * ------------------------------------------------------------------------- */

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

/** Normalizes ANY backend error body into a human-readable string.
 *  The backend uses two error envelope shapes:
 *    - Admin routes (4xx/5xx): `{ error: "message" }` (string)
 *    - /v1 + Fastify internals: `{ error: { message, type } }` (OpenAI-style)
 *  Non-JSON bodies (e.g. reverse-proxy HTML error pages) are also handled.
 *  This guarantees the UI never renders "[object Object]". */
function extractApiError(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const err = (parsed as Record<string, unknown>).error;
    if (typeof err === 'string' && err.trim()) return err;
    if (err && typeof err === 'object') {
      const obj = err as Record<string, unknown>;
      const msg = typeof obj.message === 'string' && obj.message.trim() ? obj.message : '';
      const type = typeof obj.type === 'string' && obj.type.trim() ? obj.type : '';
      if (msg && type) return `${msg} (${type})`;
      if (msg) return msg;
      if (type) return `${type} error`;
    }
    const message = (parsed as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof parsed === 'string' && parsed.trim()) {
    const snippet = parsed.trim().slice(0, 200);
    if (snippet === '[object Object]') return `HTTP ${status} — backend returned an unreadable error`;
    return `HTTP ${status} — ${snippet}`;
  }
  return `HTTP ${status}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const apiKey = getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (init?.headers) Object.assign(headers, init.headers);
    /* Content-Type is declared ONLY when a body is actually sent. A
     * body-less request bearing 'Content-Type: application/json' is rejected
     * by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY: "Body cannot be empty…")
     * BEFORE any route handler runs — this silently broke every DELETE in
     * the admin UI while GET/HEAD/POST/PATCH kept working. */
    const hasBody = init?.body !== undefined && init?.body !== null && init?.body !== '';
    const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
    if (hasBody && !hasContentType) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      cache: 'no-store',
      ...init,
      headers,
    });
    let parsed: any = null;
    const text = await res.text();
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (res.status === 401) {
      clearApiKey();
      showLogin();
      return { ok: false, status: 401, data: null, error: 'Unauthorized — invalid API key' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: extractApiError(parsed, res.status) };
    }
    return { ok: true, status: res.status, data: parsed as T, error: null };
  } catch (err: any) {
    return { ok: false, status: 0, data: null, error: err?.message || 'Network error' };
  }
}

async function apiJSON<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  /* Fastify rejects an empty body when the Content-Type is application/json
     (FST_ERR_CTP_EMPTY_JSON_BODY). For PATCH/POST/PUT we send `{}` by default
     so UI actions that take no parameters (e.g. POST /admin/backup) succeed
     without the caller worrying about payload plumbing. GET/DELETE send no body. */
  const methodUpper = method.toUpperCase();
  const sendsBody = methodUpper === 'PATCH' || methodUpper === 'POST' || methodUpper === 'PUT';
  const payload = body !== undefined ? body : (sendsBody ? {} : undefined);
  return api<T>(path, {
    method: methodUpper,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/**
 * Clipboard write with an explicit fallback for non-secure contexts:
 * when the dashboard is served over plain HTTP (no TLS / no localhost),
 * browsers expose NO `navigator.clipboard` at all, so the naive
 * `navigator.clipboard?.writeText(...)` silently does nothing. The raw key
 * copied here is ONLY the one-time creation value already rendered in the
 * result panel — it is never fetched from, or persisted on, the server,
 * localStorage, sessionStorage, or cookies for copy purposes.
 */
/* ── Client API Key form search rules (pure, DOM-free) ─────────────────────
 * Case-insensitive partial match shared by the provider picker and the model
 * filter — filtering is done purely over the data already loaded into the
 * browser (the registry catalog); no request per keystroke, and model IDs are
 * never rewritten or normalized — only compared (lowercased) for display. */
export function matchesSearchFilter(query: string, value: string | null | undefined): boolean {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  return String(value ?? '').toLowerCase().includes(q);
}

export function filterProviderCatalog<T extends { id: string; name: string }>(providers: T[], query: string): T[] {
  return providers.filter(p => matchesSearchFilter(query, p.id) || matchesSearchFilter(query, p.name));
}

export function filterModelIds(models: string[], query: string): string[] {
  const out: string[] = [];
  for (const m of models) if (matchesSearchFilter(query, m)) out.push(m);
  return out;
}

/* ---------------- API key label auto-numbering (UI suggestion only) --------
 * The backend stays the source of truth for stored labels; these pure helpers
 * implement "highest number ever used + 1" from the CURRENT label set (the
 * persisted watermark in provider-api-keys.json additionally protects numbers
 * of deleted keys server-side). Existing labels are never rewritten. */

const KEY_LABEL_NUM = /^(.*?)\s(\d+)$/;

/** Next "<base> N" suggestion from the given labels (may contain undefined). */
export function nextKeyLabelSuggestion(labels: Array<string | undefined>): string {
  let base = '';
  let max = 0;
  for (const raw of labels) {
    const m = (raw || '').trim().match(KEY_LABEL_NUM);
    if (!m) continue;
    const b = (m[1] || '').trim();
    const n = Number(m[2]);
    if (!b || !Number.isFinite(n)) continue;
    if (n > max || (n === max && (!base || b.length > base.length))) { base = b; max = n; }
  }
  return `${base || 'Production Key'} ${max + 1}`;
}

/** Make a suggested label unique against the taken set without renumbering
 *  anything existing (handles the rare add-race where two forms were opened
 *  against the same suggestion). */
export function bumpKeyLabel(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  const m = label.match(KEY_LABEL_NUM);
  let base = m ? (m[1] || '').trim() : label.trim();
  let n = m ? Number(m[2]) : 1;
  let candidate = '';
  do { n += 1; candidate = `${base} ${n}`; } while (taken.has(candidate));
  return candidate;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission denied / document not focused — fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok === true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Login overlay — the dashboard requires an API key for every JSON request.
 * The key is validated with a lightweight ping before the dashboard loads.
 * ------------------------------------------------------------------------- */

function showLogin(message?: string): void {
  const screen = document.getElementById('login-screen');
  if (!screen) return;
  screen.classList.remove('is-hidden');
  const err = document.getElementById('login-error');
  if (err) {
    if (message) {
      err.textContent = message;
      err.classList.remove('is-hidden');
    } else {
      err.classList.add('is-hidden');
    }
  }
  const input = document.getElementById('login-key') as HTMLInputElement | null;
  if (input) input.focus();
}

function hideLogin(): void {
  const screen = document.getElementById('login-screen');
  if (screen) screen.classList.add('is-hidden');
}

function wireLoginForm(): void {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('login-key') as HTMLInputElement | null;
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const err = document.getElementById('login-error');
    const key = (input?.value || '').trim();
    if (!key) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
    if (err) err.classList.add('is-hidden');
    setApiKey(key);
    /* Ping a cheap JSON endpoint; a 401 means the key is wrong. */
    const r = await apiJSON<unknown>('GET', '/admin/usage');
    if (r.ok) {
      hideLogin();
      /* If the dashboard is already mounted, reload it with the new key. */
      if (typeof window !== 'undefined') window.location.reload();
    } else {
      clearApiKey();
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
      if (err) {
        err.textContent = r.error && r.error.includes('401')
          ? 'Invalid API key. Please check and try again.'
          : `Verification failed: ${r.error || 'unknown error'}`;
        err.classList.remove('is-hidden');
      }
      input?.focus();
      input?.select();
    }
  });
}

/* ----------------------------------------------------------------------------
 * Formatting helpers — every value displayed comes from the backend verbatim.
 * Null/unknown values render as `—`, never fabricated as 0.
 * ------------------------------------------------------------------------- */

const DASH = '—';

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  return n.toLocaleString();
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  return n.toLocaleString();
}

function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  if (v === 0) return '$0.000';
  const abs = Math.abs(v);
  /* Keep at least thousandths for normal micro-costs, while allowing more
     digits when a legitimate non-zero value is smaller than one micro-dollar.
     No rounding happens before this UI boundary. */
  const options: Intl.NumberFormatOptions = abs >= 1
    ? { minimumFractionDigits: 3, maximumFractionDigits: 3 }
    : { minimumFractionDigits: 3, maximumFractionDigits: 12 };
  let formatted = v.toLocaleString('en-US', options);
  if (Number(formatted.replace(/,/g, '')) === 0) {
    formatted = Math.abs(v) < 0.000000000001 ? v.toExponential(6) : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 12 });
  }
  return `$${formatted}`;
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return DASH;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/* Local datetime string (for <input type=datetime-local>) from epoch ms */
function toLocalDatetimeInput(epochMs?: number): string {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInput(value: string): number | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return isNaN(t) ? undefined : t;
}

/* ----------------------------------------------------------------------------
 * Status / HTTP badges
 * ------------------------------------------------------------------------- */

function statusBadge(status: string): string {
  const cls = status === 'success' ? 'badge--success' : status === 'error' ? 'badge--error' : status === 'blocked' ? 'badge--blocked' : '';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function httpBadge(httpStatus: number | null | undefined): string {
  if (httpStatus === null || httpStatus === undefined) {
    return `<span class="badge badge--http-null">—</span>`;
  }
  let cls = 'badge--http-null';
  if (httpStatus >= 200 && httpStatus < 300) cls = 'badge--http-2xx';
  else if (httpStatus >= 400 && httpStatus < 500) cls = 'badge--http-4xx';
  else if (httpStatus >= 500) cls = 'badge--http-5xx';
  return `<span class="badge ${cls}">${esc(httpStatus)}</span>`;
}

/* ============================================================================
 * Components — small, focused render functions.
 *
 * Pattern: every `renderXHTML(...)` is a PURE function returning an HTML
 * string. The wrapper `renderX(target, ...)` sets `data-state` then assigns
 * the string to `target.innerHTML`, and afterwards wires up any interactive
 * children via `querySelectorAll`. Keeping the string builders pure lets the
 * tests assert on output without a DOM environment; the wrappers' side effects
 * only matter to the live browser.
 * ========================================================================== */

/* ----------------------------- UsageSummary ------------------------------ */
function summaryCards(summary: UsageSummary): Array<{ label: string; value: string; cls?: string }> {
  return [
    { label: 'Total Requests',    value: fmtNum(summary.totalRequests) },
    { label: 'Successful',        value: fmtNum(summary.totalSuccess),        cls: 'summary-card--success' },
    { label: 'Errors',            value: fmtNum(summary.totalFailed),         cls: 'summary-card--error' },
    { label: 'Blocked',           value: fmtNum(summary.totalBlocked),        cls: 'summary-card--blocked' },
    { label: 'Prompt Tokens',     value: fmtTokens(summary.totalPromptTokens),     cls: 'summary-card--tokens' },
    { label: 'Completion Tokens', value: fmtTokens(summary.totalCompletionTokens), cls: 'summary-card--tokens' },
    { label: 'Total Tokens',      value: fmtTokens(summary.totalTokens),     cls: 'summary-card--tokens' },
    { label: 'Est. Cost (Total)', value: fmtCost(summary.totalCostUsd),      cls: 'summary-card--cost' },
    { label: 'Avg Latency',       value: fmtLatency(summary.avgLatencyMs) },
  ];
}

function renderUsageSummaryHTML(summary: UsageSummary): string {
  return summaryCards(summary).map(c => `
    <div class="summary-card ${c.cls || ''}">
      <span class="summary-card__label">${esc(c.label)}</span>
      <span class="summary-card__value">${esc(c.value)}</span>
    </div>
  `).join('');
}

function renderUsageSummary(target: HTMLElement, summary: UsageSummary): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderUsageSummaryHTML(summary);
}

function renderEmptyHTML(message: string, isError = false): string {
  return `<div class="${isError ? 'state-error' : 'state-empty'}">${esc(message)}</div>`;
}

function renderEmpty(target: HTMLElement, message: string, isError = false): void {
  target.setAttribute('data-state', isError ? 'error' : 'empty');
  target.innerHTML = renderEmptyHTML(message, isError);
}

/* ----------------------------- ProviderCard -------------------------------- */
/* Per-provider request totals (real data from /admin/usage/providers). */
let providerRequestsCache: Record<string, { requests: number }> = {};

/** Formats a live cooldown countdown as `2m 45s` / `45s` / `0s`. */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function renderProviderCardHTML(p: AdminProvider): string {
  const enabledCount = p.models.filter(m => m.enabled).length;
  const badge = p.enabled
    ? `<span class="badge badge--on">ENABLED</span>`
    : `<span class="badge badge--off">DISABLED</span>`;
  /* Recovery cooldown badge (live countdown via data-cooldown-until). */
  const cd = p.cooldown;
  const cooldownBadge = cd?.active && cd.cooldownUntil
    ? `<span class="badge badge--cooldown" data-cooldown-until="${cd.cooldownUntil}"
        title="Provider failed and is in its ${Math.round(cd.cooldownMs / 1000)}s recovery cooldown; requests fail fast until it expires.${cd.lastError ? ` Last error: ${esc(cd.lastError)}` : ''}">COOLDOWN ${esc(fmtCountdown(cd.remainingMs))}</span>`
    : '';
  const cooldownHint = cd?.active && cd.cooldownUntil
    ? `<p class="card__hint card__hint--cooldown">⏳ Recovery cooldown — retry paused for <span data-cooldown-until="${cd.cooldownUntil}">${esc(fmtCountdown(cd.remainingMs))}</span> (attempt again automatically after that; other providers unaffected${cd.lastError ? ` · last error: ${esc(cd.lastError)}` : ''})</p>`
    : '';
  const btnClass = p.enabled ? 'btn--danger' : 'btn--success';
  const btnLabel = p.enabled ? 'Disable' : 'Enable';
  /* Real request count from usage aggregation — never fabricated. */
  const requests = providerRequestsCache[p.id]?.requests;
  const stat = (value: string | number, label: string, icon: string, green = false) => `
    <div class="provider-stat">
      <span class="provider-stat__icon${green ? ' provider-stat__icon--green' : ''}" aria-hidden="true">${icon}</span>
      <span class="provider-stat__value">${esc(String(value))}</span>
      <span class="provider-stat__label">${esc(label)}</span>
    </div>`;
  const cubeIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
  const keyIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
  const boltIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
  const modelsBlock = p.models.length > 0
    ? `<button type="button" class="provider-card__models-toggle" data-models-toggle="${esc(p.id)}">▾ ${p.models.length} models</button>
       <ul class="provider-card__models" hidden>
         ${p.models.map(m => `
           <li class="provider-card__model ${m.enabled ? '' : 'is-off'}">
             <span class="provider-card__model-id">${esc(m.model)}</span>
             <span class="provider-card__model-meta">p=${m.priority}${m.enabled ? '' : ' · off'}${m.backendModel && m.backendModel !== m.model ? ` → ${esc(m.backendModel)}` : ''}</span>
           </li>
         `).join('')}
       </ul>`
    : `<span class="provider-card__model-id cell-dim">no models registered</span>`;
  return `
    <div class="provider-card${p.enabled ? '' : ' is-disabled'}" data-provider-id="${esc(p.id)}" data-provider-search="${esc(`${p.name} ${p.id}`.toLowerCase())}">
      <div class="provider-card__header">
        <div class="provider-card__identity">
          <span class="provider-card__avatar" aria-hidden="true">${esc(p.name.charAt(0))}</span>
          <div>
            <h3 class="provider-card__name">${esc(p.name)}</h3>
            <div class="provider-card__id">id: ${esc(p.id)}</div>
          </div>
        </div>
        <div class="provider-card__badges">${cooldownBadge}${badge}</div>
      </div>
      <div class="provider-card__meta">
        ${stat(p.models.length, 'Models', cubeIcon)}
        ${stat(p.apiKeyCount ?? 0, 'API Keys', keyIcon)}
        ${stat(typeof requests === 'number' ? requests : '—', 'Requests', boltIcon, true)}
      </div>
      <p class="card__hint">${enabledCount} of ${p.models.length} models routable</p>
      ${cooldownHint}
      <div class="provider-card__actions">
        <button type="button" class="btn btn--ghost btn--xs" data-manage-keys="${esc(p.id)}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          Manage API Keys
        </button>
        <button type="button" class="btn btn--xs ${btnClass}" data-toggle="${esc(p.id)}" data-enabled="${p.enabled ? 'false' : 'true'}">${btnLabel}</button>
        <span style="margin-left:auto;">${modelsBlock}</span>
      </div>
    </div>`;
}

/* Live countdown ticker for provider recovery cooldowns. Renders the remaining
 * time inside every `[data-cooldown-until]` element once per second. Started
 * lazily (and only in a browser) when a cooling provider card is rendered;
 * stops itself when no cooldown element remains. Display only — expiry NEVER
 * triggers a data refetch (Provider Management refreshes manually). */
let cooldownTickerTimer: ReturnType<typeof setInterval> | null = null;

function fmtCountdownAttr(el: HTMLElement): string {
  const until = Number(el.dataset.cooldownUntil || '0');
  if (!Number.isFinite(until)) return '—';
  return fmtCountdown(until - Date.now());
}

function tickCooldownCountdowns(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-cooldown-until]'));
  if (els.length === 0) {
    if (cooldownTickerTimer !== null) { clearInterval(cooldownTickerTimer); cooldownTickerTimer = null; }
    return;
  }
  let expired = false;
  for (const el of els) {
    const until = Number(el.dataset.cooldownUntil || '0');
    const remaining = until - Date.now();
    if (remaining > 0) {
      el.textContent = fmtCountdown(remaining);
    } else {
      el.textContent = '0s';
      expired = true;
    }
  }
  /* Cooldown expiry is DISPLAY ONLY — the card state is never refetched
     automatically here; the operator presses Refresh (Provider Management is
     manual-refresh only, no polling). */
  if (expired) {
    document.querySelectorAll<HTMLElement>('.card__hint--cooldown [data-cooldown-until]').forEach(el => {
      if (el.textContent === '0s') el.textContent = '0s · press Refresh';
    });
  }
}

function ensureCooldownTicker(): void {
  if (typeof document === 'undefined') return;
  if (cooldownTickerTimer !== null) return;
  cooldownTickerTimer = setInterval(tickCooldownCountdowns, 1000);
}

/** Builds the card HTML into `target` and wires up the Enable/Disable + models
 *  toggle buttons. The onToggle callback is the only side effect. */
function renderProviderCard(target: HTMLElement, p: AdminProvider, onToggle: (id: string, enabled: boolean) => void): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderProviderCardHTML(p);
  /* Wire up Enable/Disable. The card declares the *next* enabled state for us. */
  const toggleBtn = target.querySelector<HTMLButtonElement>(`[data-toggle="${CSS.escape(p.id)}"]`);
  toggleBtn?.addEventListener('click', () => {
    const next = toggleBtn.dataset.enabled !== 'false';
    onToggle(p.id, next);
  });
  /* Wire up models list toggle. */
  const modelsToggle = target.querySelector<HTMLButtonElement>(`[data-models-toggle="${CSS.escape(p.id)}"]`);
  const modelsList = target.querySelector<HTMLElement>('.provider-card__models');
  modelsToggle?.addEventListener('click', () => {
    if (!modelsList) return;
    modelsList.hidden = !modelsList.hidden;
    modelsToggle.textContent = modelsList.hidden
      ? `▾ ${p.models.length} models`
      : `▴ ${p.models.length} models`;
  });
}

/** Renders a list of provider cards into a container, wiring each. */
function renderProviderCards(target: HTMLElement, providers: AdminProvider[], onToggle: (id: string, enabled: boolean) => void): void {
  target.setAttribute('data-state', 'loaded');
  if (providers.length === 0) {
    renderEmpty(target, 'No providers registered.');
    return;
  }
  /* Build a single HTML blob first (fast), then walk with querySelectorAll to attach listeners. */
  target.innerHTML = providers.map(renderProviderCardHTML).join('');
  /* Start the live cooldown countdown when any card is cooling down. */
  if (target.querySelector('[data-cooldown-until]')) ensureCooldownTicker();
  /* Enable / Disable buttons */
  target.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggle || '';
      const next = btn.dataset.enabled !== 'false';
      onToggle(id, next);
    });
  });
  /* Manage API Keys buttons */
  target.querySelectorAll<HTMLButtonElement>('[data-manage-keys]').forEach(btn => {
    btn.addEventListener('click', () => {
      openApiKeysModal(btn.dataset.manageKeys || '');
    });
  });
  /* Models toggle buttons */
  target.querySelectorAll<HTMLButtonElement>('[data-models-toggle]').forEach(btn => {
    const card = btn.closest('.provider-card');
    const list = card?.querySelector<HTMLElement>('.provider-card__models');
    btn.addEventListener('click', () => {
      if (!list) return;
      list.hidden = !list.hidden;
      btn.textContent = list.hidden
        ? `▾ ${list.children.length} models`
        : `▴ ${list.children.length} models`;
    });
  });
}

/* ----------------------- Provider API Keys management -----------------------
 * Modal flow: Provider card → "Manage API Keys" → list (masked only) with
 * Add / Enable / Disable / Delete. Raw API keys are NEVER rendered, logged or
 * stored client-side; the <input> uses type="password" and is cleared after
 * save. Counts refresh from the backend after every mutation. */

let appRef: AdminApp | null = null;
let apiKeysProviderId = '';

function providerNameFor(providerId: string): string {
  const p = appRef?.['providersCache']?.find((x: AdminProvider) => x.id === providerId);
  return p ? `${p.name} (${p.id})` : providerId;
}

async function openApiKeysModal(providerId: string): Promise<void> {
  if (!appRef) return;
  apiKeysProviderId = providerId;
  appRef.elts.apikeysTitle.textContent = `${providerNameFor(providerId)} — API Keys`;
  appRef.elts.apikeysModal.classList.remove('is-hidden');
  appRef.elts.apikeysBody.setAttribute('data-state', 'loading');
  appRef.elts.apikeysBody.innerHTML = `
    <div class="skeleton skeleton--row" aria-hidden="true"></div>
    <div class="skeleton skeleton--row" aria-hidden="true"></div>
  `;
  const r = await apiJSON<ApiKeysResponse>(
    'GET',
    `/admin/providers/${encodeURIComponent(providerId)}/api-keys`,
  );
  /* The user may have closed the modal while the request was in flight. */
  if (appRef.elts.apikeysModal.classList.contains('is-hidden')) return;
  if (!r.ok || !r.data) {
    appRef.elts.apikeysBody.setAttribute('data-state', 'error');
    appRef.elts.apikeysBody.innerHTML =
      `<div class="state-error">Failed to load API keys: ${esc(r.error || 'unknown error')}</div>`;
    return;
  }
  renderApiKeysContent(r.data);
}

/** Renders the full modal body: summary, selection toolbar, add-form, key rows. */
function renderApiKeysContent(data: ApiKeysResponse): void {
  if (!appRef) return;
  const body = appRef.elts.apikeysBody;
  body.setAttribute('data-state', 'loaded');
  const rows = data.keys.length > 0
    ? data.keys.map(k => `
      <li class="apikey-row ${k.status === 'disabled' ? 'is-disabled' : ''}" data-key-id="${esc(k.id)}" data-key-label="${esc(k.label || '')}">
        <label class="apikey-row__select" title="Select key">
          <input type="checkbox" data-key-select="${esc(k.id)}" aria-label="Select API key ${esc(k.maskedKey)}" />
        </label>
        <span class="apikey-row__key">${esc(k.maskedKey)}</span>
        <span class="apikey-row__label">${k.label ? esc(k.label) : ''}</span>
        <span class="apikey-row__created">${k.createdAt ? new Date(k.createdAt).toLocaleDateString() : ''}</span>
        ${k.status === 'active'
          ? `<span class="badge badge--on">Active</span>`
          : `<span class="badge badge--off">Disabled</span>`}
        <span class="apikey-row__actions">
          <button type="button" class="btn btn--xs btn--ghost" data-key-toggle="${esc(k.id)}" data-key-enabled="${k.status === 'active' ? 'false' : 'true'}">
            ${k.status === 'active' ? 'Disable' : 'Enable'}
          </button>
          <button type="button" class="btn btn--xs btn--danger" data-key-delete="${esc(k.id)}">Delete</button>
        </span>
      </li>`).join('')
    : `<li class="apikey-row state-empty">No managed API keys yet — the provider is using environment-configured keys.</li>`;
  const envNote = data.envKeyCount > 0
    ? `<span class="apikey-summary__env">+${data.envKeyCount} from environment</span>`
    : '';
  /* Label prefilled with the sequential suggestion (highest used number + 1,
     computed from the fresh backend list + persisted watermark). */
  const suggestion = data.suggestedLabel || nextKeyLabelSuggestion(data.keys.map(k => k.label));
  body.innerHTML = `
    <div class="apikey-summary"><strong>${data.keys.length}</strong> managed API key${data.keys.length === 1 ? '' : 's'} ${envNote}</div>
    <div class="apikey-toolbar" id="apikey-toolbar">
      <label class="apikey-toolbar__all">
        <input type="checkbox" id="apikey-select-all" aria-label="Select all keys" /> Select All
      </label>
      <button type="button" id="apikey-enable-all" class="btn btn--xs btn--ghost">Enable All Keys</button>
      <button type="button" id="apikey-disable-sel" class="btn btn--xs btn--ghost" disabled>Disable Selected</button>
      <button type="button" id="apikey-delete-sel" class="btn btn--xs btn--danger" disabled>Delete Selected</button>
      <span id="apikey-selection-count" class="apikey-toolbar__count" aria-live="polite">0 selected</span>
    </div>
    <p id="apikey-bulk-note" class="apikey-bulk-note" hidden></p>
    <form id="apikey-add-form" class="apikey-add is-hidden" autocomplete="off">
      <input id="apikey-input" type="password" placeholder="API Key (paste provider credential)" autocomplete="new-password" required />
      <input id="apikey-label-input" type="text" placeholder="Label (optional)" maxlength="200" value="${esc(suggestion)}" />
      <div id="apikey-add-error" class="apikey-add__error is-hidden"></div>
      <div class="apikey-add__buttons">
        <button id="apikey-save-btn" type="submit" class="btn btn--primary btn--xs">Save</button>
        <button id="apikey-cancel-btn" type="button" class="btn btn--ghost btn--xs">Cancel</button>
      </div>
    </form>
    <ul class="apikey-list">${rows}</ul>
  `;
  wireApiKeyEvents();
}

function wireApiKeyEvents(): void {
  if (!appRef) return;
  const body = appRef.elts.apikeysBody;

  const form = body.querySelector<HTMLFormElement>('#apikey-add-form');
  form?.addEventListener('submit', (e) => { e.preventDefault(); void submitAddApiKey(); });
  body.querySelector<HTMLButtonElement>('#apikey-cancel-btn')
    ?.addEventListener('click', () => hideApiKeyAddForm());

  body.querySelectorAll<HTMLButtonElement>('[data-key-delete]').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteApiKey(btn.dataset.keyDelete || ''));
  });
  body.querySelectorAll<HTMLButtonElement>('[data-key-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const enabled = btn.dataset.keyEnabled !== 'false';
      void toggleApiKey(btn.dataset.keyToggle || '', enabled, btn);
    });
  });

  /* ---- Selection (checkboxes) + compact bulk toolbar. State lives in the
     DOM and is scoped to this modal's providerId: every (re)render and every
     completed action rebuilds from the backend, so selections from another
     provider can never mix in. ---- */
  body.querySelectorAll<HTMLInputElement>('[data-key-select]').forEach(box => {
    box.addEventListener('change', () => updateApiKeySelectionUI());
  });
  const selectAll = body.querySelector<HTMLInputElement>('#apikey-select-all');
  selectAll?.addEventListener('change', () => {
    body.querySelectorAll<HTMLInputElement>('[data-key-select]').forEach(box => {
      box.checked = selectAll.checked;
    });
    updateApiKeySelectionUI();
  });
  body.querySelector<HTMLButtonElement>('#apikey-enable-all')
    ?.addEventListener('click', () => { void enableAllApiKeys(); });
  body.querySelector<HTMLButtonElement>('#apikey-disable-sel')
    ?.addEventListener('click', () => confirmBulkApiKeys('disable'));
  body.querySelector<HTMLButtonElement>('#apikey-delete-sel')
    ?.addEventListener('click', () => confirmBulkApiKeys('delete'));
  updateApiKeySelectionUI();
}

/** Recomputes counter / Select All (checked + indeterminate) / button enable
 *  states purely from the DOM checkboxes of the open modal. */
function updateApiKeySelectionUI(): void {
  if (!appRef) return;
  const body = appRef.elts.apikeysBody;
  const boxes = Array.from(body.querySelectorAll<HTMLInputElement>('[data-key-select]'));
  const chosen = boxes.filter(b => b.checked);
  const n = chosen.length;
  const count = body.querySelector<HTMLElement>('#apikey-selection-count');
  if (count) count.textContent = `${n} selected`;
  const all = body.querySelector<HTMLInputElement>('#apikey-select-all');
  if (all) {
    all.checked = boxes.length > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
  }
  const disableBtn = body.querySelector<HTMLButtonElement>('#apikey-disable-sel');
  const deleteBtn = body.querySelector<HTMLButtonElement>('#apikey-delete-sel');
  if (disableBtn) disableBtn.disabled = n === 0;
  if (deleteBtn) deleteBtn.disabled = n === 0;
}

/** IDs + masked labels chosen in the currently open modal (never raw keys). */
function selectedApiKeyEntries(): Array<{ id: string; masked: string }> {
  if (!appRef) return [];
  const out: Array<{ id: string; masked: string }> = [];
  appRef.elts.apikeysBody.querySelectorAll<HTMLInputElement>('[data-key-select]:checked').forEach(box => {
    const id = box.dataset.keySelect || '';
    const li = box.closest('.apikey-row');
    const masked = li?.querySelector<HTMLElement>('.apikey-row__key')?.textContent?.trim() || id;
    if (id) out.push({ id, masked });
  });
  return out;
}

function listMaskedKeys(entries: Array<{ id: string; masked: string }>): string {
  const shown = entries.slice(0, 6).map(e => `<code>${esc(e.masked)}</code>`).join(', ');
  const rest = entries.length > 6 ? ` … (+${entries.length - 6} more)` : '';
  return `${shown}${rest}`;
}

function setApiKeyNote(message: string, tone: 'ok' | 'error' = 'ok'): void {
  if (!appRef) return;
  const note = appRef.elts.apikeysBody.querySelector<HTMLElement>('#apikey-bulk-note');
  if (!note) return;
  note.textContent = message;
  note.classList.toggle('is-error', tone === 'error');
  note.hidden = false;
}

/** Loops the EXISTING per-key endpoints (PATCH/DELETE) over the given ids.
 *  No new backend route: bulk semantics = sequential per-key ops via
 *  Promise.all — one provider only (the ids come from this modal).
 *  Reports partial failure honestly; never claims full success. */
async function bulkApplyApiKeys(
  ids: string[],
  mode: 'enable' | 'disable' | 'delete',
): Promise<{ ok: number; failed: number }> {
  const pid = encodeURIComponent(apiKeysProviderId);
  const results = await Promise.all(ids.map(id => mode === 'delete'
    ? apiJSON('DELETE', `/admin/providers/${pid}/api-keys/${encodeURIComponent(id)}`)
    : apiJSON('PATCH', `/admin/providers/${pid}/api-keys/${encodeURIComponent(id)}`, { enabled: mode === 'enable' })));
  let ok = 0;
  for (const r of results) if (r.ok) ok++;
  return { ok, failed: ids.length - ok };
}

/** Re-renders the modal from the backend (resets the selection safely), then
 *  surfaces the bulk-action result. */
async function finishBulkApiKeys(mode: 'enable' | 'disable' | 'delete', total: number, res: { ok: number; failed: number }): Promise<void> {
  if (!appRef) return;
  await openApiKeysModal(apiKeysProviderId);
  if (!appRef.elts.apikeysModal.classList.contains('is-hidden')) {
    const verb = mode === 'delete' ? 'deleted' : mode === 'disable' ? 'disabled' : 'enabled';
    if (res.failed === 0) setApiKeyNote(`${res.ok} of ${total} selected key${total === 1 ? '' : 's'} ${verb}.`);
    else setApiKeyNote(`${res.ok} of ${total} selected keys ${verb} — ${res.failed} failed, see details above.`, 'error');
  }
}

function confirmBulkApiKeys(mode: 'disable' | 'delete'): void {
  if (!appRef) return;
  const entries = selectedApiKeyEntries();
  if (entries.length === 0) return;
  const n = entries.length;
  if (mode === 'disable') {
    appRef.openConfirm({
      title: `Disable ${n} selected key${n === 1 ? '' : 's'}?`,
      bodyHtml: `
        <p>Keys: ${listMaskedKeys(entries)}</p>
        <p>Only the <strong>${n} selected</strong> key${n === 1 ? '' : 's'} are disabled — every other key of
        <strong>${esc(providerNameFor(apiKeysProviderId))}</strong> keeps its current state.</p>`,
      okLabel: `Disable ${n}`,
      okClass: 'btn--danger',
      onConfirm: async () => {
        const res = await bulkApplyApiKeys(entries.map(e => e.id), 'disable');
        await finishBulkApiKeys('disable', n, res);
      },
    });
    return;
  }
  appRef.openConfirm({
    title: `Delete ${n} selected key${n === 1 ? '' : 's'}?`,
    bodyHtml: `
      <p>Keys: ${listMaskedKeys(entries)}</p>
      <p class="modal__warn">The ${n} selected key${n === 1 ? '' : 's'} are removed from
      <strong>${esc(providerNameFor(apiKeysProviderId))}</strong> permanently. This deletes
      <strong>API keys only</strong> — the provider, its models and Client API Keys are untouched.
      Unselected keys stay exactly as they are.</p>`,
    okLabel: `Delete ${n}`,
    okClass: 'btn--danger',
    onConfirm: async () => {
      const res = await bulkApplyApiKeys(entries.map(e => e.id), 'delete');
      await finishBulkApiKeys('delete', n, res);
    },
  });
}

/** Enable every managed key of the OPENED provider (never other providers,
 *  never Client API Keys). Idempotent: when all keys are already active it
 *  makes ZERO requests. */
async function enableAllApiKeys(): Promise<void> {
  if (!appRef) return;
  const body = appRef.elts.apikeysBody;
  const disabled = Array.from(body.querySelectorAll<HTMLLIElement>('.apikey-row.is-disabled'))
    .map(li => li.dataset.keyId || '')
    .filter(Boolean);
  const total = body.querySelectorAll('.apikey-row[data-key-id]').length;
  if (disabled.length === 0) {
    setApiKeyNote(total > 0
      ? `All ${total} managed keys are already enabled — nothing changed.`
      : 'No managed keys yet — nothing to enable.');
    return;
  }
  const res = await bulkApplyApiKeys(disabled, 'enable');
  await finishBulkApiKeys('enable', disabled.length, res);
}

function showApiKeyAddForm(): void {
  if (!appRef) return;
  appRef.elts.apikeysBody.querySelector<HTMLElement>('#apikey-add-form')?.classList.remove('is-hidden');
  appRef.elts.apikeysBody.querySelector<HTMLInputElement>('#apikey-input')?.focus();
}

function hideApiKeyAddForm(): void {
  if (!appRef) return;
  const form = appRef.elts.apikeysBody.querySelector<HTMLFormElement>('#apikey-add-form');
  if (!form) return;
  form.classList.add('is-hidden');
  form.reset();
  form.querySelector('.apikey-add__error')?.classList.add('is-hidden');
}

function toggleApiKeyAddForm(): void {
  if (!appRef) return;
  const form = appRef.elts.apikeysBody.querySelector<HTMLFormElement>('#apikey-add-form');
  if (!form) return;
  if (form.classList.contains('is-hidden')) showApiKeyAddForm();
  else hideApiKeyAddForm();
}

function showApiKeyError(message: string): void {
  if (!appRef) return;
  const elErr = appRef.elts.apikeysBody.querySelector<HTMLElement>('.apikey-add__error');
  if (!elErr) return;
  elErr.textContent = message;
  elErr.classList.remove('is-hidden');
}

async function submitAddApiKey(): Promise<void> {
  if (!appRef || !apiKeysProviderId) return;
  const input = appRef.elts.apikeysBody.querySelector<HTMLInputElement>('#apikey-input');
  const labelInput = appRef.elts.apikeysBody.querySelector<HTMLInputElement>('#apikey-label-input');
  const saveBtn = appRef.elts.apikeysBody.querySelector<HTMLButtonElement>('#apikey-save-btn');
  const apiKey = (input?.value ?? '').trim();
  if (!apiKey) {
    showApiKeyError('API key must not be empty');
    return;
  }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  /* Label = the (auto-numbered) value from the form. Two forms opened against
     the same suggestion can't create a duplicate: bump silently against the
     currently-rendered labels. The backend watermark stays the authority that
     deleted numbers are never reused (computeKeyLabelSuggestion). */
  let label = (labelInput?.value?.trim() || '');
  if (label) {
    const taken = new Set<string>();
    appRef.elts.apikeysBody.querySelectorAll<HTMLElement>('.apikey-row[data-key-id]').forEach(li => {
      const existing = li.dataset.keyLabel || '';
      if (existing) taken.add(existing);
    });
    label = bumpKeyLabel(label, taken);
  }
  const r = await apiJSON<{ success: boolean; key: ApiKeyRecord }>(
    'POST',
    `/admin/providers/${encodeURIComponent(apiKeysProviderId)}/api-keys`,
    { apiKey, label: label || undefined },
  );
  /* Never keep the raw key around in the DOM after submit. */
  if (input) input.value = '';
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  if (!r.ok) {
    showApiKeyError(r.error || 'Failed to add API key');
    return;
  }
  hideApiKeyAddForm();
  await openApiKeysModal(apiKeysProviderId); // re-render from backend (masked)
  await appRef.loadProvidersForManagement();  // update counts on cards
}

function confirmDeleteApiKey(keyId: string): void {
  if (!appRef || !apiKeysProviderId) return;
  const row = appRef.elts.apikeysBody.querySelector<HTMLElement>(`[data-key-id="${CSS.escape(keyId)}"]`);
  const masked = row?.querySelector<HTMLElement>('.apikey-row__key')?.textContent?.trim() || keyId;
  appRef.openConfirm({
    title: 'Delete API Key?',
    bodyHtml: `
      <p>You are about to delete an API key from <strong>${esc(providerNameFor(apiKeysProviderId))}</strong>.</p>
      <p>Key: <code>${esc(masked)}</code></p>
      <p class="modal__warn">The key stops being used for new requests immediately and is removed from persistent storage. This cannot be undone.</p>
    `,
    okLabel: 'Delete',
    okClass: 'btn--danger',
    onConfirm: async () => {
      const r = await apiJSON(
        'DELETE',
        `/admin/providers/${encodeURIComponent(apiKeysProviderId)}/api-keys/${encodeURIComponent(keyId)}`,
      );
      if (!r.ok) {
        appRef!.showError('Failed to delete API key', r.error || 'unknown');
        return;
      }
      await openApiKeysModal(apiKeysProviderId);
      await appRef!.loadProvidersForManagement();
    },
  });
}

async function toggleApiKey(keyId: string, enabled: boolean, triggerBtn?: HTMLButtonElement): Promise<void> {
  if (!appRef || !apiKeysProviderId) return;
  /* In-flight guard: ignore re-clicks while the PATCH is running (#11). */
  if (triggerBtn?.disabled) return;
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '…'; }
  const r = await apiJSON<{ status: string }>(
    'PATCH',
    `/admin/providers/${encodeURIComponent(apiKeysProviderId)}/api-keys/${encodeURIComponent(keyId)}`,
    { enabled },
  );
  if (triggerBtn) { triggerBtn.disabled = false; }
  if (!r.ok) {
    appRef.showError(`Failed to ${enabled ? 'enable' : 'disable'} API key`, r.error || 'unknown');
    return;
  }
  await openApiKeysModal(apiKeysProviderId);
}

/* --------------------------- Overview providers --------------------------- */
function renderOverviewProvidersHTML(providers: AdminProvider[]): string {
  if (providers.length === 0) return renderEmptyHTML('No providers registered.');
  return providers.map(p => `
    <div class="overview-provider">
      <div>
        <span class="overview-provider__name">${esc(p.name)}</span>
        <span class="overview-provider__id">${esc(p.id)}</span>
      </div>
      <div style="display:flex; align-items:center; gap: var(--space-3);">
        <span class="overview-provider__stats">${esc(p.models.length)} models</span>
        ${p.enabled ? `<span class="badge badge--on">ENABLED</span>` : `<span class="badge badge--off">DISABLED</span>`}
      </div>
    </div>
  `).join('');
}

function renderOverviewProviders(target: HTMLElement, providers: AdminProvider[]): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderOverviewProvidersHTML(providers);
}

/* ----------------------------- Provider table ----------------------------- */
function renderProviderUsageHTML(data: Record<string, ProviderBreakdown>): string {
  const rows = Object.entries(data);
  if (rows.length === 0) return `<tr><td colspan="10" class="state-empty">No usage data available.</td></tr>`;
  return rows.map(([id, b]) => `
    <tr>
      <td class="cell-mono">${esc(id)}</td>
      <td class="cell-num">${fmtNum(b.requests)}</td>
      <td class="cell-num">${fmtNum(b.success)}</td>
      <td class="cell-num">${fmtNum(b.failed)}</td>
      <td class="cell-num">${fmtNum(b.blocked)}</td>
      <td class="cell-num">${fmtTokens(b.promptTokens)}</td>
      <td class="cell-num">${fmtTokens(b.completionTokens)}</td>
      <td class="cell-num">${fmtTokens(b.totalTokens)}</td>
      <td class="cell-num">${fmtCost(b.costUsd)}</td>
      <td class="cell-num">${fmtLatency(b.avgLatencyMs)}</td>
    </tr>
  `).join('');
}

function renderProviderUsage(target: HTMLElement, data: Record<string, ProviderBreakdown>): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderProviderUsageHTML(data);
}

/* ------------------------------- Model table ------------------------------ */
function pricingTag(status: 'known' | 'free' | 'unknown' | undefined): string {
  if (status === 'unknown') return ` <span class="cell-dim" title="No price registered for this exact provider/model — cost is N/A, never counted as $0">(unpriced)</span>`;
  if (status === 'free') return ` <span class="cell-dim" title="Explicitly registered as a free ($0/$0) model">free</span>`;
  return '';
}

function renderModelUsageHTML(data: Record<string, ModelBreakdown>): string {
  const rows = Object.entries(data);
  if (rows.length === 0) return `<tr><td colspan="13" class="state-empty">No usage data available.</td></tr>`;
  return rows.map(([model, b]) => `
    <tr>
      <td class="cell-mono cell-break" title="${esc(b.model || model)}">${esc(b.model || model)}</td>
      <td class="cell-mono">${esc(b.provider || b.providers.join(', '))}</td>
      <td class="cell-num">${fmtNum(b.requests)}</td>
      <td class="cell-num">${fmtNum(b.success)}</td>
      <td class="cell-num">${fmtNum(b.failed)}</td>
      <td class="cell-num">${fmtNum(b.blocked)}</td>
      <td class="cell-num">${fmtTokens(b.promptTokens)}</td>
      <td class="cell-num">${fmtTokens(b.completionTokens)}</td>
      <td class="cell-num">${fmtTokens(b.totalTokens)}</td>
      <td class="cell-num">${fmtCost(b.inputCostUsd)}${pricingTag(b.pricingStatus)}</td>
      <td class="cell-num">${fmtCost(b.outputCostUsd)}</td>
      <td class="cell-num">${fmtCost(b.costUsd)}</td>
      <td class="cell-num">${fmtLatency(b.avgLatencyMs)}</td>
    </tr>
  `).join('');
}

function renderModelUsage(target: HTMLElement, data: Record<string, ModelBreakdown>): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderModelUsageHTML(data);
}

/* ----------------------------- Model Registry ------------------------------ */
function renderRegistryHTML(data: RegistryProvider[]): string {
  const rows = data.flatMap(p => p.models.map(m => ({ p, m })));
  if (rows.length === 0) return `<tr><td colspan="6" class="state-empty">No models registered.</td></tr>`;
  return rows.map(({ p, m }) => `
    <tr data-registry-provider="${esc(p.id)}" data-registry-model="${esc(m.model)}">
      <td><span class="badge badge--http-null" title="${esc(p.name)}">${esc(p.id)}</span></td>
      <td class="cell-mono cell-break">${esc(m.model)}</td>
      <td class="cell-mono cell-dim">${m.backendModel && m.backendModel !== m.model ? esc(m.backendModel) : DASH}</td>
      <td class="cell-num">${fmtNum(m.priority)}</td>
      <td>${m.enabled
        ? `<span class="badge badge--on">ENABLED</span>`
        : `<span class="badge badge--off">DISABLED</span>`}</td>
      <td class="apikey-row__actions">
        <button type="button" class="btn btn--xs btn--ghost" data-registry-action="toggle"
          data-enabled="${m.enabled ? 'false' : 'true'}">${m.enabled ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn btn--xs btn--danger" data-registry-action="delete">Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderRegistry(target: HTMLElement, data: RegistryProvider[]): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderRegistryHTML(data);
}

/* ------------------------------ Usage chart --------------------------------
 * Reusable horizontal stacked-bar chart built purely from design tokens.
 * Data comes verbatim from /admin/usage/providers — no fabrication. */
function renderUsageChartHTML(data: Record<string, ProviderBreakdown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return `<div class="state-empty">No usage data available.</div>`;
  const max = Math.max(...entries.map(([, b]) => b.requests), 1);
  const pct = (v: number) => `${(v / max) * 100}%`;
  const rows = entries.map(([id, b]) => `
    <div class="chart-row" title="${esc(id)}: ${fmtNum(b.requests)} requests · ${fmtNum(b.success)} success · ${fmtNum(b.failed)} failed · ${fmtNum(b.blocked)} blocked">
      <span class="chart-row__label">${esc(id)}</span>
      <span class="chart-row__track" aria-hidden="true">
        <span class="chart-row__seg chart-row__seg--success" style="width:${pct(b.success)}"></span>
        <span class="chart-row__seg chart-row__seg--error" style="width:${pct(b.failed)}"></span>
        <span class="chart-row__seg chart-row__seg--blocked" style="width:${pct(b.blocked)}"></span>
      </span>
      <span class="chart-row__value">${fmtNum(b.requests)}</span>
    </div>
  `).join('');
  return `
    <div class="usage-chart__legend" aria-hidden="true">
      <span class="usage-chart__key"><span class="usage-chart__swatch usage-chart__swatch--success"></span>Success</span>
      <span class="usage-chart__key"><span class="usage-chart__swatch usage-chart__swatch--error"></span>Failed</span>
      <span class="usage-chart__key"><span class="usage-chart__swatch usage-chart__swatch--blocked"></span>Blocked</span>
    </div>
    ${rows}
  `;
}

/* --------------------- All API keys page (per provider) ---------------------
 * Aggregated view over the existing per-provider endpoints. Only masked keys
 * are ever rendered — raw credentials never reach this code path on read. */
interface ApiKeyRow { p: { id: string; name: string }; k: ApiKeyRecord; }

function renderAllApiKeysHTML(rows: ApiKeyRow[]): string {
  if (rows.length === 0) {
    return `<tr><td colspan="6" class="state-empty">No managed API keys yet — providers are using environment-configured keys.</td></tr>`;
  }
  return rows.map(({ p, k }) => `
    <tr data-key-provider="${esc(p.id)}" data-key-id="${esc(k.id)}">
      <td><span class="badge badge--http-null" title="${esc(p.name)}">${esc(p.id)}</span></td>
      <td class="cell-mono">${esc(k.maskedKey)}</td>
      <td>${k.label ? esc(k.label) : `<span class="cell-dim">—</span>`}</td>
      <td class="cell-mono">${k.createdAt ? fmtTime(k.createdAt) : DASH}</td>
      <td>${k.status === 'active'
        ? `<span class="badge badge--on">Active</span>`
        : `<span class="badge badge--off">Disabled</span>`}</td>
      <td class="apikey-row__actions">
        <button type="button" class="btn btn--xs btn--ghost" data-pagekey-action="toggle"
          data-enabled="${k.status === 'active' ? 'false' : 'true'}">${k.status === 'active' ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn btn--xs btn--danger" data-pagekey-action="delete">Delete</button>
      </td>
    </tr>
  `).join('');
}

/* Client API keys table (Create API Key feature). */
function renderClientKeysHTML(keys: ClientKeyRecord[]): string {
  if (keys.length === 0) {
    return `<tr><td colspan="9" class="state-empty">No client API keys yet — use “Create API Key” to mint one.</td></tr>`;
  }
  return keys.map(k => `
    <tr data-clientkey-id="${esc(k.id)}">
      <td class="cell-mono">${esc(k.maskedKey)}</td>
      <td><span class="badge badge--http-null" title="${esc(k.providerId)}">${esc(k.providerId)}</span></td>
      <td>${k.allowedModels.map(m => `<span class="badge">${esc(m)}</span>`).join(' ')}</td>
      <td>${k.label ? esc(k.label) : `<span class="cell-dim">—</span>`}</td>
      <td>${k.requestCount ?? 0}</td>
      <td class="cell-mono">${k.lastUsedAt ? fmtTime(k.lastUsedAt) : DASH}</td>
      <td class="cell-mono">${k.createdAt ? fmtTime(k.createdAt) : DASH}</td>
      <td>${k.status === 'active'
        ? `<span class="badge badge--on">Active</span>`
        : `<span class="badge badge--off">Disabled</span>`}</td>
      <td class="apikey-row__actions">
        <button type="button" class="btn btn--xs btn--ghost" data-clientkey-action="toggle"
          data-enabled="${k.status === 'active' ? 'false' : 'true'}">${k.status === 'active' ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn btn--xs btn--danger" data-clientkey-action="delete">Delete</button>
      </td>
    </tr>
  `).join('');
}

/* Combos table (Client → Provider → Model → Provider API Key). Only masked
 * metadata is ever rendered — raw credentials never reach this code path. */
function renderCombosHTML(combos: ComboRecord[]): string {
  if (combos.length === 0) {
    return `<tr><td colspan="9" class="state-empty">No combos yet — use “Create Combo” to pin a client key to a provider, model and provider API key.</td></tr>`;
  }
  return combos.map(c => {
    const clientLabel = c.clientKey
      ? `${esc(c.clientKey.label || '—')} <span class="cell-mono cell-dim">${esc(c.clientKey.maskedKey)}</span>`
      : `<span class="cell-mono cell-dim">${esc(c.clientKeyId)}</span>`;
    const providerCell = `<span class="badge badge--http-null" title="${esc(c.providerName)}">${esc(c.providerId)}</span>`;
    const keyCell = c.providerKey
      ? `${esc(c.providerKey.label || '—')} <span class="cell-mono cell-dim">${esc(c.providerKey.maskedKey)}</span>`
      : `<span class="cell-dim">all keys (rotation)</span>`;
    const keyUnavailable = c.providerKey && c.providerKey.status !== 'active'
      ? ` <span class="badge badge--off">key disabled</span>` : '';
    const clientUnavailable = c.clientKey && c.clientKey.status !== 'active'
      ? ` <span class="badge badge--off">key disabled</span>` : '';
    return `
    <tr data-combo-id="${esc(c.id)}">
      <td>${clientLabel}${clientUnavailable}</td>
      <td>${providerCell}</td>
      <td><span class="badge">${esc(c.model)}</span></td>
      <td>${keyCell}${keyUnavailable}</td>
      <td>${c.status === 'active'
        ? `<span class="badge badge--on">Active</span>`
        : `<span class="badge badge--off">Disabled</span>`}</td>
      <td>${c.requestCount ?? 0}</td>
      <td class="cell-mono">${c.lastUsedAt ? fmtTime(c.lastUsedAt) : DASH}</td>
      <td class="cell-mono">${c.createdAt ? fmtTime(c.createdAt) : DASH}</td>
      <td class="apikey-row__actions">
        <button type="button" class="btn btn--xs btn--ghost" data-combo-action="toggle"
          data-enabled="${c.status === 'active' ? 'false' : 'true'}">${c.status === 'active' ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn btn--xs btn--ghost" data-combo-action="edit">Edit</button>
        <button type="button" class="btn btn--xs btn--danger" data-combo-action="delete">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

/* --------------------------------- Logs ------------------------------------ */
function renderLogsHTML(resp: LogsResponse, offsetBase: number): string {
  if (!resp.logs || resp.logs.length === 0) {
    return `<tr><td colspan="12" class="state-empty">No usage records found.</td></tr>`;
  }
  return resp.logs.map((r, i) => {
    const idx = offsetBase + i;
    return `
    <tr data-index="${idx}">
      <td class="cell-mono">${fmtTime(r.timestamp)}</td>
      <td class="cell-mono">${esc(r.provider)}</td>
      <td class="cell-mono cell-truncate" title="${esc(r.model)}">${esc(r.model)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${httpBadge(r.httpStatus)}</td>
      <td class="cell-num">${fmtTokens(r.promptTokens)}</td>
      <td class="cell-num">${fmtTokens(r.completionTokens)}</td>
      <td class="cell-num">${fmtTokens(r.totalTokens)}</td>
      <td class="cell-num">${fmtCost(r.costUsd)}</td>
      <td class="cell-num">${fmtLatency(r.latencyMs)}</td>
      <td class="cell-truncate" title="${esc(r.errorMessage || '')}">${esc(r.errorMessage || '') || DASH}</td>
      <td><button class="btn btn--xs btn--ghost" data-detail="${idx}">Detail</button></td>
    </tr>`;
  }).join('');
}

function renderLogs(target: HTMLElement, resp: LogsResponse, onDetail: (idx: number) => void, offsetBase: number): void {
  target.setAttribute('data-state', 'loaded');
  target.innerHTML = renderLogsHTML(resp, offsetBase);
  /* Wire up detail buttons. */
  target.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach(btn => {
    btn.addEventListener('click', () => onDetail(parseInt(btn.dataset.detail || '0', 10)));
  });
}

/* ----------------------------- Log detail modal --------------------------- */
function renderLogDetailHTML(rec: UsageRecord | null, loading: boolean, error: string | null): string {
  if (loading) {
    return `
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
    `;
  }
  if (error) return `<div class="state-error">${esc(error)}</div>`;
  if (!rec) return `<div class="state-empty">Record not found.</div>`;
  const rows: Array<[string, string]> = [
    ['Timestamp', fmtTime(rec.timestamp)],
    ['Provider', rec.provider],
    ['Model', rec.model],
    ['Status', rec.status],
    ['HTTP Status', rec.httpStatus === null || rec.httpStatus === undefined ? DASH : String(rec.httpStatus)],
    ['Latency', fmtLatency(rec.latencyMs)],
    ['Prompt Tokens', fmtTokens(rec.promptTokens)],
    ['Completion Tokens', fmtTokens(rec.completionTokens)],
    ['Total Tokens', fmtTokens(rec.totalTokens)],
    ['Input Cost', fmtCost(rec.inputCostUsd)],
    ['Output Cost', fmtCost(rec.outputCostUsd)],
    ['Est. Cost', fmtCost(rec.costUsd)],
    ['Error Message', rec.errorMessage || DASH],
    ['Request ID', rec.requestId || DASH],
    ['Client Identifier', rec.apiKey || DASH],
    ['Masked API Key', rec.apiKeyMasked || DASH],
    ['Combo', rec.comboId || DASH],
    ['Provider Key (pinned)', rec.providerKeyId || (rec.comboId ? 'provider rotation' : DASH)],
  ];
  return `
    <dl class="detail-list">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
  `;
}

function renderLogDetail(target: HTMLElement, rec: UsageRecord | null, loading: boolean, error: string | null): void {
  target.setAttribute('data-state', loading ? 'loading' : error ? 'error' : 'loaded');
  target.innerHTML = renderLogDetailHTML(rec, loading, error);
}

/* ------------------------------- Backup list ------------------------------- */
function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderBackupListHTML(backups: BackupInfo[]): string {
  if (backups.length === 0) {
    return `<tr><td colspan="11" class="state-empty">No backups found. Press “Create Backup” to take a snapshot.</td></tr>`;
  }
  return backups.map(b => {
    const validBadge = b.valid
      ? `<span class="badge badge--success">VALID</span>`
      : `<span class="badge badge--error">INVALID</span>`;
    /* Only valid backups can be restored/downloaded. */
    const disabledAttr = b.valid ? '' : ' disabled';
    return `
    <tr data-backup-id="${esc(b.backupId)}">
      <td class="backup-id">${esc(b.backupId)}</td>
      <td class="cell-mono">${fmtTime(b.createdAt)}</td>
      <td class="cell-num">${fmtNum(b.usageRecordCount)}</td>
      <td class="cell-num">${fmtNum(b.providerStateCount)}</td>
      <td class="cell-num">${fmtSize(b.size)}</td>
      <td class="cell-num">v${esc(b.version)}</td>
      <td>${validBadge}</td>
      <td><a class="btn btn--xs btn--ghost" data-action="download" href="/admin/backup/download/${encodeURIComponent(b.backupId)}" download${disabledAttr}>Download</a></td>
      <td><button class="btn btn--xs btn--ghost" data-action="info" ${disabledAttr}>Info</button></td>
      <td><button class="btn btn--xs btn--danger" data-action="restore" ${disabledAttr}>Restore</button></td>
      <td><button class="btn btn--xs btn--ghost" data-action="delete">Delete</button></td>
    </tr>`;
  }).join('');
}

/* ----------------------------- Backup info modal ---------------------------- */
function renderBackupInfoHTML(info: BackupInfo | null, error: string | null): string {
  if (error) return `<div class="state-error">${esc(error)}</div>`;
  if (!info) return `<div class="state-empty">Backup not found.</div>`;
  const rows: Array<[string, string]> = [
    ['Backup ID',     info.backupId],
    ['Created At',    fmtTime(info.createdAt)],
    ['Size',          fmtSize(info.size)],
    ['Usage Records', fmtNum(info.usageRecordCount)],
    ['Providers',     fmtNum(info.providerStateCount)],
    ['Version',       `v${info.version}`],
    ['Source Version', info.sourceVersion || DASH],
    ['Valid',         info.valid ? 'YES' : 'NO'],
  ];
  return `
    <dl class="detail-list">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
  `;
}

/* ---------------------- Restore confirm dialog content ---------------------- */
function renderRestoreConfirmHTML(backup: BackupInfo): string {
  return `
    <p>You are about to restore backup <strong class="backup-id">${esc(backup.backupId)}</strong>.</p>
    <dl class="detail-list">
      <dt>Backup ID</dt><dd>${esc(backup.backupId)}</dd>
      <dt>Timestamp</dt><dd>${fmtTime(backup.createdAt)}</dd>
      <dt>Usage Records</dt><dd>${fmtNum(backup.usageRecordCount)}</dd>
      <dt>Version</dt><dd>v${esc(backup.version)} (${esc(backup.sourceVersion || DASH)})</dd>
    </dl>
    <p class="modal__warn">
      Restore <strong>overwrites</strong> current usage records and provider state.
      A pre-restore snapshot will be taken automatically before the data is replaced.
    </p>
  `;
}

/* ============================================================================
 * App controller — wires data fetching, tab state, filters, pagination
 * ========================================================================== */

const LOGS_PAGE_SIZE = 25;

/* Sidebar section labels for the topbar breadcrumb (single source of truth). */
const TAB_LABELS: Record<string, string> = {
  'overview': 'Overview',
  'providers': 'Provider Management',
  'apikeys': 'API Key Management',
  'client-keys': 'Client API Keys',
  'combos': 'Combos',
  'registry': 'Model Registry',
  'providers-usage': 'Usage Dashboard',
  'models-usage': 'Usage per Model',
  'pricing': 'Pricing Management',
  'logs': 'Usage Logs',
  'backup': 'Backup & Restore',
};

/* Model Registry contracts (mirror GET /admin/models response). */
interface RegistryProvider {
  id: string;
  name: string;
  models: ModelRegistration[];
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface LogsFilters {
  provider: string;
  model: string;
  status: string;
  from: number | undefined;
  to: number | undefined;
  search: string;
}

interface AppElements {
  tabs: NodeListOf<HTMLButtonElement>;
  panels: NodeListOf<HTMLElement>;
  refreshBtn: HTMLButtonElement;
  lastRefresh: HTMLElement;
  errorBanner: HTMLElement;

  /* App shell (design reference): sidebar + topbar */
  appShell: HTMLElement;
  sidebarToggle: HTMLButtonElement;
  sidebarOverlay: HTMLElement;
  breadcrumb: HTMLElement;
  globalSearch: HTMLInputElement;
  sysStatusDot: HTMLElement;
  sysStatusText: HTMLElement;
  sysUptime: HTMLElement;
  topbarStatus: HTMLElement;
  appVersion: HTMLElement;
  copyrightYear: HTMLElement;

  usageSummary: HTMLElement;
  overviewProviders: HTMLElement;

  providersList: HTMLElement;
  addProviderBtn: HTMLButtonElement;

  apikeysTbody: HTMLElement;
  pageApikeyAddBtn: HTMLButtonElement;
  pageApikeyForm: HTMLFormElement;
  pageApikeyProvider: HTMLSelectElement;
  pageApikeyInput: HTMLInputElement;
  pageApikeyLabel: HTMLInputElement;
  pageApikeyError: HTMLElement;
  pageApikeySaveBtn: HTMLButtonElement;
  pageApikeyCancelBtn: HTMLButtonElement;

  clientKeysTbody: HTMLElement;
  clientkeyCreateBtn: HTMLButtonElement;
  clientkeyForm: HTMLFormElement;
  clientkeyProvider: HTMLSelectElement;
  clientkeyProviderSearch: HTMLInputElement;
  clientkeyProviderList: HTMLElement;
  clientkeyModelSearchWrap: HTMLElement;
  clientkeyModelSearch: HTMLInputElement;
  clientkeyModelCount: HTMLElement;
  clientkeyModels: HTMLElement;
  clientkeyModelsEmpty: HTMLElement;
  clientkeyLabel: HTMLInputElement;
  clientkeyError: HTMLElement;
  clientkeySaveBtn: HTMLButtonElement;
  clientkeyCancelBtn: HTMLButtonElement;
  clientkeyResult: HTMLElement;
  clientkeyResultKey: HTMLElement;
  clientkeyCopyBtn: HTMLButtonElement;
  clientkeyResultMeta: HTMLElement;

  combosTbody: HTMLElement;
  comboCreateBtn: HTMLButtonElement;
  comboForm: HTMLFormElement;
  comboClient: HTMLSelectElement;
  comboProvider: HTMLSelectElement;
  comboModel: HTMLSelectElement;
  comboKey: HTMLSelectElement;
  comboError: HTMLElement;
  comboSaveBtn: HTMLButtonElement;
  comboCancelBtn: HTMLButtonElement;

  registryTbody: HTMLElement;
  registryAddBtn: HTMLButtonElement;
  registryForm: HTMLFormElement;
  registryProvider: HTMLSelectElement;
  registryModel: HTMLInputElement;
  registryBackendModel: HTMLInputElement;
  registryPriority: HTMLInputElement;
  registryError: HTMLElement;
  registrySaveBtn: HTMLButtonElement;
  registryCancelBtn: HTMLButtonElement;

  usageProviderTbody: HTMLElement;
  usageModelTbody: HTMLElement;
  usageChart: HTMLElement;

  logsFilters: HTMLFormElement;
  filterProvider: HTMLSelectElement;
  filterModel: HTMLSelectElement;
  filterStatus: HTMLSelectElement;
  filterFrom: HTMLInputElement;
  filterTo: HTMLInputElement;
  filterSearch: HTMLInputElement;
  filtersReset: HTMLButtonElement;

  logsTbody: HTMLElement;
  logsPrev: HTMLButtonElement;
  logsNext: HTMLButtonElement;
  logsRange: HTMLElement;

    /* Backup tab */
    backupCreate: HTMLButtonElement;
    backupDownloadFull: HTMLButtonElement;
  backupStatus: HTMLElement;
  backupTbody: HTMLElement;

  infoModal: HTMLElement;
  infoModalBody: HTMLElement;

  confirmModal: HTMLElement;
  confirmTitle: HTMLElement;
  confirmBody: HTMLElement;
  confirmOk: HTMLButtonElement;
  confirmCancel: HTMLButtonElement;

  apikeysModal: HTMLElement;
  apikeysTitle: HTMLElement;
  apikeysBody: HTMLElement;
  apikeyAddBtn: HTMLButtonElement;

  pricingTbody: HTMLElement;
  pricingAddBtn: HTMLButtonElement;
  pricingForm: HTMLFormElement;
  pricingProvider: HTMLSelectElement;
  pricingModel: HTMLInputElement;
  pricingInput: HTMLInputElement;
  pricingOutput: HTMLInputElement;
  pricingError: HTMLElement;
  pricingSaveBtn: HTMLButtonElement;
  pricingCancelBtn: HTMLButtonElement;

  modal: HTMLElement;
  modalBody: HTMLElement;
}

class AdminApp {
  /* Public so module-level API-key modal helpers can drive shared UI state. */
  elts: AppElements;
  private activeTab = 'overview';
  private logsOffset = 0;
  private logsTotal = 0;
  private logsFilters: LogsFilters = { provider: '', model: '', status: '', from: undefined, to: undefined, search: '' };
  providersCache: AdminProvider[] = [];
  private backupsCache: BackupInfo[] = [];
  /* visible-section tracking — only refresh active panel content */
  private loadedSections = new Set<string>();
  /** Pending confirm-modal action; set by openConfirm, invoked by the OK button. */
  private confirmHandler: (() => void | Promise<void>) | null = null;
  /** Auto-refresh polling timer. Refreshes the active tab's data every 30 s. */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  /* Manual-refresh state for Provider Management: in-flight button guard +
     did the latest providers fetch succeed (gates "Last refresh"). */
  private refreshInFlight = false;
  private providersLoadOk = false;

  constructor(elts: AppElements) {
    this.elts = elts;
    appRef = this;
    this.bind();
  }

  /* -------------------------------- Setup -------------------------------- */
  private bind(): void {
    this.elts.tabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab || 'overview'));
    });

    this.elts.refreshBtn.addEventListener('click', () => this.refreshActive(true));

    this.elts.logsFilters.addEventListener('submit', (e) => {
      e.preventDefault();
      this.applyFilters();
    });

    this.elts.filtersReset.addEventListener('click', () => this.resetFilters());

    this.elts.logsPrev.addEventListener('click', () => {
      if (this.logsOffset >= LOGS_PAGE_SIZE) {
        this.logsOffset -= LOGS_PAGE_SIZE;
        this.loadLogs();
      }
    });
    this.elts.logsNext.addEventListener('click', () => {
      if (this.logsOffset + LOGS_PAGE_SIZE < this.logsTotal) {
        this.logsOffset += LOGS_PAGE_SIZE;
        this.loadLogs();
      }
    });

    /* Provider filter → cascade models: only show models for the chosen provider */
    this.elts.filterProvider.addEventListener('change', () => this.repopulateModelFilter());

    /* Modal close — wire both the log-detail modal and the backup/info/confirm modals */
    const wireClose = (modal: HTMLElement) => {
      modal.querySelectorAll('[data-close]').forEach(n => n.addEventListener('click', () => modal.classList.add('is-hidden')));
    };
    wireClose(this.elts.modal);
    wireClose(this.elts.infoModal);
    wireClose(this.elts.confirmModal);
    wireClose(this.elts.apikeysModal);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.elts.modal.classList.contains('is-hidden'))      this.elts.modal.classList.add('is-hidden');
      if (!this.elts.infoModal.classList.contains('is-hidden'))   this.elts.infoModal.classList.add('is-hidden');
      if (!this.elts.confirmModal.classList.contains('is-hidden')) this.elts.confirmModal.classList.add('is-hidden');
      if (!this.elts.apikeysModal.classList.contains('is-hidden')) this.elts.apikeysModal.classList.add('is-hidden');
    });

    /* Backup tab */
    this.elts.backupCreate.addEventListener('click', () => this.createBackup());
    this.elts.backupDownloadFull.addEventListener('click', () => this.downloadFullBackup());
    /* Click delegation for the action buttons inside the backups table */
    this.elts.backupTbody.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLButtonElement>('[data-action]');
      if (!btn) return;
      const tr = btn.closest<HTMLTableRowElement>('tr[data-backup-id]');
      const id = tr?.dataset.backupId || '';
      if (!id) return;
      const action = btn.dataset.action;
      if (action === 'info')     this.showBackupInfo(id);
      else if (action === 'restore') this.confirmRestore(id);
      else if (action === 'delete')  this.confirmDeleteBackup(id);
      /* download: native <a download> link, no JS handler needed */
    });

    /* Confirm modal — wire Cancel + OK once; OK handler set per-action via setConfirmHandler */
    this.elts.confirmCancel.addEventListener('click', () => this.closeConfirm());
    this.confirmHandler = null;

    /* ── App shell: sidebar toggle, overlay, global search, version ── */
    this.elts.sidebarToggle.addEventListener('click', () => {
      const mobile = window.matchMedia('(max-width: 1024px)').matches;
      if (mobile) {
        this.elts.appShell.classList.toggle('is-sidebar-open');
        this.elts.sidebarOverlay.toggleAttribute('hidden',
          !this.elts.appShell.classList.contains('is-sidebar-open'));
      } else {
        this.elts.appShell.classList.toggle('is-sidebar-collapsed');
      }
    });
    this.elts.sidebarOverlay.addEventListener('click', () => {
      this.elts.appShell.classList.remove('is-sidebar-open');
      this.elts.sidebarOverlay.setAttribute('hidden', '');
    });

    /* Ctrl/Cmd+K focuses the global search (reference shortcut) */
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.elts.globalSearch.focus();
      }
    });
    /* Search semantics: Providers tab filters cards live; elsewhere Enter
       jumps to Usage Logs with the query applied. No extra API endpoints. */
    this.elts.globalSearch.addEventListener('input', () => {
      if (this.activeTab === 'providers') this.filterProviderCards(this.elts.globalSearch.value.trim().toLowerCase());
    });
    this.elts.globalSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = this.elts.globalSearch.value.trim();
      if (this.activeTab === 'providers') { this.filterProviderCards(q.toLowerCase()); return; }
      this.switchTab('logs');
      const f = document.getElementById('filter-search') as HTMLInputElement | null;
      if (f) f.value = q;
      this.logsOffset = 0;
      void this.loadLogs();
    });

    /* API keys modal — the footer "+ Add API Key" toggles the inline form */
    this.elts.apikeyAddBtn.addEventListener('click', () => toggleApiKeyAddForm());

    /* Pricing tab — add/update form + row action delegation */
    this.elts.pricingAddBtn.addEventListener('click', () => {
      this.pricingEditingId = null;
      this.showPricingForm();
    });
    this.elts.pricingCancelBtn.addEventListener('click', () => { this.pricingEditingId = null; this.hidePricingForm(); });
    this.elts.pricingForm.addEventListener('submit', (e) => { e.preventDefault(); void this.submitPricing(); });
    this.elts.pricingTbody.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pricing-action]');
      if (!btn) return;
      const id = btn.dataset.pricingId || '';
      const action = btn.dataset.pricingAction;
      if (action === 'edit') this.editPricing(id);
      else if (action === 'toggle') void this.togglePricing(id);
      else if (action === 'delete') this.confirmDeletePricing(id);
    });

    /* API Key Management page — add form + row action delegation */
    this.elts.pageApikeyAddBtn.addEventListener('click', () => {
      this.showPageApikeyForm();
    });
    this.elts.pageApikeyCancelBtn.addEventListener('click', () => this.hidePageApikeyForm());
    this.elts.pageApikeyForm.addEventListener('submit', (e) => { e.preventDefault(); void this.submitPageApiKey(); });

    /* Client API Keys tab — create form + row action delegation */
    this.elts.clientkeyCreateBtn.addEventListener('click', () => {
      void this.showClientKeyForm();
    });
    this.elts.clientkeyCancelBtn.addEventListener('click', () => this.hideClientKeyForm());
    this.elts.clientkeyForm.addEventListener('submit', (e) => { e.preventDefault(); void this.submitCreateClientKey(); });
    /* Provider selection cascades the model checklist (registry-driven). */
    this.elts.clientkeyProvider.addEventListener('change', () => this.renderClientKeyModels());
    /* Client-side-only search filters over the already-loaded catalog —
     * never a network request, and never a model-id transformation. */
    this.elts.clientkeyProviderSearch.addEventListener('input', () => this.renderProviderPicker());
    this.elts.clientkeyProviderList.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-provider-id]');
      if (!row) return;
      this.selectClientKeyProvider(row.dataset.providerId || '');
    });
    this.elts.clientkeyModelSearch.addEventListener('input', () => this.filterClientKeyModels());
    this.elts.clientkeyCopyBtn.addEventListener('click', () => {
      const key = this.elts.clientkeyResultKey.textContent || '';
      void copyTextToClipboard(key).then((ok) => {
        this.elts.clientkeyCopyBtn.textContent = ok ? 'Copied!' : 'Copy failed — select it manually';
        setTimeout(() => { this.elts.clientkeyCopyBtn.textContent = 'Copy'; }, ok ? 2000 : 3500);
      });
    });
    this.elts.clientKeysTbody.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-clientkey-action]');
      if (!btn) return;
      const tr = btn.closest<HTMLTableRowElement>('tr[data-clientkey-id]');
      const keyId = tr?.dataset.clientkeyId || '';
      if (!keyId) return;
      const action = btn.dataset.clientkeyAction;
      if (action === 'toggle') void this.toggleClientKey(keyId, btn.dataset.enabled !== 'false');
      else if (action === 'delete') this.confirmDeleteClientKey(keyId);
    });

    /* Combos tab — create/edit form + row action delegation */
    this.elts.comboCreateBtn.addEventListener('click', () => {
      void this.showComboForm(null);
    });
    this.elts.comboCancelBtn.addEventListener('click', () => this.hideComboForm());
    this.elts.comboForm.addEventListener('submit', (e) => { e.preventDefault(); void this.submitCombo(); });
    /* Provider change cascades model + provider API key options (both are
     * reloaded for the NEW provider and previous selections are reset). */
    this.elts.comboProvider.addEventListener('change', () => this.renderComboModelAndKeyOptions());
    this.elts.combosTbody.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-combo-action]');
      if (!btn) return;
      const tr = btn.closest<HTMLTableRowElement>('tr[data-combo-id]');
      const comboId = tr?.dataset.comboId || '';
      if (!comboId) return;
      const action = btn.dataset.comboAction;
      if (action === 'toggle') void this.toggleCombo(comboId, btn.dataset.enabled !== 'false');
      else if (action === 'edit') void this.showComboForm(comboId);
      else if (action === 'delete') this.confirmDeleteCombo(comboId);
    });
    this.elts.apikeysTbody.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pagekey-action]');
      if (!btn) return;
      const tr = btn.closest<HTMLTableRowElement>('tr[data-key-id]');
      const providerId = tr?.dataset.keyProvider || '';
      const keyId = tr?.dataset.keyId || '';
      if (!providerId || !keyId) return;
      const action = btn.dataset.pagekeyAction;
      if (action === 'toggle') void this.togglePageApiKey(providerId, keyId, btn.dataset.enabled !== 'false');
      else if (action === 'delete') this.confirmDeletePageApiKey(providerId, keyId);
    });

    /* Model Registry tab — add form + row action delegation */
    this.elts.registryAddBtn.addEventListener('click', () => {
      this.showRegistryForm();
      this.repopulateRegistryProviderFilter();
    });
    this.elts.registryCancelBtn.addEventListener('click', () => this.hideRegistryForm());
    this.elts.registryForm.addEventListener('submit', (e) => { e.preventDefault(); void this.submitRegistryModel(); });
    this.elts.registryTbody.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-registry-action]');
      if (!btn) return;
      const tr = btn.closest<HTMLTableRowElement>('tr[data-registry-model]');
      const providerId = tr?.dataset.registryProvider || '';
      const model = tr?.dataset.registryModel || '';
      if (!providerId || !model) return;
      const action = btn.dataset.registryAction;
      if (action === 'toggle') void this.toggleRegistryModel(providerId, model, btn.dataset.enabled !== 'false');
      else if (action === 'delete') this.confirmDeleteRegistryModel(providerId, model);
    });

    /* "+ Add Provider" — providers are registered from server configuration
       (src/providers/registry.ts); the admin API intentionally has no create
       endpoint, so explain instead of pretending. */
    this.elts.addProviderBtn.addEventListener('click', () => {
      this.openConfirm({
        title: 'Add Provider',
        bodyHtml: `
          <p>Providers are registered from <strong>server configuration</strong>
          (environment variables / config files) and are loaded automatically at startup.</p>
          <p class="modal__warn">The admin API does not expose a create-provider endpoint,
          so providers cannot be added from the dashboard. Use “Manage API Keys” on a
          provider card to attach credentials, or run the server with the provider configured.</p>
        `,
        okLabel: 'Understood',
        okClass: 'btn--primary',
        onConfirm: async () => { /* informational only */ },
      });
    });

    /* Initial load */
    this.elts.copyrightYear.textContent = String(new Date().getFullYear());
    this.refreshActive(true);

    /* Auto-refresh polling: refresh the active tab's data every 30 seconds.
     * Only triggers when the page is visible (not backgrounded). Skips the
     * logs tab to avoid resetting pagination/filter state, the apikeys
     * tab to avoid re-fanning-out one request per provider, and the
     * providers (Provider Management) tab — it is MANUAL refresh only:
     * data updates when the page first loads or the operator presses the
     * Refresh button. */
    this.pollingTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (this.activeTab === 'logs' || this.activeTab === 'apikeys' || this.activeTab === 'client-keys' || this.activeTab === 'combos' || this.activeTab === 'providers') return;
      this.refreshActive(false);
    }, 30_000);

    /* Clean up the polling timer on page unload. */
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (this.pollingTimer) { clearInterval(this.pollingTimer); this.pollingTimer = null; }
      });
    }
  }

  /* -------------------------------- Tabs --------------------------------- */
  private switchTab(name: string): void {
    this.activeTab = name;
    this.elts.tabs.forEach(t => {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this.elts.panels.forEach(p => {
      const active = p.id === `tab-${name}`;
      p.classList.toggle('is-active', active);
      if (active) p.removeAttribute('hidden');
      else p.setAttribute('hidden', '');
    });
    /* Breadcrumb mirrors the active section (topbar context only). */
    const label = TAB_LABELS[name] || name;
    this.elts.breadcrumb.textContent = label;
    /* Close the mobile drawer after navigation. */
    this.elts.appShell.classList.remove('is-sidebar-open');
    this.elts.sidebarOverlay.setAttribute('hidden', '');
    this.refreshActive(false);
  }

  /* ----------------------------- Refresh ---------------------------------- */
  async refreshActive(showRefreshing: boolean): Promise<void> {
    if (showRefreshing) {
      /* Loading state + double-click guard: the button is disabled and its
         label swaps while a manual refresh is in flight. re-entrant calls
         (e.g. a second click landing anyway) return immediately. */
      if (this.refreshInFlight) return;
      this.refreshInFlight = true;
      this.elts.refreshBtn.disabled = true;
      this.elts.refreshBtn.classList.add('is-loading');
      this.elts.refreshBtn.querySelector('.btn__label')!.textContent = 'Refreshing…';
    }
    try {
      const tasks: Promise<void>[] = [];
      /* System status card + topbar pill ride along every refresh (1 light call). */
      tasks.push(this.loadSystemStatus());
      switch (this.activeTab) {
        case 'overview':
          tasks.push(this.loadUsageSummary());
          tasks.push(this.loadProvidersForOverview());
          break;
        case 'providers':
          tasks.push(this.loadProvidersForManagement());
          break;
        case 'apikeys':
          tasks.push(this.loadAllApiKeys());
          break;
        case 'client-keys':
          tasks.push(this.loadClientKeys());
          break;
        case 'combos':
          tasks.push(this.loadCombos());
          break;
        case 'registry':
          tasks.push(this.loadRegistry());
          break;
        case 'providers-usage':
          tasks.push(this.loadUsageByProvider());
          break;
        case 'models-usage':
          tasks.push(this.loadUsageByModel());
          break;
        case 'pricing':
          tasks.push(this.loadPricing());
          break;
        case 'logs':
          tasks.push(this.loadProvidersAndModelsForFilters());
          tasks.push(this.loadLogs());
          break;
        case 'backup':
          tasks.push(this.loadBackups());
          break;
      }
      await Promise.all(tasks);
      /* "Last refresh" advances only on successful loads. On the Provider
         Management tab a failed providers fetch must NOT bump the timestamp. */
      if (this.activeTab !== 'providers' || this.providersLoadOk) this.markRefreshed();
    } finally {
      if (showRefreshing) {
        this.refreshInFlight = false;
        this.elts.refreshBtn.disabled = false;
        this.elts.refreshBtn.classList.remove('is-loading');
        this.elts.refreshBtn.querySelector('.btn__label')!.textContent = 'Refresh';
      }
    }
  }

  private markRefreshed(): void {
    const now = new Date();
    const pad = (x: number) => String(x).padStart(2, '0');
    this.elts.lastRefresh.textContent = `Last refresh: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /* --------------------- System status (real runtime data) ---------------- */
  private static readonly BOOT_MS = Date.now();

  private async loadSystemStatus(): Promise<void> {
    const r = await apiJSON<{ uptime?: number; version?: string; requests?: number }>('GET', '/internal/health');
    if (!r.ok || !r.data) {
      this.elts.sysStatusText.textContent = 'Unreachable';
      this.elts.sysStatusDot.classList.remove('status-dot--ok');
      this.elts.sysStatusDot.classList.add('status-dot--bad');
      this.elts.topbarStatus.classList.add('is-down');
      return;
    }
    this.elts.sysStatusDot.classList.add('status-dot--ok');
    this.elts.sysStatusDot.classList.remove('status-dot--bad');
    this.elts.topbarStatus.classList.remove('is-down');
    this.elts.sysStatusText.textContent = 'Operational';
    /* Real uptime from the backend — never fabricated client-side. */
    if (typeof r.data.uptime === 'number') this.elts.sysUptime.textContent = formatUptime(r.data.uptime);
    if (typeof r.data.version === 'string') this.elts.appVersion.textContent = r.data.version;
  }

  /* --------------------------- Error banner ------------------------------ */
  showError(title: string, msg: string): void {
    this.elts.errorBanner.classList.remove('is-hidden');
    this.elts.errorBanner.innerHTML = `
      <div>
        <p class="error-banner__title">${esc(title)}</p>
        <p class="error-banner__msg">${esc(msg)}</p>
      </div>
    `;
    /* auto-dismiss after 6s — a single error should not dominate the UI */
    setTimeout(() => this.elts.errorBanner.classList.add('is-hidden'), 6000);
  }

  /* --------------------------- Overview loads ---------------------------- */
  private async loadUsageSummary(): Promise<void> {
    this.elts.usageSummary.setAttribute('data-state', 'loading');
    this.elts.usageSummary.innerHTML = `
      <div class="summary-card skeleton" aria-hidden="true"></div>
      <div class="summary-card skeleton" aria-hidden="true"></div>
      <div class="summary-card skeleton" aria-hidden="true"></div>
      <div class="summary-card skeleton" aria-hidden="true"></div>
    `;
    const r = await apiJSON<UsageSummary>('GET', '/admin/usage');
    if (!r.ok || !r.data) {
      renderEmpty(this.elts.usageSummary, `Failed to load usage summary: ${r.error || 'unknown error'}`, true);
      this.showError('Failed to load usage summary', r.error || 'unknown');
      return;
    }
    renderUsageSummary(this.elts.usageSummary, r.data);
  }

  private async loadProvidersForOverview(): Promise<void> {
    this.elts.overviewProviders.setAttribute('data-state', 'loading');
    this.elts.overviewProviders.innerHTML = `
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
    `;
    const r = await apiJSON<AdminProvider[]>('GET', '/admin/providers');
    if (!r.ok || !r.data) {
      renderEmpty(this.elts.overviewProviders, `Failed to load providers: ${r.error || 'unknown error'}`, true);
      return;
    }
    this.providersCache = r.data;
    renderOverviewProviders(this.elts.overviewProviders, r.data);
  }

  /* ---------------------------- Providers tab ---------------------------- */
  async loadProvidersForManagement(): Promise<void> {
    /* Keep-previous-data rule: skeletons only paint when there is nothing to
       show yet. A failed (re)load leaves the existing cards on screen and
       surfaces the error via the banner instead. */
    const hadData = this.providersCache.length > 0
      && this.elts.providersList.getAttribute('data-state') === 'loaded';
    if (!hadData) {
      this.elts.providersList.setAttribute('data-state', 'loading');
      this.elts.providersList.innerHTML = `
        <div class="skeleton skeleton--card" aria-hidden="true"></div>
        <div class="skeleton skeleton--card" aria-hidden="true"></div>
      `;
    }
    /* Provider list + real per-provider request totals, fetched in parallel
       (existing endpoints only — no extra polling). */
    const [r, usage] = await Promise.all([
      apiJSON<AdminProvider[]>('GET', '/admin/providers'),
      apiJSON<Record<string, { requests: number }>>('GET', '/admin/usage/providers'),
    ]);
    if (!r.ok || !r.data) {
      this.providersLoadOk = false;
      const msg = r.error || 'unknown error';
      if (hadData) {
        this.showError('Failed to refresh providers', `${msg} — showing the previous data until a refresh succeeds.`);
      } else {
        renderEmpty(this.elts.providersList, `Failed to load providers: ${msg}`, true);
      }
      return;
    }
    if (usage.ok && usage.data) providerRequestsCache = usage.data;
    this.providersCache = r.data;
    this.renderProvidersList(r.data);
    this.providersLoadOk = true;
    /* Re-apply the live search filter: the cards were just rebuilt, and the
       (local, network-free) filter must survive a manual refresh. */
    const query = this.elts.globalSearch.value.trim().toLowerCase();
    if (query) this.filterProviderCards(query);
  }

  /** Client-side filter of provider cards (global search, Providers tab). */
  filterProviderCards(query: string): void {
    const cards = this.elts.providersList.querySelectorAll<HTMLElement>('.provider-card');
    cards.forEach(card => {
      const hay = card.dataset.providerSearch || '';
      card.style.display = !query || hay.includes(query) ? '' : 'none';
    });
  }

  private renderProvidersList(providers: AdminProvider[]): void {
    renderProviderCards(this.elts.providersList, providers, (id, enabled) => this.confirmToggleProvider(id, enabled));
  }

  /** Confirm before flipping a provider's enabled state (Prompt 13 §3 flow). */
  private confirmToggleProvider(providerId: string, nextEnabled: boolean): void {
    const verb = nextEnabled ? 'Enable' : 'Disable';
    const provider = this.providersCache.find(p => p.id === providerId);
    const name = provider ? `${provider.name} (${provider.id})` : providerId;
    this.openConfirm({
      title: `${verb} provider`,
      bodyHtml: `
        <p>You are about to <strong>${verb.toLowerCase()}</strong> provider <strong>${esc(name)}</strong>.</p>
        ${nextEnabled ? ''
          : `<p class="modal__warn">Disabled providers reject new requests (logged as <em>blocked</em>). Usage history and model registry entries are preserved; they can be re-enabled any time.</p>`}
      `,
      okLabel: verb,
      okClass: nextEnabled ? 'btn--success' : 'btn--danger',
      onConfirm: async () => {
        await this.doToggleProvider(providerId, nextEnabled);
        /* Refresh from backend so status reflects the authoritative persisted state. */
        await this.loadProvidersForManagement();
      },
    });
  }

  private async doToggleProvider(providerId: string, enabled: boolean): Promise<void> {
    /* Optimistic feedback: disable the toggle button while in-flight */
    const card = this.elts.providersList.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(providerId)}"]`);
    const btn = card?.querySelector<HTMLButtonElement>('button.btn--xs');
    if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

    const r = await apiJSON<{ status: string; providerId: string; enabled: boolean }>(
      'PATCH',
      `/admin/providers/${encodeURIComponent(providerId)}`,
      { enabled },
    );

    if (!r.ok || !r.data) {
      this.showError(`Failed to ${enabled ? 'enable' : 'disable'} provider`, r.error || `Unknown error for ${providerId}`);
      /* Refresh from backend so the UI does NOT lie about state */
      await this.loadProvidersForManagement();
      return;
    }
  }

  /* --------------------------- Model Registry tab ------------------------- */
  private async loadRegistry(): Promise<void> {
    this.elts.registryTbody.setAttribute('data-state', 'loading');
    this.elts.registryTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="6"></td></tr>`;
    const r = await apiJSON<RegistryProvider[]>('GET', '/admin/models');
    if (!r.ok || !r.data) {
      this.elts.registryTbody.setAttribute('data-state', 'error');
      this.elts.registryTbody.innerHTML = `<tr><td colspan="6" class="state-error">Failed to load model registry: ${esc(r.error || 'unknown')}</td></tr>`;
      return;
    }
    renderRegistry(this.elts.registryTbody, r.data);
  }

  private repopulateRegistryProviderFilter(): void {
    const options = ['<option value="">— provider —</option>']
      .concat(this.providersCache.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`))
      .join('');
    this.elts.registryProvider.innerHTML = options;
  }

  private showRegistryForm(): void {
    this.elts.registryForm.classList.remove('is-hidden');
    this.repopulateRegistryProviderFilter();
    this.elts.registryProvider.focus();
  }

  private hideRegistryForm(): void {
    this.elts.registryForm.classList.add('is-hidden');
    this.elts.registryForm.reset();
    this.elts.registryError.classList.add('is-hidden');
  }

  private async submitRegistryModel(): Promise<void> {
    const providerId = this.elts.registryProvider.value.trim();
    const model = this.elts.registryModel.value.trim();
    const backendModel = this.elts.registryBackendModel.value.trim();
    const priorityRaw = this.elts.registryPriority.value.trim();
    if (!providerId) { this.showRegistryError('Provider is required'); return; }
    if (!model) { this.showRegistryError('Model ID is required'); return; }
    const priority = priorityRaw ? parseInt(priorityRaw, 10) : 100;
    if (!Number.isFinite(priority) || priority < 1) { this.showRegistryError('Priority must be a positive integer'); return; }

    this.elts.registrySaveBtn.disabled = true;
    this.elts.registrySaveBtn.textContent = 'Saving…';
    const r = await apiJSON<{ status: string }>('POST', '/admin/models', {
      model, providerId, priority,
      ...(backendModel ? { backendModel } : {}),
    });
    this.elts.registrySaveBtn.disabled = false;
    this.elts.registrySaveBtn.textContent = 'Save';
    if (!r.ok) {
      this.showRegistryError(r.error || 'Failed to register model');
      return;
    }
    this.hideRegistryForm();
    await this.loadRegistry();
  }

  private showRegistryError(message: string): void {
    this.elts.registryError.textContent = message;
    this.elts.registryError.classList.remove('is-hidden');
  }

  private async toggleRegistryModel(providerId: string, model: string, enabled: boolean): Promise<void> {
    const path = `/admin/models/${encodeURIComponent(providerId)}/${encodeURIComponent(model)}`;
    const r = await apiJSON('PATCH', path, { enabled });
    if (!r.ok) {
      this.showError(`Failed to ${enabled ? 'enable' : 'disable'} model`, r.error || 'unknown');
      return;
    }
    await this.loadRegistry();
  }

  private confirmDeleteRegistryModel(providerId: string, model: string): void {
    this.openConfirm({
      title: 'Remove model registration?',
      bodyHtml: `
        <p>Remove <strong><code>${esc(model)}</code></strong> from provider
        <strong>${esc(providerId)}</strong>?</p>
        <p class="modal__warn">The model stops being served via <code>/v1/models</code>.
        Historical usage records are preserved.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => {
        const path = `/admin/models/${encodeURIComponent(providerId)}/${encodeURIComponent(model)}`;
        const r = await apiJSON('DELETE', path);
        if (!r.ok) {
          this.showError('Failed to remove model', r.error || 'unknown');
          return;
        }
        await this.loadRegistry();
      },
    });
  }

  /* ----------------------- API Key Management page ------------------------ */
  /** Aggregated over the existing per-provider endpoints (no new backend API).
   *  Loaded on tab entry / after mutations; excluded from 30 s polling. */
  private async loadAllApiKeys(): Promise<void> {
    this.elts.apikeysTbody.setAttribute('data-state', 'loading');
    this.elts.apikeysTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="6"></td></tr>`;
    const pr = await apiJSON<AdminProvider[]>('GET', '/admin/providers');
    if (!pr.ok || !pr.data) {
      this.elts.apikeysTbody.setAttribute('data-state', 'error');
      this.elts.apikeysTbody.innerHTML = `<tr><td colspan="6" class="state-error">Failed to load providers: ${esc(pr.error || 'unknown')}</td></tr>`;
      return;
    }
    this.providersCache = pr.data;
    const results = await Promise.all(
      pr.data.map(async p => ({ p: { id: p.id, name: p.name }, r: await apiJSON<ApiKeysResponse>('GET', `/admin/providers/${encodeURIComponent(p.id)}/api-keys`) })),
    );
    const rows: ApiKeyRow[] = [];
    for (const { p, r } of results) {
      if (!r.ok || !r.data) continue;
      for (const k of r.data.keys) rows.push({ p, k });
    }
    this.elts.apikeysTbody.setAttribute('data-state', 'loaded');
    this.elts.apikeysTbody.innerHTML = renderAllApiKeysHTML(rows);
  }

  private showPageApikeyForm(): void {
    this.elts.pageApikeyForm.classList.remove('is-hidden');
    this.elts.pageApikeyProvider.innerHTML = ['<option value="">— provider —</option>']
      .concat(this.providersCache.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`))
      .join('');
    this.elts.pageApikeyProvider.focus();
  }

  private hidePageApikeyForm(): void {
    this.elts.pageApikeyForm.classList.add('is-hidden');
    this.elts.pageApikeyForm.reset();
    this.elts.pageApikeyError.classList.add('is-hidden');
  }

  private async submitPageApiKey(): Promise<void> {
    const providerId = this.elts.pageApikeyProvider.value.trim();
    const apiKey = this.elts.pageApikeyInput.value.trim();
    const label = this.elts.pageApikeyLabel.value.trim();
    if (!providerId) { this.showPageApikeyError('Provider is required'); return; }
    if (!apiKey) { this.showPageApikeyError('API key must not be empty'); return; }
    this.elts.pageApikeySaveBtn.disabled = true;
    this.elts.pageApikeySaveBtn.textContent = 'Saving…';
    const r = await apiJSON<{ success: boolean }>('POST', `/admin/providers/${encodeURIComponent(providerId)}/api-keys`,
      { apiKey, label: label || undefined });
    /* Never keep the raw key around in the DOM after submit. */
    this.elts.pageApikeyInput.value = '';
    this.elts.pageApikeySaveBtn.disabled = false;
    this.elts.pageApikeySaveBtn.textContent = 'Save';
    if (!r.ok) {
      this.showPageApikeyError(r.error || 'Failed to add API key');
      return;
    }
    this.hidePageApikeyForm();
    await this.loadAllApiKeys();
  }

  private showPageApikeyError(message: string): void {
    this.elts.pageApikeyError.textContent = message;
    this.elts.pageApikeyError.classList.remove('is-hidden');
  }

  private async togglePageApiKey(providerId: string, keyId: string, enabled: boolean): Promise<void> {
    const r = await apiJSON<{ status: string }>(
      'PATCH',
      `/admin/providers/${encodeURIComponent(providerId)}/api-keys/${encodeURIComponent(keyId)}`,
      { enabled },
    );
    if (!r.ok) {
      this.showError(`Failed to ${enabled ? 'enable' : 'disable'} API key`, r.error || 'unknown');
      return;
    }
    await this.loadAllApiKeys();
  }

  private confirmDeletePageApiKey(providerId: string, keyId: string): void {
    const row = this.elts.apikeysTbody.querySelector<HTMLElement>(`tr[data-key-provider="${CSS.escape(providerId)}"][data-key-id="${CSS.escape(keyId)}"]`);
    const masked = row?.querySelector('.cell-mono')?.textContent?.trim() || keyId;
    this.openConfirm({
      title: 'Delete API Key?',
      bodyHtml: `
        <p>You are about to delete an API key from <strong>${esc(providerNameFor(providerId))}</strong>.</p>
        <p>Key: <code>${esc(masked)}</code></p>
        <p class="modal__warn">The key stops being used for new requests immediately and is removed from persistent storage. This cannot be undone.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => {
        const r = await apiJSON(
          'DELETE',
          `/admin/providers/${encodeURIComponent(providerId)}/api-keys/${encodeURIComponent(keyId)}`,
        );
        if (!r.ok) {
          this.showError('Failed to delete API key', r.error || 'unknown');
          return;
        }
        await this.loadAllApiKeys();
      },
    });
  }

  /* ------------------------ Client API Keys tab -------------------------- */
  /** Create-form state: catalog fetched from the registry (never hardcoded). */
  private clientKeyCatalog: ClientKeyCatalog['providers'] = [];
  private clientKeyModelsCache: Map<string, string[]> = new Map();

  private async loadClientKeys(): Promise<void> {
    this.elts.clientKeysTbody.setAttribute('data-state', 'loading');
    this.elts.clientKeysTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="9"></td></tr>`;
    const r = await apiJSON<{ keys: ClientKeyRecord[] }>('GET', '/admin/client-keys');
    if (!r.ok || !r.data) {
      this.elts.clientKeysTbody.setAttribute('data-state', 'error');
      this.elts.clientKeysTbody.innerHTML = `<tr><td colspan="9" class="state-error">Failed to load client keys: ${esc(r.error || 'unknown')}</td></tr>`;
      return;
    }
    this.elts.clientKeysTbody.setAttribute('data-state', 'loaded');
    this.elts.clientKeysTbody.innerHTML = renderClientKeysHTML(r.data.keys);
  }

  private async showClientKeyForm(): Promise<void> {
    /* Providers/models always come from the live registry catalog — a newly
     * registered provider appears here without any frontend change. */
    const r = await apiJSON<ClientKeyCatalog>('GET', '/admin/client-keys/catalog');
    this.clientKeyCatalog = (r.ok && r.data) ? r.data.providers : [];
    if (!r.ok || !r.data) {
      this.showClientKeyError(`Failed to load provider catalog: ${r.error || 'unknown'}`);
    }
    if (this.clientKeyCatalog.length === 0) {
      this.showClientKeyError('No providers are registered. Configure a provider on the server first.');
      return;
    }
    this.elts.clientkeyProvider.innerHTML = ['<option value="">— select provider —</option>']
      .concat(this.clientKeyCatalog.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)}) — ${p.models.length} model${p.models.length === 1 ? '' : 's'}</option>`))
      .join('');
    this.elts.clientkeyProviderSearch.value = '';
    this.elts.clientkeyModelSearch.value = '';
    this.elts.clientkeyModelSearchWrap.classList.add('is-hidden');
    this.elts.clientkeyModelsEmpty.classList.add('is-hidden');
    this.elts.clientkeyModels.innerHTML = `<p class="cell-dim">Select a provider first.</p>`;
    this.renderProviderPicker();
    this.elts.clientkeyResult.classList.add('is-hidden');
    this.elts.clientkeyForm.classList.remove('is-hidden');
    this.elts.clientkeyProviderSearch.focus();
  }

  private hideClientKeyForm(): void {
    this.elts.clientkeyForm.classList.add('is-hidden');
    this.elts.clientkeyForm.reset();
    this.elts.clientkeyModels.innerHTML = '';
    this.elts.clientkeyModelsEmpty.classList.add('is-hidden');
    this.elts.clientkeyModelSearchWrap.classList.add('is-hidden');
    this.elts.clientkeyError.classList.add('is-hidden');
  }

  /** Renders the model checklist for the selected provider — ONLY that
   *  provider's registered models, straight from the catalog cache. */
  private renderClientKeyModels(): void {
    const providerId = this.elts.clientkeyProvider.value;
    this.elts.clientkeyModelSearch.value = '';
    this.elts.clientkeyModelsEmpty.classList.add('is-hidden');
    if (!providerId) {
      this.elts.clientkeyModelSearchWrap.classList.add('is-hidden');
      this.elts.clientkeyModelCount.textContent = '';
      this.elts.clientkeyModels.innerHTML = `<p class="cell-dim">Select a provider first.</p>`;
      return;
    }
    const models = this.clientKeyCatalog.find(p => p.id === providerId)?.models || [];
    if (models.length === 0) {
      this.elts.clientkeyModelSearchWrap.classList.add('is-hidden');
      this.elts.clientkeyModelCount.textContent = '';
      this.elts.clientkeyModels.innerHTML = `<p class="cell-dim">No models registered for this provider.</p>`;
      return;
    }
    this.elts.clientkeyModels.innerHTML = models.map(m => `
      <label class="clientkey-model">
        <input type="checkbox" name="clientkey-model" value="${esc(m)}" />
        <span class="cell-mono">${esc(m)}</span>
      </label>
    `).join('');
    this.elts.clientkeyModelSearchWrap.classList.remove('is-hidden');
    this.filterClientKeyModels();
  }

  /* ── Searchable provider picker / model filter (client-side only) ────────
   * The native <select> stays the selection source of truth: picking a row
   * sets select.value and dispatches the existing 'change' cascade that
   * renders the model checklist. Both filters read the catalog already held
   * in memory — NO request per keystroke — and never rewrite a model id or
   * provider id: they only show/hide rows that are rendered from the data
   * verbatim. ──────────────────────────────────────────────────────────────── */

  /** Filters picker rows by provider NAME or provider ID (case-insensitive
   *  partial match); the provider's model count stays visible on each row. */
  private renderProviderPicker(): void {
    const q = this.elts.clientkeyProviderSearch.value;
    const selected = this.elts.clientkeyProvider.value;
    const hits = filterProviderCatalog(this.clientKeyCatalog, q);
    this.elts.clientkeyProviderList.innerHTML = hits.length === 0
      ? `<p class="ck-empty">No providers found</p>`
      : hits.map(p => `
      <button type="button" role="option" aria-selected="${p.id === selected}" class="ck-row ck-provider__row${p.id === selected ? ' is-selected' : ''}" data-provider-id="${esc(p.id)}">
        <span>${esc(p.name)} (${esc(p.id)})</span>
        <span class="ck-count">${p.models.length} model${p.models.length === 1 ? '' : 's'}</span>
      </button>`).join('');
  }

  /** Picker click: adopt the provider through the EXISTING mechanism — set
   *  the select value and fire its 'change' event (→ renderClientKeyModels). */
  private selectClientKeyProvider(providerId: string): void {
    if (this.elts.clientkeyProvider.value !== providerId) {
      this.elts.clientkeyProvider.value = providerId;
      this.elts.clientkeyProvider.dispatchEvent(new Event('change'));
    }
    this.renderProviderPicker();
  }

  /** Filters the rendered model rows by model id (case-insensitive partial
   *  match) WITHOUT re-rendering: checked boxes on hidden rows keep their
   *  state, so clearing the search restores the exact prior selection.
   *  A 'No models found' line appears only when the filter matches nothing. */
  private filterClientKeyModels(): void {
    const q = this.elts.clientkeyModelSearch.value;
    const rows = Array.from(this.elts.clientkeyModels.querySelectorAll<HTMLElement>('.clientkey-model'));
    let visible = 0;
    for (const row of rows) {
      const id = row.querySelector<HTMLInputElement>('input[name="clientkey-model"]')?.value ?? '';
      const hit = matchesSearchFilter(q, id);
      row.style.display = hit ? '' : 'none';
      if (hit) visible++;
    }
    this.elts.clientkeyModelCount.textContent = rows.length > 0
      ? (q ? `${visible}/${rows.length}` : `${rows.length}`)
      : '';
    this.elts.clientkeyModelsEmpty.classList.toggle('is-hidden', !(rows.length > 0 && visible === 0));
  }

  private async submitCreateClientKey(): Promise<void> {
    const providerId = this.elts.clientkeyProvider.value;
    const label = this.elts.clientkeyLabel.value.trim();
    const allowedModels = Array.from(
      this.elts.clientkeyModels.querySelectorAll<HTMLInputElement>('input[name="clientkey-model"]:checked'),
    ).map(i => i.value);
    if (!providerId) { this.showClientKeyError('Provider is required — select one first'); return; }
    if (allowedModels.length === 0) { this.showClientKeyError('Select at least one allowed model'); return; }
    this.elts.clientkeySaveBtn.disabled = true;
    this.elts.clientkeySaveBtn.textContent = 'Creating…';
    const r = await apiJSON<{ success: boolean; key: ClientKeyRecord; apiKey: string }>(
      'POST', '/admin/client-keys', { providerId, allowedModels, label: label || undefined });
    this.elts.clientkeySaveBtn.disabled = false;
    this.elts.clientkeySaveBtn.textContent = 'Create API Key';
    if (!r.ok || !r.data) {
      this.showClientKeyError(r.error || 'Failed to create API key');
      return;
    }
    /* Show the raw key ONCE; nothing is kept in the DOM form afterwards. */
    this.elts.clientkeyForm.classList.add('is-hidden');
    this.elts.clientkeyForm.reset();
    this.elts.clientkeyError.classList.add('is-hidden');
    this.elts.clientkeyResultKey.textContent = r.data.apiKey;
    const k = r.data.key;
    this.elts.clientkeyResultMeta.textContent =
      `Provider: ${k.providerId} · Allowed models: ${k.allowedModels.join(', ')}`;
    this.elts.clientkeyResult.classList.remove('is-hidden');
    await this.loadClientKeys();
  }

  private showClientKeyError(message: string): void {
    this.elts.clientkeyError.textContent = message;
    this.elts.clientkeyError.classList.remove('is-hidden');
  }

  private async toggleClientKey(keyId: string, enabled: boolean): Promise<void> {
    const r = await apiJSON<{ status: string }>('PATCH', `/admin/client-keys/${encodeURIComponent(keyId)}`, { enabled });
    if (!r.ok) {
      this.showError(`Failed to ${enabled ? 'enable' : 'disable'} client API key`, r.error || 'unknown');
      return;
    }
    await this.loadClientKeys();
  }

  private confirmDeleteClientKey(keyId: string): void {
    const row = this.elts.clientKeysTbody.querySelector<HTMLElement>(`tr[data-clientkey-id="${CSS.escape(keyId)}"]`);
    const masked = row?.querySelector('.cell-mono')?.textContent?.trim() || keyId;
    this.openConfirm({
      title: 'Delete Client API Key?',
      bodyHtml: `
        <p>You are about to delete client API key <strong>${esc(masked)}</strong>.</p>
        <p class="modal__warn">Clients using this key immediately lose access. This cannot be undone.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => {
        const r = await apiJSON('DELETE', `/admin/client-keys/${encodeURIComponent(keyId)}`);
        if (!r.ok) {
          this.showError('Failed to delete client API key', r.error || 'unknown');
          return;
        }
        await this.loadClientKeys();
      },
    });
  }

  /* ----------------------------- Combos tab -------------------------------
   * Client → Provider → Model → Provider API Key. The form's model and
   * provider-API-key dropdowns are ALWAYS rebuilt from the backend catalog
   * for the selected provider — changing the provider resets both. */
  private comboCatalog: ComboCatalog | null = null;
  private editingComboId: string | null = null;

  private async loadCombos(): Promise<void> {
    this.elts.combosTbody.setAttribute('data-state', 'loading');
    this.elts.combosTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="9"></td></tr>`;
    const r = await apiJSON<{ combos: ComboRecord[] }>('GET', '/admin/combos');
    if (!r.ok || !r.data) {
      this.elts.combosTbody.setAttribute('data-state', 'error');
      const detail = r.error || 'unknown';
      const withStatus = r.status ? `${detail} (HTTP ${r.status})` : detail;
      this.elts.combosTbody.innerHTML = `<tr><td colspan="9" class="state-error">Failed to load combos: ${esc(withStatus)}</td></tr>`;
      return;
    }
    this.elts.combosTbody.setAttribute('data-state', 'loaded');
    this.elts.combosTbody.innerHTML = renderCombosHTML(r.data.combos);
  }

  private async showComboForm(comboId: string | null): Promise<void> {
    /* Providers/models/keys/client-keys always come from the live catalog —
     * nothing is hardcoded in the frontend. */
    const r = await apiJSON<ComboCatalog>('GET', '/admin/combos/catalog');
    this.comboCatalog = (r.ok && r.data) ? r.data : null;
    if (!this.comboCatalog) {
      this.showComboError(`Failed to load combo catalog: ${r.error || 'unknown'}`);
      return;
    }
    const cat = this.comboCatalog;
    this.elts.comboClient.innerHTML = ['<option value="">— select client API key —</option>']
      .concat(cat.clientKeys.map(k =>
        `<option value="${esc(k.id)}">${esc(k.label || k.maskedKey)} · ${esc(k.maskedKey)} · ${esc(k.providerId)}</option>`))
      .join('');
    this.elts.comboProvider.innerHTML = '<option value="">— select a client API key first —</option>';
    this.elts.comboProvider.disabled = true;
    this.editingComboId = comboId;
    this.elts.comboSaveBtn.textContent = comboId ? 'Save Changes' : 'Create Combo';

    if (comboId) {
      /* Edit mode: prefill from the listed combos (masked metadata only). */
      const list = await apiJSON<{ combos: ComboRecord[] }>('GET', '/admin/combos');
      const combo = (list.ok && list.data) ? list.data.combos.find(c => c.id === comboId) : null;
      if (!combo) {
        this.showComboError('Combo not found — it may have been deleted.');
        return;
      }
      this.elts.comboClient.value = combo.clientKeyId;
      this.elts.comboProvider.value = combo.providerId;
      this.renderComboModelAndKeyOptions();
      this.elts.comboModel.value = combo.model;
      this.elts.comboKey.value = combo.providerKeyId || '';
      if (!this.elts.comboModel.value) {
        this.showComboError(`Model "${combo.model}" is no longer registered for provider "${combo.providerId}". Pick another one.`);
      }
    } else {
      this.renderComboProviderOptions();
      this.renderComboModelAndKeyOptions();
    }
    this.elts.comboForm.classList.remove('is-hidden');
    this.elts.comboClient.focus();
  }

  private hideComboForm(): void {
    this.elts.comboForm.classList.add('is-hidden');
    this.elts.comboForm.reset();
    this.editingComboId = null;
    this.showComboError('');
    this.elts.comboError.classList.add('is-hidden');
  }

  /** Providers are constrained by the selected client key's provider. */
  private renderComboProviderOptions(): void {
    const client = this.comboCatalog?.clientKeys.find(k => k.id === this.elts.comboClient.value);
    const providerId = client?.providerId || '';
    const provider = this.comboCatalog?.providers.find(p => p.id === providerId);
    if (!client || !provider) {
      this.elts.comboProvider.disabled = true;
      this.elts.comboProvider.innerHTML = '<option value="">— select a client API key first —</option>';
      return;
    }
    this.elts.comboProvider.disabled = false;
    this.elts.comboProvider.innerHTML = `<option value="${esc(provider.id)}">${esc(provider.name)} (${esc(provider.id)}) — ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}, ${provider.apiKeys.length} key${provider.apiKeys.length === 1 ? '' : 's'}</option>`;
    this.elts.comboProvider.value = provider.id;
  }

  /** Rebuilds the model + provider API key dropdowns for the SELECTED
   *  provider and RESETS both selections. A provider change can never leave
   *  a stale model or a foreign provider's key in the form. */
  private renderComboModelAndKeyOptions(): void {
    const providerId = this.elts.comboProvider.value;
    const entry = this.comboCatalog?.providers.find(p => p.id === providerId);
    if (!providerId || !entry) {
      this.elts.comboModel.value = '';
      this.elts.comboKey.value = '';
      this.elts.comboModel.disabled = true;
      this.elts.comboKey.disabled = true;
      this.elts.comboModel.innerHTML = `<option value="">— select a provider first —</option>`;
      this.elts.comboKey.innerHTML = `<option value="">— select a provider first —</option>`;
      return;
    }
    this.elts.comboModel.disabled = entry.models.length === 0;
    this.elts.comboModel.value = '';
    this.elts.comboModel.innerHTML = ['<option value="">— select model —</option>']
      .concat(entry.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`))
      .join('');
    this.elts.comboKey.disabled = false;
    this.elts.comboKey.value = '';
    /* Empty value = provider-wide multi-key rotation (providerKeyId: null). */
    this.elts.comboKey.innerHTML = ['<option value="">All keys — provider multi-key rotation</option>']
      .concat(entry.apiKeys.map(k =>
        `<option value="${esc(k.id)}">${esc(k.label || k.maskedKey)} · ${esc(k.maskedKey)}</option>`))
      .join('');
  }

  private async submitCombo(): Promise<void> {
    const clientKeyId = this.elts.comboClient.value;
    const providerId = this.elts.comboProvider.value;
    const model = this.elts.comboModel.value;
    const providerKeyId = this.elts.comboKey.value || null;
    if (!clientKeyId) { this.showComboError('Client API key is required'); return; }
    if (!providerId) { this.showComboError('Provider is required'); return; }
    if (!model) { this.showComboError('Model is required — select one of the provider\'s models'); return; }
    this.elts.comboSaveBtn.disabled = true;
    this.elts.comboSaveBtn.textContent = this.editingComboId ? 'Saving…' : 'Creating…';
    let r: { ok: boolean; error?: string | null; data?: any };
    if (this.editingComboId) {
      r = await apiJSON<{ status: string }>(
        'PATCH', `/admin/combos/${encodeURIComponent(this.editingComboId)}`,
        { clientKeyId, providerId, model, providerKeyId });
    } else {
      r = await apiJSON<{ success: boolean; combo: ComboRecord }>(
        'POST', '/admin/combos', { clientKeyId, providerId, model, providerKeyId });
    }
    this.elts.comboSaveBtn.disabled = false;
    this.elts.comboSaveBtn.textContent = this.editingComboId ? 'Save Changes' : 'Create Combo';
    if (!r.ok) {
      this.showComboError(r.error || 'Failed to save combo');
      return;
    }
    this.hideComboForm();
    await this.loadCombos();
  }

  private showComboError(message: string): void {
    this.elts.comboError.textContent = message;
    this.elts.comboError.classList.toggle('is-hidden', !message);
  }

  private async toggleCombo(comboId: string, enabled: boolean): Promise<void> {
    const r = await apiJSON<{ status: string }>('PATCH', `/admin/combos/${encodeURIComponent(comboId)}`, { enabled });
    if (!r.ok) {
      this.showError('Failed to update combo', r.error || 'unknown');
      return;
    }
    await this.loadCombos();
  }

  private confirmDeleteCombo(comboId: string): void {
    this.openConfirm({
      title: 'Delete Combo?',
      bodyHtml: `
        <p>You are about to delete combo <strong>${esc(comboId)}</strong>.</p>
        <p class="modal__warn">The client key loses the pinned routing (and any combo-granted model access) immediately. This cannot be undone.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => {
        const r = await apiJSON('DELETE', `/admin/combos/${encodeURIComponent(comboId)}`);
        if (!r.ok) {
          this.showError('Failed to delete combo', r.error || 'unknown');
          return;
        }
        await this.loadCombos();
      },
    });
  }

  /* ------------------------- Providers usage tab ------------------------- */
  private async loadUsageByProvider(): Promise<void> {
    this.elts.usageProviderTbody.setAttribute('data-state', 'loading');
    this.elts.usageProviderTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="9"></td></tr>`;
    this.elts.usageChart.setAttribute('data-state', 'loading');
    this.elts.usageChart.innerHTML = `
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
      <div class="skeleton skeleton--row" aria-hidden="true"></div>
    `;
    const r = await apiJSON<Record<string, ProviderBreakdown>>('GET', '/admin/usage/providers');
    if (!r.ok || !r.data) {
      renderEmpty(this.elts.usageProviderTbody, `Failed to load provider usage: ${r.error || 'unknown error'}`, true);
       this.elts.usageProviderTbody.innerHTML = `<tr><td colspan="10" class="state-error">Failed to load provider usage: ${esc(r.error || 'unknown')}</td></tr>`;
      this.elts.usageChart.setAttribute('data-state', 'error');
      this.elts.usageChart.innerHTML = `<div class="state-error">Failed to load chart: ${esc(r.error || 'unknown')}</div>`;
      return;
    }
    renderProviderUsage(this.elts.usageProviderTbody, r.data);
    /* Chart reuses the exact same payload — no extra API request. */
    this.elts.usageChart.setAttribute('data-state', 'loaded');
    this.elts.usageChart.innerHTML = renderUsageChartHTML(r.data);
  }

  /* --------------------------- Models usage tab -------------------------- */
  private async loadUsageByModel(): Promise<void> {
    this.elts.usageModelTbody.setAttribute('data-state', 'loading');
     this.elts.usageModelTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="13"></td></tr>`;
    const r = await apiJSON<Record<string, ModelBreakdown>>('GET', '/admin/usage/models');
    if (!r.ok || !r.data) {
       this.elts.usageModelTbody.innerHTML = `<tr><td colspan="13" class="state-error">Failed to load model usage: ${esc(r.error || 'unknown')}</td></tr>`;
      return;
    }
    renderModelUsage(this.elts.usageModelTbody, r.data);
  }

  /* ------------------------------- Logs tab ------------------------------ */
  private async loadProvidersAndModelsForFilters(): Promise<void> {
    /* Provider filter dropdown values come from the provider registry, NOT hardcoded. */
    const r = await apiJSON<AdminProvider[]>('GET', '/admin/providers');
    if (!r.ok || !r.data) return;
    this.providersCache = r.data;
    this.repopulateProviderFilter();
    this.repopulateModelFilter();
  }

  private repopulateProviderFilter(): void {
    const select = this.elts.filterProvider;
    const current = select.value;
    /* Preserve "All" + previously selected; rebuild from provider registry */
    select.innerHTML = `<option value="">All</option>`;
    this.providersCache.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.id})`;
      select.appendChild(opt);
    });
    if (current && this.providersCache.some(p => p.id === current)) {
      select.value = current;
    }
  }

  private repopulateModelFilter(): void {
    const select = this.elts.filterModel;
    const current = select.value;
    select.innerHTML = `<option value="">All</option>`;
    /* If a provider is selected, only its models appear; otherwise all. */
    const providerId = this.elts.filterProvider.value;
    const models = new Map<string, string>();
    this.providersCache.forEach(p => {
      if (providerId && p.id !== providerId) return;
      p.models.forEach(m => {
        if (!models.has(m.model)) models.set(m.model, m.model);
      });
    });
    Array.from(models.keys()).sort().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    });
    if (current && models.has(current)) {
      select.value = current;
    }
  }

  private collectFiltersFromForm(): LogsFilters {
    return {
      provider: this.elts.filterProvider.value || '',
      model: this.elts.filterModel.value || '',
      status: this.elts.filterStatus.value || '',
      from: fromLocalDatetimeInput(this.elts.filterFrom.value),
      to: fromLocalDatetimeInput(this.elts.filterTo.value),
      search: this.elts.filterSearch.value.trim(),
    };
  }

  private applyFilters(): void {
    this.logsFilters = this.collectFiltersFromForm();
    this.logsOffset = 0;
    this.loadLogs();
  }

  private resetFilters(): void {
    this.elts.logsFilters.reset();
    this.logsFilters = { provider: '', model: '', status: '', from: undefined, to: undefined, search: '' };
    this.repopulateProviderFilter();
    this.repopulateModelFilter();
    this.logsOffset = 0;
    this.loadLogs();
  }

  private buildLogsQuery(): string {
    const params = new URLSearchParams();
    params.set('limit', String(LOGS_PAGE_SIZE));
    params.set('offset', String(this.logsOffset));
    if (this.logsFilters.provider) params.set('provider', this.logsFilters.provider);
    if (this.logsFilters.model)    params.set('model', this.logsFilters.model);
    if (this.logsFilters.status)   params.set('status', this.logsFilters.status);
    if (this.logsFilters.from)     params.set('from', String(this.logsFilters.from));
    if (this.logsFilters.to)       params.set('to', String(this.logsFilters.to));
    if (this.logsFilters.search)    params.set('search', this.logsFilters.search);
    return `/admin/logs?${params.toString()}`;
  }

  private async loadLogs(): Promise<void> {
    this.elts.logsTbody.setAttribute('data-state', 'loading');
     this.elts.logsTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="12"></td></tr>`;
    this.elts.logsRange.textContent = `Loading…`;
    this.elts.logsPrev.disabled = true;
    this.elts.logsNext.disabled = true;

    const r = await apiJSON<LogsResponse>('GET', this.buildLogsQuery());
    if (!r.ok || !r.data) {
       this.elts.logsTbody.innerHTML = `<tr><td colspan="12" class="state-error">Failed to load logs: ${esc(r.error || 'unknown')}</td></tr>`;
      this.elts.logsRange.textContent = DASH;
      this.showError('Failed to load logs', r.error || 'unknown');
      return;
    }
    this.logsTotal = r.data.total;
    renderLogs(this.elts.logsTbody, r.data, (idx) => this.openLogDetail(idx), this.logsOffset);
    this.updatePagination();
  }

  private updatePagination(): void {
    const start = this.logsTotal === 0 ? 0 : this.logsOffset + 1;
    const end = Math.min(this.logsOffset + LOGS_PAGE_SIZE, this.logsTotal);
    this.elts.logsRange.textContent = `${start}–${end} of ${this.logsTotal.toLocaleString()}`;
    this.elts.logsPrev.disabled = this.logsOffset === 0;
    this.elts.logsNext.disabled = this.logsOffset + LOGS_PAGE_SIZE >= this.logsTotal;
  }

  /* --------------------------- Log detail modal --------------------------- */
  private openModal(): void {
    this.elts.modal.classList.remove('is-hidden');
  }

  private closeModal(): void {
    this.elts.modal.classList.add('is-hidden');
  }

  /** Reusable confirmation dialog (used for Disable provider, Restore, Delete backup). */
  openConfirm(opts: {
    title: string;
    bodyHtml: string;
    okLabel: string;
    okClass?: string;
    onConfirm: () => void | Promise<void>;
  }): void {
    this.elts.confirmTitle.textContent = opts.title;
    this.elts.confirmBody.innerHTML = opts.bodyHtml;
    this.elts.confirmOk.textContent = opts.okLabel;
    /* Reset OK button classes to skeleton then apply the requested variant. */
    this.elts.confirmOk.className = `btn ${opts.okClass || 'btn--danger'}`;
    /* Detach any previous handler by cloning the node (cheap & foolproof). */
    const fresh = this.elts.confirmOk.cloneNode(true) as HTMLButtonElement;
    this.elts.confirmOk.replaceWith(fresh);
    this.elts.confirmOk = fresh;
    /* The previous action may have left the button disabled with "Working…" as
       its label — a cloned node copies both, which would silently swallow the
       next click. Reset the state for the new confirmation. */
    fresh.disabled = false;
    fresh.textContent = opts.okLabel;
    fresh.addEventListener('click', async () => {
      fresh.disabled = true;
      fresh.textContent = 'Working…';
      try {
        if (this.confirmHandler) await this.confirmHandler();
      } finally {
        this.closeConfirm();
      }
    });
    this.confirmHandler = opts.onConfirm;
    this.elts.confirmModal.classList.remove('is-hidden');
  }

  private closeConfirm(): void {
    this.elts.confirmModal.classList.add('is-hidden');
    this.confirmHandler = null;
  }

  private async openLogDetail(index: number): Promise<void> {
    this.openModal();
    renderLogDetail(this.elts.modalBody, null, true, null);
    /* We use /admin/usage/records/:index to fetch detail (exact same data as the log row).
     * The current Logs filters are forwarded so the index resolves against the
     * same filtered+sorted (DESC) list the row came from. */
    const params = new URLSearchParams();
    if (this.logsFilters.provider) params.set('provider', this.logsFilters.provider);
    if (this.logsFilters.model)    params.set('model', this.logsFilters.model);
    if (this.logsFilters.status)   params.set('status', this.logsFilters.status);
    if (this.logsFilters.from)     params.set('from', String(this.logsFilters.from));
    if (this.logsFilters.to)        params.set('to', String(this.logsFilters.to));
    if (this.logsFilters.search)    params.set('search', this.logsFilters.search);
    const qs = params.toString();
    const url = qs ? `/admin/usage/records/${index}?${qs}` : `/admin/usage/records/${index}`;
    const r = await apiJSON<UsageRecord>('GET', url);
    if (!r.ok) {
      renderLogDetail(this.elts.modalBody, null, false, r.error || 'Failed to load record');
      return;
    }
    renderLogDetail(this.elts.modalBody, r.data, false, null);
  }

  /* ------------------------------ Pricing tab ----------------------------- */
  private pricingEditingId: string | null = null;
  /** Cached GET /admin/pricing rows for edit-prefill lookups. */
  private pricingCache: PricingEntry[] = [];

  async loadPricing(): Promise<void> {
    this.elts.pricingTbody.setAttribute('data-state', 'loading');
    this.elts.pricingTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="8"></td></tr>`;
    /* Provider dropdown needs registered providers; reuse the cache or load it. */
    if (this.providersCache.length === 0) {
      const pr = await apiJSON<AdminProvider[]>('GET', '/admin/providers');
      if (pr.ok && pr.data) this.providersCache = pr.data;
    }
    const r = await apiJSON<PricingResponse>('GET', '/admin/pricing');
    if (!r.ok || !r.data) {
      this.elts.pricingTbody.setAttribute('data-state', 'error');
      this.elts.pricingTbody.innerHTML = `<tr><td colspan="8" class="state-error">Failed to load pricing: ${esc(r.error || 'unknown')}</td></tr>`;
      return;
    }
    this.pricingCache = [...r.data.entries, ...r.data.builtin];
    this.renderPricingTable(r.data);
  }

  private renderPricingTable(data: PricingResponse): void {
    this.elts.pricingTbody.setAttribute('data-state', 'loaded');
    /* Refresh provider dropdown (registered providers only). */
    this.elts.pricingProvider.innerHTML = ['<option value="">— provider —</option>']
      .concat(this.providersCache.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`))
      .join('');

    const row = (e: PricingEntry, isStored: boolean) => `
      <tr class="${isStored ? '' : 'is-muted'}" data-pricing-id="${esc(e.id)}">
        <td class="cell-mono">${esc(e.providerId)}</td>
        <td class="cell-mono cell-break">${esc(e.model)}</td>
        <td class="cell-num">${e.inputPerM === null ? 'N/A' : `$${e.inputPerM}`}</td>
        <td class="cell-num">${e.outputPerM === null ? 'N/A' : `$${e.outputPerM}`}</td>
        <td>${esc(e.currency)}</td>
        <td>${!isStored
          ? (e.overridden ? `<span class="badge badge--on">overridden</span>` : `<span class="badge">builtin · est.</span>`)
          : (e.enabled ? `<span class="badge badge--on">enabled</span>` : `<span class="badge badge--off">disabled</span>`)}</td>
        <td>${isStored ? 'admin' : 'builtin'}</td>
        <td class="apikey-row__actions">
          ${isStored ? `
            <button type="button" class="btn btn--xs btn--ghost" data-pricing-action="edit" data-pricing-id="${esc(e.id)}">Edit</button>
            <button type="button" class="btn btn--xs btn--ghost" data-pricing-action="toggle" data-pricing-id="${esc(e.id)}">${e.enabled ? 'Disable' : 'Enable'}</button>
            <button type="button" class="btn btn--xs btn--danger" data-pricing-action="delete" data-pricing-id="${esc(e.id)}">Delete</button>`
          : `<button type="button" class="btn btn--xs btn--ghost" data-pricing-action="edit" data-pricing-id="${esc(e.id)}">${e.overridden ? 'Edit override' : 'Override'}</button>`}
        </td>
      </tr>`;
    const storedRows = data.entries.map(e => row(e, true));
    const builtinRows = data.builtin.map(e => row(e, false));
    this.elts.pricingTbody.innerHTML =
      (storedRows.length + builtinRows.length > 0)
        ? storedRows.join('') + builtinRows.join('')
        : `<tr><td colspan="8" class="state-empty">No pricing entries.</td></tr>`;
  }

  private showPricingForm(): void {
    this.elts.pricingForm.classList.remove('is-hidden');
    this.elts.pricingProvider.focus();
  }

  private hidePricingForm(): void {
    this.elts.pricingForm.classList.add('is-hidden');
    this.elts.pricingForm.reset();
    this.elts.pricingError.classList.add('is-hidden');
  }

  /** Prefills the form for create-or-update of the exact pair. */
  private editPricing(id: string): void {
    const e = this.pricingCache.find(x => x.id === id);
    if (!e) return;
    this.pricingEditingId = id;
    this.showPricingForm();
    this.elts.pricingProvider.value = e.providerId;
    this.elts.pricingModel.value = e.model;
    this.elts.pricingInput.value = e.inputPerM !== null ? String(e.inputPerM) : '';
    this.elts.pricingOutput.value = e.outputPerM !== null ? String(e.outputPerM) : '';
  }

  private showPricingError(message: string): void {
    this.elts.pricingError.textContent = message;
    this.elts.pricingError.classList.remove('is-hidden');
  }

  private async submitPricing(): Promise<void> {
    const providerId = this.elts.pricingProvider.value.trim();
    const model = this.elts.pricingModel.value.trim();
    const inputRaw = this.elts.pricingInput.value.trim();
    const outputRaw = this.elts.pricingOutput.value.trim();
    /* Client-side guardrails mirror the backend validation. */
    if (!providerId) { this.showPricingError('Provider is required'); return; }
    if (!model) { this.showPricingError('Model is required'); return; }
    const inputPerM = Number(inputRaw);
    const outputPerM = Number(outputRaw);
    if (!Number.isFinite(inputPerM) || inputPerM < 0) { this.showPricingError('Input price must be a non-negative number'); return; }
    if (!Number.isFinite(outputPerM) || outputPerM < 0) { this.showPricingError('Output price must be a non-negative number'); return; }

    this.elts.pricingSaveBtn.disabled = true;
    this.elts.pricingSaveBtn.textContent = 'Saving…';
    const r = await apiJSON<{ status: string; created?: boolean }>('POST', '/admin/pricing', {
      providerId, model, inputPerM, outputPerM,
    });
    this.elts.pricingSaveBtn.disabled = false;
    this.elts.pricingSaveBtn.textContent = 'Save';
    if (!r.ok) {
      this.showPricingError(r.error || 'Failed to save pricing');
      return;
    }
    this.hidePricingForm();
    await this.loadPricing();
  }

  private async togglePricing(id: string): Promise<void> {
    const e = this.pricingCache.find(x => x.id === id);
    if (!e) return;
    const nextEnabled = !(e.enabled ?? false);
    const r = await apiJSON('PATCH', `/admin/pricing/${encodeURIComponent(id)}`, { enabled: nextEnabled });
    if (!r.ok) {
      this.showError(`Failed to ${nextEnabled ? 'enable' : 'disable'} pricing`, r.error || 'unknown');
      return;
    }
    await this.loadPricing();
  }

  private confirmDeletePricing(id: string): void {
    this.openConfirm({
      title: 'Delete pricing entry?',
      bodyHtml: `
        <p>You are about to delete the stored pricing configuration for:</p>
        <p><code>${esc(id)}</code></p>
        <p class="modal__warn">Only the pricing CONFIGURATION is removed. Historical usage records and their stored costs are never modified.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => {
        const r = await apiJSON('DELETE', `/admin/pricing/${encodeURIComponent(id)}`);
        if (!r.ok) {
          this.showError('Failed to delete pricing', r.error || 'unknown');
          return;
        }
        await this.loadPricing();
      },
    });
  }

  /* ------------------------------- Backup tab ------------------------------ */
  private setBackupStatus(msg: string, kind: 'idle' | 'success' | 'error' = 'idle'): void {
    this.elts.backupStatus.textContent = msg;
    this.elts.backupStatus.classList.remove('is-error', 'is-success');
    if (kind === 'error') this.elts.backupStatus.classList.add('is-error');
    else if (kind === 'success') this.elts.backupStatus.classList.add('is-success');
  }

  private async loadBackups(): Promise<void> {
    this.elts.backupTbody.setAttribute('data-state', 'loading');
    /* colspan="11": Backup ID + Created + 4 numeric + Valid + 4 action columns */
    this.elts.backupTbody.innerHTML = `<tr class="skeleton-row" aria-hidden="true"><td colspan="11"></td></tr>`;
    this.setBackupStatus('');
    const r = await apiJSON<BackupInfo[]>('GET', '/admin/backup/list');
    if (!r.ok || !r.data) {
      this.elts.backupTbody.setAttribute('data-state', 'error');
      this.elts.backupTbody.innerHTML = `<tr><td colspan="11" class="state-error">Failed to load backups: ${esc(r.error || 'unknown')}</td></tr>`;
      this.setBackupStatus('Failed to load backups', 'error');
      return;
    }
    this.backupsCache = r.data;
    this.elts.backupTbody.setAttribute('data-state', 'loaded');
    this.elts.backupTbody.innerHTML = renderBackupListHTML(r.data);
  }

  private async createBackup(): Promise<void> {
    this.elts.backupCreate.disabled = true;
    this.setBackupStatus('Creating backup…');
    const r = await apiJSON<{ status: string; backupId: string; createdAt: number }>('POST', '/admin/backup');
    this.elts.backupCreate.disabled = false;
    if (!r.ok || !r.data) {
      this.setBackupStatus(`Failed: ${r.error || 'unknown'}`, 'error');
      this.showError('Backup failed', r.error || 'unknown');
      return;
    }
    await this.loadBackups();
    /* Refresh re-renders the status element, so set the success message AFTER it. */
    this.setBackupStatus(`Created ${r.data.backupId}`, 'success');
  }

  /** On-demand full-project ZIP download (GET /admin/backup/download).
   * The archive is fetched as a Blob so the button shows a real loading
   * state and server errors surface properly. ZIP bytes are never rendered
   * in the browser — the browser saves them straight to disk. */
  private async downloadFullBackup(): Promise<void> {
    const btn = this.elts.backupDownloadFull;
    btn.disabled = true;
    this.setBackupStatus('Preparing backup…');
    try {
      const apiKey = getApiKey();
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch('/admin/backup/download', { cache: 'no-store', headers });
      if (res.status === 401) {
        clearApiKey();
        showLogin();
        this.setBackupStatus('Unauthorized — invalid API key', 'error');
        return;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = extractApiError(await res.json(), res.status);
        } catch { /* keep the generic status */ }
        this.setBackupStatus(`Download failed: ${msg}`, 'error');
        this.showError('Download failed', msg);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = (match ? match[1] : 'nvidia-api-backup.zip').replace(/[\\/]/g, '_');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.setBackupStatus(`Downloaded ${filename}`, 'success');
    } catch (err: any) {
      const msg = err?.message || 'Network error';
      this.setBackupStatus(`Download failed: ${msg}`, 'error');
      this.showError('Download failed', msg);
    } finally {
      btn.disabled = false;
    }
  }

  private async showBackupInfo(backupId: string): Promise<void> {
    this.elts.infoModalBody.setAttribute('data-state', 'loading');
    this.elts.infoModalBody.innerHTML = `<div class="skeleton skeleton--row" aria-hidden="true"></div><div class="skeleton skeleton--row" aria-hidden="true"></div>`;
    this.elts.infoModal.classList.remove('is-hidden');
    const r = await apiJSON<BackupInfo>('GET', `/admin/backup/info/${encodeURIComponent(backupId)}`);
    if (!r.ok || !r.data) {
      this.elts.infoModalBody.setAttribute('data-state', 'error');
      this.elts.infoModalBody.innerHTML = renderBackupInfoHTML(null, r.error || 'Backup not found');
      return;
    }
    this.elts.infoModalBody.setAttribute('data-state', 'loaded');
    this.elts.infoModalBody.innerHTML = renderBackupInfoHTML(r.data, null);
  }

  /** Restore flow — show the Prompt 13 mandated confirmation first. */
  private confirmRestore(backupId: string): void {
    const backup = this.backupsCache.find(b => b.backupId === backupId);
    if (!backup) {
      this.showError('Restore failed', `Backup ${backupId} not found in current list`);
      return;
    }
    if (!backup.valid) {
      this.showError('Cannot restore', `Backup ${backupId} is invalid (checksum mismatch)`);
      return;
    }
    this.openConfirm({
      title: 'Restore backup',
      bodyHtml: renderRestoreConfirmHTML(backup),
      okLabel: 'Restore',
      okClass: 'btn--danger',
      onConfirm: async () => this.doRestore(backupId),
    });
  }

  private async doRestore(backupId: string): Promise<void> {
    this.setBackupStatus('Restoring…');
    const r = await apiJSON<RestoreResult>('POST', `/admin/backup/restore/${encodeURIComponent(backupId)}`);
    if (!r.ok || !r.data) {
      this.setBackupStatus(`Restore failed: ${r.error || 'unknown'}`, 'error');
      this.showError('Restore failed', r.error || 'unknown');
      return;
    }
    const preBackup = r.data.preRestoreBackupId
      ? ` (pre-restore snapshot: ${r.data.preRestoreBackupId})`
      : '';
    /* Refresh the list (the pre-restore snapshot is now the newest entry) and
       the providers tab to reflect the restored enabled/disabled state. */
    await this.loadBackups();
    await this.loadProvidersAndModelsForFilters();
    /* Refresh re-renders the status element, so set the success message AFTER it. */
    this.setBackupStatus(`Restored ${r.data.restoredUsage} usage records, ${r.data.restoredProviders} provider state${preBackup}`, 'success');
  }

  private confirmDeleteBackup(backupId: string): void {
    this.openConfirm({
      title: 'Delete backup',
      bodyHtml: `
        <p>Delete backup <strong class="backup-id">${esc(backupId)}</strong>?</p>
        <p class="modal__warn">This action cannot be undone.</p>
      `,
      okLabel: 'Delete',
      okClass: 'btn--danger',
      onConfirm: async () => this.doDeleteBackup(backupId),
    });
  }

  private async doDeleteBackup(backupId: string): Promise<void> {
    const r = await apiJSON<{ status: string; backupId: string; deleted: boolean }>('DELETE', `/admin/backup/${encodeURIComponent(backupId)}`);
    if (!r.ok || !r.data) {
      this.setBackupStatus(`Delete failed: ${r.error || 'unknown'}`, 'error');
      this.showError('Delete failed', r.error || 'unknown');
      return;
    }
    await this.loadBackups();
    /* Refresh re-renders the status element, so set the success message AFTER it. */
    this.setBackupStatus(`Deleted ${backupId}`, 'success');
  }
}

/* Class linkage marker — kept so the export grouping is the final statement. */

/* ============================================================================
 * Bootstrap
 * ========================================================================== */

function bootstrap(): void {
  try {
    /* Gate the dashboard on a stored API key; if absent, show the login overlay
       and defer mounting AdminApp until a key is verified. */
    if (!getApiKey()) {
      wireLoginForm();
      showLogin();
      return;
    }
    hideLogin();
    wireLoginForm();
    const elts: AppElements = {
      tabs: document.querySelectorAll('.tabs__tab'),
      panels: document.querySelectorAll('.tab-panel'),
      refreshBtn: el<HTMLButtonElement>('refresh-btn'),
      lastRefresh: el('last-refresh'),
      errorBanner: el('error-banner'),

      appShell: el('app-shell'),
      sidebarToggle: el<HTMLButtonElement>('sidebar-toggle'),
      sidebarOverlay: el('sidebar-overlay'),
      breadcrumb: el('breadcrumb'),
      globalSearch: el<HTMLInputElement>('global-search'),
      sysStatusDot: el('sys-status-dot'),
      sysStatusText: el('sys-status-text'),
      sysUptime: el('sys-uptime'),
      topbarStatus: el('topbar-status'),
      appVersion: el('app-version'),
      copyrightYear: el('copyright-year'),

      usageSummary: el('usage-summary'),
      overviewProviders: el('overview-providers'),

      providersList: el('providers-list'),
      addProviderBtn: el<HTMLButtonElement>('add-provider-btn'),

      registryTbody: el('registry-tbody'),
      registryAddBtn: el<HTMLButtonElement>('registry-add-btn'),
      registryForm: el<HTMLFormElement>('registry-add-form'),
      registryProvider: el<HTMLSelectElement>('registry-provider'),
      registryModel: el<HTMLInputElement>('registry-model'),
      registryBackendModel: el<HTMLInputElement>('registry-backend-model'),
      registryPriority: el<HTMLInputElement>('registry-priority'),
      registryError: el('registry-error'),
      registrySaveBtn: el<HTMLButtonElement>('registry-save-btn'),
      registryCancelBtn: el<HTMLButtonElement>('registry-cancel-btn'),

      usageProviderTbody: el('usage-provider-tbody'),
      usageModelTbody: el('usage-model-tbody'),
      usageChart: el('usage-chart'),

      apikeysTbody: el('apikeys-tbody'),
      pageApikeyAddBtn: el<HTMLButtonElement>('page-apikey-add-btn'),
      pageApikeyForm: el<HTMLFormElement>('page-apikey-form'),
      pageApikeyProvider: el<HTMLSelectElement>('page-apikey-provider'),
      pageApikeyInput: el<HTMLInputElement>('page-apikey-input'),
      pageApikeyLabel: el<HTMLInputElement>('page-apikey-label'),
      pageApikeyError: el('page-apikey-error'),
      pageApikeySaveBtn: el<HTMLButtonElement>('page-apikey-save-btn'),
      pageApikeyCancelBtn: el<HTMLButtonElement>('page-apikey-cancel-btn'),

      clientKeysTbody: el('clientkeys-tbody'),
      clientkeyCreateBtn: el<HTMLButtonElement>('clientkey-create-btn'),
      clientkeyForm: el<HTMLFormElement>('clientkey-form'),
      clientkeyProvider: el<HTMLSelectElement>('clientkey-provider'),
      clientkeyProviderSearch: el<HTMLInputElement>('clientkey-provider-search'),
      clientkeyProviderList: el('clientkey-provider-list'),
      clientkeyModelSearchWrap: el('clientkey-model-search-wrap'),
      clientkeyModelSearch: el<HTMLInputElement>('clientkey-model-search'),
      clientkeyModelCount: el('clientkey-model-count'),
      clientkeyModels: el('clientkey-models'),
      clientkeyModelsEmpty: el('clientkey-models-empty'),
      clientkeyLabel: el<HTMLInputElement>('clientkey-label'),
      clientkeyError: el('clientkey-error'),
      clientkeySaveBtn: el<HTMLButtonElement>('clientkey-save-btn'),
      clientkeyCancelBtn: el<HTMLButtonElement>('clientkey-cancel-btn'),
      clientkeyResult: el('clientkey-result'),
      clientkeyResultKey: el('clientkey-result-key'),
      clientkeyCopyBtn: el<HTMLButtonElement>('clientkey-copy-btn'),
      clientkeyResultMeta: el('clientkey-result-meta'),

      combosTbody: el('combos-tbody'),
      comboCreateBtn: el<HTMLButtonElement>('combo-create-btn'),
      comboForm: el<HTMLFormElement>('combo-form'),
      comboClient: el<HTMLSelectElement>('combo-client'),
      comboProvider: el<HTMLSelectElement>('combo-provider'),
      comboModel: el<HTMLSelectElement>('combo-model'),
      comboKey: el<HTMLSelectElement>('combo-key'),
      comboError: el('combo-error'),
      comboSaveBtn: el<HTMLButtonElement>('combo-save-btn'),
      comboCancelBtn: el<HTMLButtonElement>('combo-cancel-btn'),

      logsFilters: el<HTMLFormElement>('logs-filters'),
      filterProvider: el<HTMLSelectElement>('filter-provider'),
      filterModel: el<HTMLSelectElement>('filter-model'),
      filterStatus: el<HTMLSelectElement>('filter-status'),
      filterFrom: el<HTMLInputElement>('filter-from'),
      filterTo: el<HTMLInputElement>('filter-to'),
      filterSearch: el<HTMLInputElement>('filter-search'),
      filtersReset: el<HTMLButtonElement>('filters-reset'),

      logsTbody: el('logs-tbody'),
      logsPrev: el<HTMLButtonElement>('logs-prev'),
      logsNext: el<HTMLButtonElement>('logs-next'),
      logsRange: el('logs-range'),

      backupCreate: el<HTMLButtonElement>('backup-create'),
      backupDownloadFull: el<HTMLButtonElement>('backup-download-full'),
      backupStatus: el('backup-status'),
      backupTbody: el('backup-tbody'),

      infoModal: el('backup-info-modal'),
      infoModalBody: el('backup-info-body'),

      confirmModal: el('confirm-modal'),
      confirmTitle: el('confirm-title'),
      confirmBody: el('confirm-body'),
      confirmOk: el<HTMLButtonElement>('confirm-ok'),
      confirmCancel: el<HTMLButtonElement>('confirm-cancel'),

      apikeysModal: el('apikeys-modal'),
      apikeysTitle: el('apikeys-title'),
      apikeysBody: el('apikeys-body'),
      apikeyAddBtn: el<HTMLButtonElement>('apikey-add-btn'),

      pricingTbody: el('pricing-tbody'),
      pricingAddBtn: el<HTMLButtonElement>('pricing-add-btn'),
      pricingForm: el<HTMLFormElement>('pricing-add-form'),
      pricingProvider: el<HTMLSelectElement>('pricing-provider'),
      pricingModel: el<HTMLInputElement>('pricing-model'),
      pricingInput: el<HTMLInputElement>('pricing-input'),
      pricingOutput: el<HTMLInputElement>('pricing-output'),
      pricingError: el('pricing-error'),
      pricingSaveBtn: el<HTMLButtonElement>('pricing-save-btn'),
      pricingCancelBtn: el<HTMLButtonElement>('pricing-cancel-btn'),

      modal: el('log-detail'),
      modalBody: el('log-detail-body'),
    };
    new AdminApp(elts);
  } catch (err) {
    console.error('[admin-dashboard] bootstrap failed', err);
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.classList.remove('is-hidden');
      banner.innerHTML = `<p class="error-banner__msg">Dashboard failed to initialize: ${esc((err as Error).message)}</p>`;
    }
  }
}

/* Exposed for unit tests (vitest jsdom). The DOM global may not exist in tests;
 * guard via typeof window check. */
export const __test = {
  renderUsageSummaryHTML, renderProviderCardHTML, renderOverviewProvidersHTML,
  renderProviderUsageHTML, renderModelUsageHTML, renderLogsHTML, renderLogDetailHTML,
  renderBackupListHTML, renderBackupInfoHTML, renderRestoreConfirmHTML,
  renderRegistryHTML, renderUsageChartHTML, renderAllApiKeysHTML, renderClientKeysHTML,
  renderCombosHTML,
  extractApiError, matchesSearchFilter, filterProviderCatalog, filterModelIds,
  nextKeyLabelSuggestion, bumpKeyLabel,
  renderUsageSummary, renderProviderUsage, renderModelUsage, renderLogs, renderLogDetail, renderOverviewProviders,
  fmtTokens, fmtNum, fmtLatency, fmtTime, fmtSize, statusBadge, httpBadge, renderEmptyHTML, DASH, fmtCost,
  fmtCountdown,
};

if (typeof window !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else if (typeof window !== 'undefined') {
  bootstrap();
}
