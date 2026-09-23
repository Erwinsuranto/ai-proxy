// AgentRouter retry/error helpers — self-contained (no cross-provider imports).
// Mirrors the semantics of the shared retry helpers but stays local to this
// provider so AgentRouter remains fully independent.

export function getStatus(error: any): number {
  return error?.status ?? error?.response?.status ?? 0;
}

/** Extract a structured error body from an axios-style error. */
function parseErrorBody(body: any): any {
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body ?? {};
}

/** Wrap an upstream error into a normalized AgentRouter error with status. */
export function wrapError(error: any): any {
  if (error && error.status) return error;
  const status = getStatus(error) || 500;
  const errorBody = parseErrorBody(error?.response?.data);
  const msg =
    errorBody?.error?.message ??
    errorBody?.message ??
    error?.message ??
    'AgentRouter API error';
  const err: any = new Error(`AgentRouter API error (${status}): ${msg}`);
  err.status = status;
  err.response = error?.response;
  return err;
}

/** True when the error is a rate-limit / quota condition (HTTP 429 or message). */
export function isQuotaError(error: any): boolean {
  const status = getStatus(error);
  if (status === 429) return true;
  const msg = (error?.message ?? '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  );
}

/** True when the error is retryable on a fresh key. */
export function isRetryableError(error: any): boolean {
  const status = getStatus(error);
  if ([401, 403, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = (error?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('network error') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('rate limit') ||
    msg.includes('quota')
  );
}