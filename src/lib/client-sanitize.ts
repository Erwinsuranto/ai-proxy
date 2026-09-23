/* ============================================================================
 * nvidia-api · Client leak guard (provider information sanitization)
 * ----------------------------------------------------------------------------
 * ONE layer that keeps INTERNAL provider information from reaching CLIENT
 * consumers of the public API (/v1/*). Clients may know:
 *
 *     Base URL + Client API Key + requested model + normalized response
 *
 * They must NEVER learn: providerId / providerName, upstream URLs or
 * hostnames, backend model mappings, credentials, routing/cooldown details,
 * stack traces or debug objects.
 *
 * ADMIN (/admin/*) and INTERNAL (/internal/*) surfaces intentionally keep
 * provider visibility — this layer is applied ONLY to client-facing paths.
 *
 * Design rules:
 *  - Response BODIES (assistant content, user content) are never rewritten;
 *    only known-internal ENVELOPE keys are stripped from JSON.
 *  - Error MESSAGES reaching clients are either messages this gateway crafted
 *    itself (flagged `clientSafe`) or replaced by generic, status-mapped text.
 *    Raw upstream error bodies are never forwarded.
 *  - URLs / IPs / credential-looking tokens are stripped defensively from
 *    error text (never from content).
 * ========================================================================== */

/** JSON keys that must never reach a client. Stripped (deeply) from every
 *  client-facing JSON envelope. Deliberately narrow: only keys this codebase
 *  (or an OpenAI-compatible upstream) could attach with internal meaning —
 *  never generic words that might collide with legitimate payloads. */
const INTERNAL_KEYS = new Set([
  'provider', 'providerid', 'provider_id', 'providername', 'provider_name',
  'upstream', 'upstreamurl', 'upstream_url', 'upstreammodel', 'upstream_model',
  'upstreamendpoint', 'upstream_endpoint', 'upstreamhost', 'upstream_host',
  'baseurl', 'base_url', 'backend', 'backendmodel', 'backend_model',
  'adapter', 'credential', 'providercooldown', 'stack', 'stacktrace', 'stack_trace',
  'endpoint', 'selectedprovider', 'selected_provider',
  'routedprovider', 'routed_provider', 'routedto', 'routed_to',
  'providermetadata', 'provider_metadata', 'apikey', 'api_key',
  'debug', 'debuginfo', 'debug_info', 'internalstate', 'internal_state',
]);

/** True when the object key carries internal meaning and must be stripped. */
function isInternalKey(key: string): boolean {
  return INTERNAL_KEYS.has(key.toLowerCase());
}

/**
 * Recursively strips internal keys from a JSON-shaped value and returns a
 * sanitized copy. Strings (model content) are passed through untouched.
 * Non-JSON-safe values are left as-is (JSON.stringify handles them).
 */
export function scrubClientPayload<T>(value: T): T {
  return scrub(value, new WeakSet()) as T;
}

function scrub(value: any, seen: WeakSet<object>): any {
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, seen));
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isInternalKey(key)) continue;
      out[key] = scrub(val, seen);
    }
    return out;
  }
  return value;
}

/** Strips URLs, IP[:port] literals and credential-looking tokens from TEXT
 *  (error messages only — never response content). */
export function sanitizeErrorText(text: string): string {
  let out = String(text ?? '');
  out = out.replace(/https?:\/\/[^\s"'<>\\]+/gi, '[upstream]');
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '[upstream]');
  /* Bearer / raw key material that could appear inside echoed upstream text. */
  out = out.replace(/\b(sk|Bearer)[\s-]+[A-Za-z0-9_\-]{8,}/g, '$1 [redacted]');
  return out;
}

/**
 * Removes every occurrence of the given INTERNAL terms (provider ids/names)
 * from free text. Used by the stream layer where upstream-authored fragments
 * can appear mid-stream and the whole message cannot simply be replaced.
 */
export function redactInternalTerms(text: string, terms: string[]): string {
  let out = String(text ?? '');
  for (const term of terms) {
    if (!term || typeof term !== 'string' || term.length < 3) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '[upstream]');
  }
  return out;
}

/**
 * Produces the client-facing { status, message } for any error caught by a
 * /v1/* route.
 *
 *  - Errors crafted by THIS gateway (flagged `clientSafe`) keep their message
 *    (URL-stripped defensively) — they never contain provider identity.
 *  - Anything else (upstream bodies, axios network errors, provider wrapError
 *    text — all of which embed provider names, hostnames or upstream body
 *    text) is REPLACED by a generic message. The HTTP status is preserved.
 */
export function toClientError(err: any): { status: number; message: string } {
  const status = typeof err?.status === 'number'
    ? err.status
    : (typeof err?.response?.status === 'number'
      ? err.response.status
      : (typeof err?.statusCode === 'number' ? err.statusCode : 500));

  if (err?.clientSafe && typeof err?.message === 'string' && err.message.length > 0) {
    return { status: status || 500, message: sanitizeErrorText(err.message) };
  }

  const generic = genericMessageForStatus(status);
  return { status: status || 500, message: generic };
}

function genericMessageForStatus(status: number): string {
  if (status === 400) return 'The request could not be processed for the requested model.';
  if (status === 401 || status === 403) return 'Upstream authentication failed for the requested model.';
  if (status === 404) return 'The requested model was not found.';
  if (status === 408 || status === 504) return 'The upstream request timed out.';
  if (status === 429) return 'Rate limit exceeded. Please retry later.';
  if (status >= 500) return 'Upstream provider request failed.';
  return 'Upstream provider request failed.';
}
