/* ─── Provider Cooldown (Provider Management) ───────────────────────────────
 * Central, PER-PROVIDER cooldown registry that gates request routing.
 *
 * Purpose: stop "restart/retry too fast" behavior. When a provider fails
 * (429 / 5xx / network error) it enters a single shared cooldown window
 * (default 180s). During the window:
 *   - Requests targeting the provider fail fast with 429 + a clear message
 *     that includes the remaining seconds — no upstream call is attempted.
 *   - No cross-provider fallback is triggered and other providers are never
 *     affected (state is keyed by providerId).
 *
 * A provider's first success fully clears its cooldown. All existing
 * mechanisms (per-key rotation, multi-key pools, provider-locked routing)
 * are untouched — this registry only coordinates WHEN a provider may be
 * attempted again, in one place, so no hidden scheduler can retry earlier.
 * ─────────────────────────────────────────────────────────────────────────── */

/** Shared cooldown duration for every recovery mechanism (ms). Override via
 *  PROVIDER_COOLDOWN_MS; default is 3 minutes (180000ms). All per-key,
 *  per-endpoint, virtual-backend, and provider-level cooldowns use this value
 *  so no mechanism can secretly retry a failing provider sooner. */
export const PROVIDER_COOLDOWN_MS = (() => {
  const raw = Number(process.env.PROVIDER_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 180_000;
})();

export interface ProviderCooldownState {
  providerId: string;
  /** Epoch ms when the cooldown ends; null when the provider is active. */
  cooldownUntil: number | null;
  /** Epoch ms of the failure that started the cooldown; null when active. */
  lastFailureAt: number | null;
  /** HTTP status / 0 for network errors of the last recorded failure. */
  lastStatus: number;
  /** Error message of the last recorded failure; null when active. */
  lastError: string | null;
  /** How many times a cooldown has been started for this provider. */
  cooldownCount: number;
}

class ProviderCooldownRegistry {
  private states: Map<string, ProviderCooldownState> = new Map();

  private ensure(providerId: string): ProviderCooldownState {
    let s = this.states.get(providerId);
    if (!s) {
      s = {
        providerId,
        cooldownUntil: null,
        lastFailureAt: null,
        lastStatus: 0,
        lastError: null,
        cooldownCount: 0,
      };
      this.states.set(providerId, s);
    }
    return s;
  }

  /** Marks a failure on ONE provider and starts its cooldown window.
   *  Repeated failures inside an already-active window do NOT extend it. */
  markFailure(providerId: string, error: any): ProviderCooldownState {
    const s = this.ensure(providerId);
    const now = Date.now();
    s.lastFailureAt = now;
    s.lastStatus = error?.status ?? error?.response?.status ?? 0;
    s.lastError = error?.message ?? String(error);
    if (s.cooldownUntil === null || s.cooldownUntil <= now) {
      s.cooldownUntil = now + PROVIDER_COOLDOWN_MS;
      s.cooldownCount++;
    }
    return { ...s };
  }

  /** Clears the cooldown for ONE provider (called after any success).
   *  Other providers are untouched. */
  markSuccess(providerId: string): void {
    const s = this.ensure(providerId);
    s.cooldownUntil = null;
    s.lastError = null;
  }

  /** True when the provider must NOT be attempted right now. */
  isCoolingDown(providerId: string): boolean {
    const s = this.states.get(providerId);
    if (!s || s.cooldownUntil === null) return false;
    return Date.now() < s.cooldownUntil;
  }

  /** Remaining cooldown ms for a provider (0 when not cooling down). */
  remainingMs(providerId: string): number {
    const s = this.states.get(providerId);
    if (!s || s.cooldownUntil === null) return 0;
    return Math.max(0, s.cooldownUntil - Date.now());
  }

  /** Read-only snapshot for admin endpoints / UI. */
  snapshot(providerId: string): ProviderCooldownState {
    return { ...this.ensure(providerId) };
  }

  /** Snapshots for all known providers, sorted by id for stable output. */
  snapshotAll(): ProviderCooldownState[] {
    return Array.from(this.states.values())
      .map((s) => ({ ...s }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  /** Hard reset for ONE provider (admin/testing): wipes the failure history
   *  and cooldown counters. Other providers are untouched. */
  clear(providerId: string): void {
    this.states.delete(providerId);
  }
}

/** Singleton registry shared by the request router, admin API, and UI. */
export const providerCooldown = new ProviderCooldownRegistry();

/** Builds the fail-fast error thrown when a provider is in cooldown. The
 *  client-facing message is provider-AGNOSTIC — providerId stays internal
 *  (err.providerCooldown is consumed by admin surfaces only). */
export function createProviderCooldownError(providerId: string, remainingMs: number): any {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const err: any = new Error(
    `The model is temporarily rate-limited. Please retry in ${seconds}s.`,
  );
  err.status = 429;
  err.type = 'rate_limit_error';
  /* Internal-only metadata (admin/UI); never serialized to clients. */
  err.clientSafe = true;
  err.providerCooldown = {
    providerId,
    remainingMs,
    cooldownMs: PROVIDER_COOLDOWN_MS,
  };
  return err;
}
