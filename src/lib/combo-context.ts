/* ============================================================================
 * nvidia-api · Combo request context (per-request routing pin)
 * ----------------------------------------------------------------------------
 * COMBO = Client/User → Provider → Model → Provider API Key.
 *
 * When an incoming request is served through an active combo, the route guard
 * resolves the combo and stores it here (AsyncLocalStorage) so the whole
 * request lifecycle can read it:
 *
 *  - services/provider.ts uses `providerId` to provider-LOCK routing (the
 *    request may ONLY be sent to that provider — never another one) and
 *    skips Virtual Routes (an explicit combo pin outranks them).
 *  - lib/key-manager.ts uses `providerRawKey` to pin the credential: the
 *    provider's own KeyManager starts rotation from that exact key. The raw
 *    value never leaves this context (no logs, no responses) — it exists only
 *    so the KeyManager can find the matching index in its own pool.
 *  - usage attribution records `comboId` / `providerKeyId` (record IDs only).
 *
 * If `providerRawKey` is null the combo uses the provider's existing
 * multi-key rotation across ALL of that provider's keys (same-provider only).
 * ========================================================================== */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ComboRequestContext {
  comboId: string;
  providerId: string;
  /** Client-facing model id the combo pins (registry name, not backend id). */
  model: string;
  /** Route id within a multi-route provider, or null = provider default routing. */
  routeId: string | null;
  /** Provider API key record id (`key_...`) or null = provider-wide rotation. */
  providerKeyId: string | null;
  /** Raw credential for KeyManager pinning — RUNTIME USE ONLY, never exposed. */
  providerRawKey: string | null;
}

const comboContext = new AsyncLocalStorage<ComboRequestContext>();

export function runWithComboContext<T>(fn: () => T, ctx: ComboRequestContext | null): T {
  if (!ctx) return fn();
  return comboContext.run(ctx, fn);
}

export function getComboContext(): ComboRequestContext | null {
  return comboContext.getStore() ?? null;
}
