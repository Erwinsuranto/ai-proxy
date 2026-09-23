import { Transform } from 'stream';
import { scrubClientPayload, sanitizeErrorText, redactInternalTerms } from '../lib/client-sanitize';
import { detectInlineErrorText } from '../lib/inline-error';

export interface UsageTokens {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export function extractUsage(body: any): UsageTokens {
  let obj: any = body;
  if (typeof body === 'string') {
    try { obj = JSON.parse(body); } catch { return { promptTokens: null, completionTokens: null, totalTokens: null }; }
  }
  const u = obj?.usage;
  if (!u || typeof u !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null };
  /* Provider-specific usage formats (mirrors provider.extractUsageFromResult):
   *  - [OI]:      prompt_tokens / completion_tokens / total_tokens
   *  - camelCase:   promptTokens / completionTokens / totalTokens
   *  - Anthropic:   input_tokens / output_tokens (Messages API & some proxies)
   */
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const promptTokens =
    num(u.prompt_tokens) ??
    num(u.promptTokens) ??
    num(u.input_tokens) ??
    num(u.inputTokens);
  const completionTokens =
    num(u.completion_tokens) ??
    num(u.completionTokens) ??
    num(u.output_tokens) ??
    num(u.outputTokens);
  if (promptTokens === null || completionTokens === null) {
    return { promptTokens, completionTokens, totalTokens: null };
  }
  const totalTokens =
    num(u.total_tokens) ??
    num(u.totalTokens) ??
    promptTokens + completionTokens;
  /* Do not hide upstream discrepancies (mirrors provider.extractUsageFromResult). */
  if (
    typeof totalTokens === 'number' &&
    typeof promptTokens === 'number' && typeof completionTokens === 'number' &&
    totalTokens !== promptTokens + completionTokens
  ) {
    console.warn(`[Usage] Upstream streamed total_tokens (${totalTokens}) != prompt+completion (${promptTokens + completionTokens}) — keeping upstream value`);
  }
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Wraps an upstream SSE stream for CLIENT delivery.
 *
 * Provider leak guard: every `data: {json}` event is parsed, internal
 * envelope keys (provider, upstream*, backend*, baseUrl, stack, …) are
 * stripped, `model` is rewritten to the CLIENT-requested model, and error
 * payloads are replaced with generic OpenAI-style messages (a mid-stream
 * upstream error may name the provider / upstream URL / internal service).
 * Non-JSON `data:` payloads that match the inline-error signatures are
 * dropped (the stream error path then terminates the response safely).
 * Content-bearing fields (choices/delta text, tool calls, usage) are untouched.
 */
export interface WrappedStream {
  stream: Transform;
  getUsage: () => UsageTokens | null;
  /** Registers internal identity terms (provider ids/names) that are
   *  redacted from any upstream-authored pass-through text. */
  setInternalTerms: (terms: string[]) => void;
}

export function wrapStream(stream: any, clientModel?: string): WrappedStream {
  let usage: any = null;
  /* Internal identity terms (provider ids / names) redacted defensively from
   * any upstream-authored text fragment that must pass through verbatim. */
  let internalTerms: string[] = [];
  // SSE line buffer: upstream chunks do NOT align to `\n` boundaries. A single
  // `data: {...}` event may be split across multiple `transform()` calls (and
  // conversely one chunk may carry several events). Without buffering, the
  // mid-event JSON.parse fails and the usage object carried in the FINAL chunk
  // is dropped — leaving the streamed request recorded with null tokens even
  // though upstream did send usage. We accumulate partial bytes, flush whole
  // lines only, and emit the trailing partial to `_flush` at stream end.
  let pending = '';

  /** True when the object looks like an error envelope rather than a
   *  completion chunk (an `error` member with no choices payload). */
  function isErrorEnvelope(obj: any): boolean {
    return !!obj
      && typeof obj === 'object'
      && !Array.isArray(obj)
      && Object.prototype.hasOwnProperty.call(obj, 'error')
      && !Object.prototype.hasOwnProperty.call(obj, 'choices');
  }

  /** Client-safe replacement for a JSON error event: same status semantics,
   *  generic message — no provider name, URL, path or stack. */
  function genericErrorPayload(obj: any): any {
    const err = obj.error;
    let status = 502;
    if (typeof err === 'object' && err !== null) {
      const code = err.code ?? err.status ?? err.httpStatus ?? err.status_code;
      if (typeof code === 'number' && code >= 400 && code <= 599) status = code;
      else if (typeof code === 'string' && /^\d{3}$/.test(code) && +code >= 400 && +code <= 599) status = +code;
    }
    return {
      error: {
        message: 'The upstream request failed mid-stream. Please retry.',
        type: status === 429 ? 'rate_limit_error' : 'api_error',
        code: String(status),
      },
    };
  }

  /** Returns the client-safe replacement for one SSE line (or null = keep). */
  function processLine(line: string): string | null {
    if (!line.startsWith('data: ')) return null;
    const jsonStr = line.slice(6);
    if (jsonStr === '[DONE]') return null;
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'usage')) {
        /* An explicit final usage:null must clear an earlier usage object. */
        usage = parsed.usage;
      }
      if (isErrorEnvelope(parsed)) {
        /* Never forward upstream-authored error bodies verbatim. */
        return 'data: ' + JSON.stringify(genericErrorPayload(parsed));
      }
      const cleaned = scrubClientPayload(parsed);
      if (clientModel && cleaned && typeof cleaned === 'object' && 'model' in cleaned) {
        cleaned.model = clientModel;
      }
      return 'data: ' + JSON.stringify(cleaned);
    } catch {
      // Not JSON — could be an upstream inline error ("[error] ...") or prose.
      // Never forward provider-authored failure text verbatim: error-classified
      // payloads become a generic error event; anything else only passes
      // through with URLs/IPs/keys/internal terms defensively removed.
      if (detectInlineErrorText(jsonStr)) {
        return 'data: ' + JSON.stringify(genericErrorPayload({ error: {} }));
      }
      const safe = redactInternalTerms(sanitizeErrorText(jsonStr), internalTerms);
      return 'data: ' + safe;
    }
  }

  const transform = new Transform({
    writableObjectMode: false,
    readableObjectMode: false,
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString();
      const out: string[] = [];
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        // Strip a trailing `\r` (CRLF-delimited SSE).
        const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
        const replaced = processLine(stripped);
        out.push(replaced === null ? stripped : replaced);
        out.push('\n');
      }
      callback(null, out.join(''));
    },
    flush(callback) {
      const out: string[] = [];
      if (pending.length > 0) {
        const stripped = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        const replaced = processLine(stripped);
        out.push(replaced === null ? stripped : replaced);
        pending = '';
      }
      callback(null, out.join(''));
    },
  });

  stream.pipe(transform);

  transform.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.on('error', (err: Error) => {
    if (!transform.destroyed) transform.destroy(err);
  });

  return {
    stream: transform,
    getUsage: () => usage ? extractUsage({ usage }) : null,
    setInternalTerms(terms: string[]): void {
      internalTerms = Array.isArray(terms) ? terms.filter(t => typeof t === 'string') : [];
    },
  };
}
