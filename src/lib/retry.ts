const RETRYABLE_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

/** Lowercased upstream body text (truncated) — axios keeps the server's JSON
 *  in error.response.data while error.message only says "Request failed ...",
 *  so balance/quota signals live here, not in the message. */
function responseBodyText(error: any): string {
  const data = error?.response?.data;
  if (data === undefined || data === null) return '';
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.slice(0, 2000).toLowerCase();
  } catch {
    return '';
  }
}

/** True when the error means "this credential has no balance/quota left" */
export function isInsufficientBalanceError(error: any): boolean {
  const status = error?.status ?? error?.response?.status ?? 0;
  if (status !== 400 && status !== 402) return false;
  const hay = `${error?.message ?? ''} ${responseBodyText(error)}`.toLowerCase();
  return hay.includes('insufficient') &&
    (hay.includes('balance') || hay.includes('credit') || hay.includes('quota'));
}

/** Determines whether an HTTP error is retryable based on its status code or error message. */
export function isRetryableError(error: any): boolean {
  const status = error?.status ?? error?.response?.status ?? 0;
  if (RETRYABLE_STATUSES.has(status)) return true;

  /* Insufficient-balance (402/400) fails over to the next key instead of
   * failing the request on a dead credential. */
  if (isInsufficientBalanceError(error)) return true;

  const msg = (error?.message ?? '').toLowerCase();
  if (
    msg.includes('timeout') ||
    msg.includes('network error') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('rate limit') ||
    msg.includes('quota')
  ) {
    return true;
  }

  return false;
}

/** Determines whether an HTTP error is a quota or rate-limit error (HTTP 429 or related message). */
export function isQuotaError(error: any): boolean {
  const status = error?.status ?? error?.response?.status ?? 0;
  if (status === 429) return true;

  /* Insufficient-balance keys cool down like quota-exhausted ones so rotation
   * skips them for the window instead of retrying a dead credential. */
  if (isInsufficientBalanceError(error)) return true;

  const msg = (error?.message ?? '').toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  ) {
    return true;
  }

  return false;
}

/** True when error.response.data is an unread stream (axios with
 *  responseType 'stream' rejects with the raw IncomingMessage as data). */
function isReadableStream(data: any): boolean {
  return !!data && typeof data === 'object' && typeof data.on === 'function' && typeof data.read === 'function';
}

/** Drains an axios stream error body so body-based classifiers (quota,
 *  balance, ...) work on streaming requests too. Without this, a 402/429
 *  received mid-stream carries an unread stream as error.response.data and
 *  every body check silently misses. Mutates the error in place and returns
 *  it. Never throws; gives up after ~5s or on non-stream data. */
export async function normalizeStreamError(error: any): Promise<any> {
  try {
    const data = error?.response?.data;
    if (!isReadableStream(data)) return error;
    const text: string = await new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try { data.destroy(); } catch { /* ignore */ }
        resolve('');
      }, 5000);
      if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
      data.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      data.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf-8').slice(0, 4000));
      });
      data.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
    });
    if (!text) return error;
    try {
      error.response.data = JSON.parse(text);
    } catch {
      error.response.data = text;
    }
  } catch {
    /* best-effort only — classification falls back to status/message */
  }
  return error;
}
