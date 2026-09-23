// Shared provider response pipeline — single source of truth for parsing and
// text extraction used by EVERY provider (OpenAI passthrough, Anthropic, custom
// formats like Cloudflare). Provider-agnostic: never hardcodes a vendor.
//
// Pipeline contract (identical for all providers):
//   Client -> Route -> Resolver -> Provider -> Upstream API
//   -> Raw Response -> Parse -> Normalize (OpenAI compatible) -> Client Response
//
// These helpers implement the "Raw Response -> Parse -> Extract" stages and
// guarantee that a non-JSON body (WAF/CAPTCHA HTML) is NEVER treated as JSON.

/**
 * Normalize the raw upstream HTTP body. Axios may hand us a JSON object already
 * (application/json) or a raw string (text/html WAF page, malformed JSON, ...).
 * Reports whether the body was parseable JSON and returns the parsed body (or
 * the original string when it is not JSON).
 */
export function parseResponseBody(raw: any): {
  body: any;
  wasJson: boolean;
  parseError: string | null;
  rawType: string;
  rawLength: number;
} {
  const rawType = typeof raw;
  if (rawType === 'string') {
    const len = raw.length;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { body: JSON.parse(trimmed), wasJson: true, parseError: null, rawType, rawLength: len };
      } catch (e: any) {
        return { body: raw, wasJson: false, parseError: e?.message ?? String(e), rawType, rawLength: len };
      }
    }
    return { body: raw, wasJson: false, parseError: null, rawType, rawLength: len };
  }
  if (raw !== null && rawType === 'object') {
    return { body: raw, wasJson: true, parseError: null, rawType, rawLength: JSON.stringify(raw)?.length ?? 0 };
  }
  return { body: raw, wasJson: false, parseError: null, rawType, rawLength: 0 };
}

/**
 * Extract text out of a content-like value WITHOUT assuming it is an array.
 * - string               -> itself
 * - array of blocks      -> concatenates every text-ish block
 *   (type: text | input_text | output_text | value | citation.cited_text)
 * - object with .text    -> its text
 * Never includes thinking/redacted_thinking (that is reasoning, not content).
 */
export function textFromContentValue(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const b of value) {
      if (typeof b === 'string') {
        out += b;
        continue;
      }
      if (!b || typeof b !== 'object') continue;
      const t = b.type;
      if (t === 'text' || t === 'input_text' || t === 'output_text') {
        out += b.text ?? '';
      } else if (t === 'value') {
        out += typeof b.value === 'string' ? b.value : '';
      } else if (t === 'citation' && typeof b.cited_text === 'string') {
        out += b.cited_text;
      } else if (!t && typeof b.text === 'string') {
        out += b.text;
      }
    }
    return out;
  }
  if (value && typeof value === 'object') {
    return textFromContentValue(value.text ?? value.value ?? '');
  }
  return '';
}

/**
 * Exhaustively locate the assistant text across every known Anthropic / OpenAI /
 * Responses / SSE field shape. Returns the found text plus the field location.
 * Non-JSON bodies (e.g. WAF HTML) are never treated as text.
 */
export function findTextInResponse(resp: any): { text: string; location: string } {
  if (resp === undefined || resp === null) return { text: '', location: 'null/undefined' };
  if (typeof resp === 'string') {
    const t = resp.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return findTextInResponse(JSON.parse(t));
      } catch {
        return { text: '', location: `non-json-string(len=${resp.length})` };
      }
    }
    return { text: '', location: `non-json-string(len=${resp.length})` };
  }
  if (typeof resp !== 'object') return { text: '', location: `non-object(${typeof resp})` };
  if (Array.isArray(resp)) {
    const text = textFromContentValue(resp);
    return text ? { text, location: 'array[].text' } : { text: '', location: 'array(empty)' };
  }

  const candidates: Array<[string, any]> = [
    ['content', resp.content],
    ['message.content', resp.message?.content],
    ['response.content', resp.response?.content],
    ['response.output', resp.response?.output],
    ['response.text', resp.response?.text],
    ['response.output_text', resp.response?.output_text],
    ['output_text', resp.output_text],
    ['text', resp.text],
    ['completion', resp.completion],
    ['delta.text', resp.delta?.text],
    ['delta.partial_json', resp.delta?.partial_json],
    ['event.delta.text', resp.event?.delta?.text],
    ['event.content_block.text', resp.event?.content_block?.text],
    ['choices[].text', Array.isArray(resp.choices) ? resp.choices.map((c: any) => c?.text ?? '').join('') : undefined],
    [
      'choices[].message.content',
      Array.isArray(resp.choices) ? resp.choices.map((c: any) => textFromContentValue(c?.message?.content)).join('') : undefined,
    ],
    [
      'choices[].message.output_text',
      Array.isArray(resp.choices) ? resp.choices.map((c: any) => c?.message?.output_text ?? '').join('') : undefined,
    ],
  ];

  for (const [loc, val] of candidates) {
    if (val === undefined || val === null) continue;
    const text = typeof val === 'string' ? val : textFromContentValue(val);
    if (text) return { text, location: loc };
  }
  return { text: '', location: 'no-text-field-found' };
}

/** True when the upstream response already speaks OpenAI Chat Completions. */
export function isOpenAICompatible(resp: any): boolean {
  return !!resp && (resp?.object === 'chat.completion' || Array.isArray(resp?.choices));
}

/**
 * Normalize a parsed upstream body into an OpenAI Chat Completion shape:
 *   choices[0].message.role | choices[0].message.content (never null) |
 *   finish_reason | usage | id | model | created
 *
 * - OpenAI-compatible bodies pass through, with `content: null` coerced to ''.
 * - Everything else (Anthropic, custom) is built from the exhaustive text
 *   extractor. A non-JSON body yields content '' (never null) — HTML is never
 *   turned into JSON.
 */
export function normalizeToOpenAI(resp: any, requestedModel: string): any {
  const { body, wasJson } = parseResponseBody(resp);
  const obj = wasJson && body && typeof body === 'object' ? body : null;
  if (!obj) {
    const found = findTextInResponse(resp);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: null,
      _extract: found,
    };
  }

  if (isOpenAICompatible(obj)) {
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    const msg = choice?.message;
    if (msg && msg.content === null) msg.content = '';
    return obj;
  }

  const found = findTextInResponse(obj);
  const completion: any = {
    id: obj?.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: obj?.created ?? Math.floor(Date.now() / 1000),
    model: obj?.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: found.text ?? '' },
        finish_reason: obj?.stop_reason ?? 'stop',
      },
    ],
    usage: obj?.usage && typeof obj.usage === 'object'
      ? {
          prompt_tokens: obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? null,
          completion_tokens: obj.usage.completion_tokens ?? obj.usage.output_tokens ?? null,
          total_tokens: obj.usage.total_tokens ??
            (obj.usage.prompt_tokens !== undefined && obj.usage.completion_tokens !== undefined
              ? obj.usage.prompt_tokens + obj.usage.completion_tokens
              : obj.usage.input_tokens !== undefined && obj.usage.output_tokens !== undefined
                ? obj.usage.input_tokens + obj.usage.output_tokens
                : null),
        }
      : null,
    _extract: found,
  };
  if (Array.isArray(obj?.content) && obj.content.some((b: any) => b?.type === 'tool_use')) {
    completion.choices[0].message.tool_calls = obj.content
      .filter((b: any) => b?.type === 'tool_use')
      .map((b: any, i: number) => ({
        id: b.id ?? `call_${i}`,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
  }
  return completion;
}
