// AgentRouter response parsing. All response parsing lives here.
//
// - OpenAI-compatible upstream responses are passed through untouched (no
//   re-parsing) so tools/vision/reasoning/citations survive verbatim.
// - Anthropic Messages responses (including tool_calls, reasoning and citation
//   blocks) are translated into an OpenAI Chat Completion shape.
// - In proxy mode the raw upstream body/stream is returned unchanged.
//
// The Anthropic transformer is intentionally defensive: it accepts content as a
// plain string OR an array of blocks, concatenates every text block, extracts
// tool_use blocks, ignores thinking/redacted_thinking unless needed, and always
// preserves id/model/created/usage/finish_reason.

interface AnthropicContentBlock {
  type: string;
  text?: string;
  value?: string;
  thinking?: string;
  cited_text?: string;
  [k: string]: any;
}

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

/** True when the upstream already speaks OpenAI (passthrough, no re-parse). */
export function isOpenAICompatible(resp: any): boolean {
  return !!resp && (resp?.object === 'chat.completion' || Array.isArray(resp?.choices) || !!resp?.id);
}

/**
 * Normalize the raw upstream HTTP body. Axios may hand us a JSON object already
 * (application/json) or a raw string (text/html WAF page, malformed JSON, ...).
 * This reports whether the body was parseable JSON and returns the parsed body
 * (or the original string when it is not JSON).
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
 * - string              -> itself
 * - array of blocks     -> concatenates every text-ish block
 *   (type: text | input_text | output_text | value | citation.cited_text)
 * - object with .text   -> its text
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
    [
      'choices[].text',
      Array.isArray(resp.choices) ? resp.choices.map((c: any) => c?.text ?? '').join('') : undefined,
    ],
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

/** Flatten an Anthropic content payload into an array of blocks. */
function toBlocks(content: any): AnthropicContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content as AnthropicContentBlock[];
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return [content as AnthropicContentBlock];
  }
  return [];
}

/**
 * Extract the assistant text from Anthropic content blocks.
 * - Multiple text blocks are concatenated into a single string.
 * - text blocks, plain strings, and content objects are all supported.
 */
function extractText(blocks: AnthropicContentBlock[]): string {
  return textFromContentValue(blocks);
}

/** Translate an Anthropic Messages response into an OpenAI Chat Completion. */
export function anthropicToOpenAI(resp: any, requestedModel: string): any {
  const { body, wasJson } = parseResponseBody(resp);
  const obj = wasJson && body && typeof body === 'object' ? body : null;

  const source = obj?.content ?? obj?.message?.content ?? obj;
  const blocks = toBlocks(source);
  let text = extractText(blocks);
  if (!text) {
    const found = findTextInResponse(resp);
    text = found.text;
  }

  const toolCalls: any[] = [];
  let reasoning = '';
  const citations: string[] = [];

  for (const b of blocks) {
    if (typeof b !== 'object' || !b) continue;
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      reasoning += b.thinking ?? '';
    } else if (b.type === 'citation' && typeof b.cited_text === 'string') {
      citations.push(b.cited_text);
    }
  }

  const message: any = { role: 'assistant', content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  if (citations.length > 0) message.citations = citations;

  const inputTokens = typeof obj?.usage?.input_tokens === 'number' ? obj.usage.input_tokens : null;
  const outputTokens = typeof obj?.usage?.output_tokens === 'number' ? obj.usage.output_tokens : null;

  const completion: any = {
    id: obj?.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: obj?.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[obj?.stop_reason] ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    usage: inputTokens !== null && outputTokens !== null
      ? { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
      : null,
  };

  return completion;
}
