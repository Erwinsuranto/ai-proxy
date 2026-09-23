/**
 * Upstream inline-error detection (SeekAI fix #1).
 *
 * Some upstreams (e.g. SeekAI) occasionally respond with HTTP 200 but the
 * body / SSE payload is actually an error, e.g.:
 *   - `[error] Service temporarily unavailable`
 *   - `{"error": {"message": "..."}}`
 *   - `data: {"error": {"message": "..."}}`  (inside an SSE stream)
 *
 * The gateway must NOT treat these as a successful model completion.  This
 * module centralises the detection so a "genuine" completion (even one whose
 * text happens to contain the word `[error]`) is never flagged, while the
 * upstream error formats are reliably recognised and turned into a real
 * upstream failure (see `createUpstreamError`) that the existing
 * routing/fallback/key-rotation path can act on.
 */

/** Matches the upstream tag form `[error] ...` / `[ERROR]: ...` at the start. */
const ERROR_TAG = /^\s*\[error\]\s*[:：\-]?\s*(.*)$/i;

/**
 * Strong, conservative signatures.  An inline error is only ever flagged when:
 *   - it carries the `[error]` tag AND the message matches one of these, OR
 *   - the whole (short) message is a canonical service-failure phrase.
 * This keeps genuine model output that merely contains the word "error" safe.
 */
const STRONG_SIGNATURES: RegExp[] = [
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal server error/i,
  /server error/i,
  /bad gateway/i,
  /gateway timeout/i,
  /try again later/i,
  /please try again later/i,
  /(is|are) (currently |temporarily )?(busy|down|overloaded)/i,
  /error code (4\d\d|5\d\d|42\d)/i,
  /\b(4\d\d|5\d\d)\b/,
  /upstream (error|failed|timeout|unreachable)/i,
];

/** Exact whole-message canonical failures (no surrounding prose allowed). */
const PURE_FAILURE: RegExp[] = [
  /^(service temporarily unavailable|service unavailable|internal server error|server error|bad gateway|gateway timeout|try again later|temporarily unavailable|please try again later)[.!]*$/i,
];

export interface InlineUpstreamErrorInfo {
  status: number;
  message: string;
}

/** Returns the error envelope of a JSON object, or null when there is none. */
function extractErrorMessageEnvelope(obj: any): { message: string; status: number } | null {
  if (!obj || typeof obj !== 'object') return null;
  const err = obj.error;
  if (err === undefined || err === null) return null;

  let message: string;
  let status = 502;
  if (typeof err === 'string') {
    message = err;
  } else if (typeof err === 'object') {
    message = err.message ?? err.error ?? err.reason ?? '';
    const code = err.code ?? err.status ?? err.httpStatus ?? err.status_code;
    if (typeof code === 'number' && code >= 400 && code <= 599) status = code;
    else if (typeof code === 'string' && /^\d{3}$/.test(code) && +code >= 400 && +code <= 599) status = +code;
  } else {
    return null;
  }

  if (typeof message !== 'string' || message.trim() === '') return null;
  return { message: message.trim(), status };
}

/** Concatenated assistant content for a parsed completion, or null when absent. */
export function extractCompletionText(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const parts: string[] = [];
  for (const c of choices) {
    const content = c?.message?.content ?? c?.delta?.content;
    if (typeof content === 'string' && content) parts.push(content);
  }
  return parts.length === 0 ? null : parts.join('');
}

/**
 * Decide whether a plain text string is an upstream inline error.
 * Returns the error text to surface, or null when it is genuine content.
 */
export function detectInlineErrorText(text: any): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tagMatch = trimmed.match(ERROR_TAG);
  if (tagMatch) {
    const rest = (tagMatch[1] ?? '').trim();
    // Only flag the tagged form when the remainder is a recognisable failure.
    if (rest && STRONG_SIGNATURES.some((re) => re.test(rest))) {
      return rest;
    }
    return null;
  }

  // Untagged: only the exact canonical short phrases are flagged.
  if (trimmed.length <= 160 && PURE_FAILURE.some((re) => re.test(trimmed))) {
    return trimmed;
  }
  return null;
}

/**
 * Detect an inline upstream error in a (parsed or raw) non-streaming response.
 * Returns null when the response is a genuine completion.
 */
export function detectInlineUpstreamError(body: any): InlineUpstreamErrorInfo | null {
  let obj: any = body;
  if (typeof body === 'string' && (body.trim().startsWith('{') || body.trim().startsWith('['))) {
    try {
      obj = JSON.parse(body);
    } catch {
      obj = undefined;
    }
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const env = extractErrorMessageEnvelope(obj);
    if (env) {
      const content = extractCompletionText(obj);
      if (content !== null) {
        const tagged = detectInlineErrorText(content);
        if (tagged) return { status: env.status, message: tagged };
        // Real completion content accompanied a (stale) error envelope -> success.
        return null;
      }
      return { status: env.status, message: `Upstream error: ${env.message}` };
    }

    const content = extractCompletionText(obj);
    if (content !== null) {
      const tagged = detectInlineErrorText(content);
      if (tagged) return { status: 502, message: tagged };
    }
  }

  if (typeof body === 'string') {
    const tagged = detectInlineErrorText(body);
    if (tagged) return { status: 502, message: tagged };
  }

  return null;
}

