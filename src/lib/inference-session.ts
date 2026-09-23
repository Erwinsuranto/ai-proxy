/* ============================================================================
 * nvidia-api · OpenCode Inference request context (session identity)
 * ----------------------------------------------------------------------------
 * OpenCode Inference free tier rejects requests that do not carry the OpenCode
 * client session identity header (`x-opencode-session`) with HTTP 400
 * MISSING_SESSION_ID. This context carries ONLY that single, validated opaque
 * value from the incoming HTTP request into the provider for the duration of
 * one request lifecycle.
 *
 * Why this shape:
 *  - The audited OpenCode client (binary v1.18.30) sends `x-opencode-session`
 *    for every provider whose id starts with "opencode"; the upstream contract
 *    expects that same header on `/inference/openai/v1/chat/completions`
 *    (audited reference: 9router open-sse/executors/opencode.js).
 *  - It deliberately does NOT carry credentials, Authorization, cookies or an
 *    arbitrary header bag. The provider builds its outbound header allowlist
 *    from this single value plus static identity defaults. There is no generic
 *    "forward all headers" path.
 *
 * Provider isolation: only src/providers/inference reads this context. Zen and
 * every other provider are unaffected.
 * ========================================================================== */
import { AsyncLocalStorage } from 'node:async_hooks';

/* Opaque session ids are short; cap defensively so a hostile client cannot
 * push an unbounded value through the request context. */
const MAX_SESSION_ID_LENGTH = 256;

const inferenceSessionContext = new AsyncLocalStorage<string>();

/** Run `fn` with the given inference session id bound (null = no request id). */
export function runWithInferenceSession<T>(fn: () => T, sessionId: string | null): T {
  if (!sessionId) return fn();
  return inferenceSessionContext.run(sessionId, fn);
}

/** The current request's inference session id, or null when none was supplied. */
export function getInferenceSessionId(): string | null {
  return inferenceSessionContext.getStore() ?? null;
}

/* Normalize a single header value (string | string[] | undefined) into a
 * usable session id. Returns null when absent/blank/oversized. */
function normalizeSessionId(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Extract the OpenCode session identity from incoming request headers.
 *
 * ONLY `x-opencode-session` is read — the header the audited OpenCode client
 * sends for opencode-prefixed providers (the contract the Inference upstream
 * enforces). Sensitive headers (authorization, cookie, x-api-key,
 * x-opencode-api-key, x-org-id, host, content-length, ...) are intentionally
 * never read here.
 */
export function extractInferenceSessionId(headers: Record<string, any> | undefined): string | null {
  if (!headers) return null;
  return normalizeSessionId(headers['x-opencode-session']);
}
