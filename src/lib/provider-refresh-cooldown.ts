import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './data-dir';

/** Backend enforcement for provider refreshes that may call an upstream. */
export const PROVIDER_REFRESH_COOLDOWN_MS = 180_000;

/** Default persistence file for refresh-cooldown state. Only provider ids and
 *  absolute epoch timestamps are stored — never keys, secrets, or credentials.
 *  Lives under the same DATA_DIR convention as every other state file. */
const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'provider-refresh-cooldown-state.json');

export interface ProviderRefreshDecision {
  allowed: boolean;
  remainingMs: number;
}

export class ProviderRefreshCooldown {
  private nextAllowedAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private stateFile: string;

  constructor(stateFile: string = DEFAULT_STATE_FILE) {
    this.stateFile = stateFile;
    this.load();
  }

  /* ─── Persistence (restart recovery) ──────────────────────────────────────
   * The map stays the fast path; the file is the recovery source after a
   * restart/crash. Writes are atomic (tmp + rename), failure-safe (log only —
   * a broken state file must never take the server down), and happen ONLY at
   * real state transitions: a refresh being committed (tryStart allowed),
   * clear(), or reset(). Rejected refreshes and plain reads never touch it. */

  private load(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return; // never refreshed before
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      if (!raw.trim()) return; // empty file → treat as no state
      const parsed = JSON.parse(raw);
      const entries = parsed && typeof parsed === 'object'
        ? (parsed.nextAllowedAt ?? parsed) // accept both wrapped and flat shape
        : null;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        console.warn(`[ProviderRefreshCooldown] Unrecognized state file format at ${this.stateFile} — starting with empty cooldown state.`);
        return;
      }
      const now = Date.now();
      for (const [providerId, ts] of Object.entries(entries as Record<string, unknown>)) {
        if (!isValidProviderId(providerId) || !isValidTimestamp(ts)) {
          console.warn(`[ProviderRefreshCooldown] Dropping invalid state entry "${providerId}" from ${this.stateFile}.`);
          continue;
        }
        const nextAllowedAt = ts as number;
        if (nextAllowedAt <= now) continue; // already expired — meaningless
        this.nextAllowedAt.set(providerId, nextAllowedAt);
      }
    } catch (err) {
      console.warn(`[ProviderRefreshCooldown] Could not read state file ${this.stateFile} — starting with empty cooldown state. (${(err as Error)?.message ?? err})`);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        updatedAt: Date.now(),
        nextAllowedAt: Object.fromEntries(this.nextAllowedAt),
      };
      const tmp = path.join(dir, `.provider-refresh-cooldown.tmp-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, this.stateFile); // atomic on the same filesystem
    } catch (err) {
      console.error('[ProviderRefreshCooldown] Failed to persist cooldown state:', err);
    }
  }

  /** Atomically reserves a provider refresh before any external call starts.
   *  The cooldown timestamp is committed exactly here — i.e. only when a
   *  refresh is actually allowed to begin — never on rejection. */
  tryStart(providerId: string): ProviderRefreshDecision {
    const now = Date.now();
    const next = this.nextAllowedAt.get(providerId) ?? 0;
    if (this.inFlight.has(providerId) || now < next) {
      return { allowed: false, remainingMs: Math.max(0, next - now) || PROVIDER_REFRESH_COOLDOWN_MS };
    }
    this.inFlight.add(providerId);
    this.nextAllowedAt.set(providerId, now + PROVIDER_REFRESH_COOLDOWN_MS);
    this.persist();
    return { allowed: true, remainingMs: PROVIDER_REFRESH_COOLDOWN_MS };
  }

  finish(providerId: string): void {
    this.inFlight.delete(providerId);
  }

  remainingMs(providerId: string): number {
    return Math.max(0, (this.nextAllowedAt.get(providerId) ?? 0) - Date.now());
  }

  isCoolingDown(providerId: string): boolean {
    return this.inFlight.has(providerId) || this.remainingMs(providerId) > 0;
  }

  clear(providerId: string): void {
    if (!this.nextAllowedAt.has(providerId) && !this.inFlight.has(providerId)) return;
    this.nextAllowedAt.delete(providerId);
    this.inFlight.delete(providerId);
    this.persist();
  }

  reset(): void {
    const hadState = this.nextAllowedAt.size > 0 || this.inFlight.size > 0;
    this.nextAllowedAt.clear();
    this.inFlight.clear();
    if (hadState) this.persist();
  }
}

function isValidProviderId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[\w.-]+$/.test(id);
}

function isValidTimestamp(ts: unknown): boolean {
  return typeof ts === 'number' && Number.isFinite(ts) && Number.isInteger(ts) && ts > 0;
}

export const providerRefreshCooldown = new ProviderRefreshCooldown();

export function createProviderRefreshCooldownError(providerId: string, remainingMs?: number): any {
  const remaining = Math.max(0, remainingMs ?? providerRefreshCooldown.remainingMs(providerId));
  const seconds = Math.max(1, Math.ceil(remaining / 1000));
  const error: any = new Error(`Provider refresh cooldown — retry in ${seconds}s.`);
  error.status = 429;
  error.statusCode = 429;
  error.type = 'provider_refresh_cooldown';
  error.providerRefreshCooldown = {
    providerId,
    remainingMs: remaining,
    remainingSeconds: seconds,
    cooldownMs: PROVIDER_REFRESH_COOLDOWN_MS,
  };
  return error;
}