/**
 * Build a real (throwable) upstream failure.  Crucially the message and the
 * attached `response.data` contain NO raw API key material — only the upstream
 * error text — so internal status/messages never leak credentials.
 *
 * The provider label and upstream text stay INTERNAL (routing logs, usage
 * records); the client-facing wording is applied by the leak guard
 * (client-sanitize.ts) which genericizes non-clientSafe errors.
 */
export function createUpstreamError(providerLabel: string, info: InlineUpstreamErrorInfo): any {
  const status = info.status >= 400 && info.status <= 599 ? info.status : 502;
  const safeMessage = String(info.message).replace(/\r?\n/g, ' ').slice(0, 300);
  const err: any = new Error(`${providerLabel} upstream error: ${safeMessage}`);
  err.status = status;
  err.isUpstreamInlineError = true;
  err.response = { status, data: { error: { message: safeMessage } } };
  return err;
}

/* -------------------------------------------------------------------------- */
/*  Streaming / SSE detection                                                 */
/* -------------------------------------------------------------------------- */

export type StreamVerdict = 'error' | 'legit' | null;

interface Classified {
  kind: 'error' | 'legit' | 'neutral';
  message?: string;
}

function classifyParsedEvent(parsed: any): Classified {
  if (!parsed || typeof parsed !== 'object') return { kind: 'neutral' };
  const env = extractErrorMessageEnvelope(parsed);
  if (env) {
    const content = extractCompletionText(parsed);
    if (content !== null) {
      const tagged = detectInlineErrorText(content);
      if (tagged) return { kind: 'error', message: tagged };
      return { kind: 'legit' };
    }
    return { kind: 'error', message: env.message };
  }
  const content = extractCompletionText(parsed);
  if (content !== null) {
    const tagged = detectInlineErrorText(content);
    if (tagged) return { kind: 'error', message: tagged };
    return { kind: 'legit' };
  }
  if (Array.isArray(parsed?.choices)) return { kind: 'neutral' };
  return { kind: 'neutral' };
}

/**
 * Determine the stream verdict from a growing buffer of bytes.
 *
 * Returns:
 *   - 'error'  : an inline upstream error was detected -> abort as failure.
 *   - 'legit'  : a genuine completion (or non-error content) was detected -> ok.
 *   - null     : not enough information yet -> keep buffering.
 *
 * `contentBuf` is the concatenation of accumulated assistant content across
 * SSE `delta` events (so split token boundaries cannot mask the `[error]`
 * tag).  `started` is true once content has begun.
 */
export function getStreamVerdict(
  total: string,
  contentBuf: string,
  started: boolean,
): StreamVerdict {
  const trimmed = total.trimStart();
  if (!trimmed) return null;

  // Raw (non-SSE) upstream error text at the very start of the stream body.
  if (trimmed.startsWith('[error]')) {
    if (detectInlineErrorText(trimmed)) return 'error';
    return 'legit';
  }

  const lines = total.split('\n');
  lines.pop(); // last entry may be a partial line not yet terminated
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const content = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!content) continue;
    if (content === '[DONE]') continue;

      if (line.startsWith('data:')) {
        try {
          const parsed = JSON.parse(content);
          const cls = classifyParsedEvent(parsed);
          if (cls.kind === 'error') return 'error';
          if (cls.kind === 'legit') {
            // A genuinely-split `[error]` tag must keep buffering rather than be
            // declared a real completion on its first (partial) token.
            const eventContent = extractCompletionText(parsed) ?? '';
            const decision = decideOnContent((contentBuf || '') + eventContent);
            if (decision === 'error') return 'error';
            if (decision === 'legit') return 'legit';
            return null; // undecided, keep buffering
          }
        } catch {
          // Non-JSON data line.
          if (detectInlineErrorText(content)) return 'error';
          if (content) return 'legit';
        }
      } else {
      // Non-data line: could be a plain-text (non-SSE) upstream error body.
      if (detectInlineErrorText(line)) return 'error';
      try {
        const parsed = JSON.parse(line);
        const cls = classifyParsedEvent(parsed);
        if (cls.kind === 'error') return 'error';
      } catch {
        // Plain prose line -> treat as genuine content.
        return 'legit';
      }
    }
  }

  // No complete event decided yet.  If we already have content, let the
  // incremental content decision run (handles a split `[error]` tag).
  if (started && contentBuf) {
    return decideOnContent(contentBuf);
  }
  return null;
}

/**
 * Incremental decision for accumulated assistant content (may be mid-tag).
 * Keeps buffering while the buffer is still a prefix of the `[error]` tag so a
 * tokenised `[error] Service ...` is not prematurely declared legitimate.
 */
function decideOnContent(contentBuf: string): StreamVerdict {
  const t = contentBuf.trimStart();
  if (detectInlineErrorText(t)) return 'error';
  if (!t) return null;

  const lower = t.toLowerCase();
  if (lower.startsWith('[error')) {
    // Could still become the tagged error; wait for more bytes unless it is
    // already an implausibly long tag-less message.
    if (lower.length < 80) return null;
    return 'legit';
  }
  if (lower.startsWith('[')) {
    // A prefix of the `[error]` tag (e.g. "[erro", "[err") -> keep waiting.
    if ('[error]'.startsWith(lower)) return null;
    return 'legit';
  }
  return 'legit';
}
