/* ============================================================================
 * nvidia-api · openai-responses protocol adapter (upstream Responses API)
 * ----------------------------------------------------------------------------
 * The gateway speaks OpenAI Chat internally. Routes with protocol
 * 'openai-responses' (e.g. Codex-style `POST /responses` upstreams) translate:
 *   chat payload  -> Responses request  (buildResponsesRequest)
 *   Responses body -> chat completion   (parseResponsesResponse)
 * Field mapping mirrors utils/responses.ts (client edge) in reverse so both
 * directions stay consistent. Reasoning/thinking blocks are preserved as
 * `reasoning_content` instead of being dropped.
 * ========================================================================== */
import { Readable, Transform } from 'stream';

function messageContentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text ?? '';
        if (p?.type === 'input_text') return p.text ?? p.input_text ?? '';
        return '';
      })
      .join('');
  }
  return '';
}

/* Chat-format function tools ({type:'function', function:{name,...}}) must be
 * flattened for the Responses API ({type:'function', name,...}). Strict
 * upstreams (e.g. Kie.ai) reject the nested chat shape with HTTP 500.
 * Anything already in Responses shape, or a non-function tool, passes
 * through untouched. */
export function toResponsesTools(tools: any): any {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t: any) => {
    if (t && t.type === 'function' && t.function && typeof t.function === 'object') {
      const out: any = { type: 'function', name: t.function.name };
      if (t.function.description !== undefined) out.description = t.function.description;
      if (t.function.parameters !== undefined) out.parameters = t.function.parameters;
      if (t.function.strict !== undefined) out.strict = t.function.strict;
      return out;
    }
    return t;
  });
}

/* Chat object tool_choice ({type:'function', function:{name}}) becomes the
 * Responses form ({type:'function', name}). Plain strings ('auto', 'none',
 * 'required') are valid in both APIs and pass through. */
export function toResponsesToolChoice(toolChoice: any): any {
  if (toolChoice && typeof toolChoice === 'object'
    && toolChoice.type === 'function' && toolChoice.function?.name) {
    return { type: 'function', name: toolChoice.function.name };
  }
  return toolChoice;
}

/** Translate an internal chat payload into an upstream Responses request. */
export function buildResponsesRequest(chatPayload: any, backendModel: string): any {

  const messages: any[] = Array.isArray(chatPayload?.messages) ? chatPayload.messages : [];
  const instructions: string[] = [];
  const input: any[] = [];

  for (const msg of messages) {
    if (msg?.role === 'system') {
      const text = messageContentToText(msg.content);
      if (text) instructions.push(text);
      continue;
    }
    const text = messageContentToText(msg?.content);
    if (Array.isArray(msg?.content)) {
      const parts = msg.content
        .map((p: any) => {
          if (typeof p === 'string') return { type: 'input_text', text: p };
          if (p?.type === 'text' || p?.type === 'input_text') {
            return { type: 'input_text', text: p.text ?? '' };
          }
          return null;
        })
        .filter(Boolean);
      input.push({ role: msg?.role || 'user', content: parts.length > 0 ? parts : text });
    } else {
      input.push({ role: msg?.role || 'user', content: [{ type: 'input_text', text }] });
    }
  }

  const body: any = { model: backendModel, input };
  if (instructions.length > 0) body.instructions = instructions.join('\n\n');
  /* Always send an explicit `stream` flag. Some upstreams (e.g. Kie.ai's
   * /codex/v1/responses) default to SSE when the field is OMITTED, which makes
   * a non-streaming call look successful while returning an unparseable event
   * stream. The OpenAI Responses API defaults to false, so being explicit is
   * safe and keeps non-streaming responses JSON. */
  body.stream = !!chatPayload?.stream;
  if (chatPayload?.temperature !== undefined) body.temperature = chatPayload.temperature;
  if (chatPayload?.top_p !== undefined) body.top_p = chatPayload.top_p;
  if (chatPayload?.max_tokens !== undefined) body.max_output_tokens = chatPayload.max_tokens;
  if (chatPayload?.tools !== undefined) body.tools = toResponsesTools(chatPayload.tools);
  if (chatPayload?.tool_choice !== undefined) body.tool_choice = toResponsesToolChoice(chatPayload.tool_choice);
  if (chatPayload?.stop !== undefined) body.stop = chatPayload.stop;
  if (chatPayload?.reasoning !== undefined) body.reasoning = chatPayload.reasoning;
  if (chatPayload?.text !== undefined) body.text = chatPayload.text;
  if (chatPayload?.parallel_tool_calls !== undefined) body.parallel_tool_calls = chatPayload.parallel_tool_calls;
  if (chatPayload?.truncation !== undefined) body.truncation = chatPayload.truncation;
  if (chatPayload?.metadata !== undefined) body.metadata = chatPayload.metadata;
  return body;
}

/** Translate an upstream Responses body into an internal chat completion. */
export function parseResponsesResponse(resp: any, requestedModel: string): any {
  const obj = resp && typeof resp === 'object' ? resp : {};
  const output: any[] = Array.isArray(obj.output) ? obj.output : [];
  const texts: string[] = [];
  const toolCalls: any[] = [];
  const reasoningParts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === 'reasoning' || item.type === 'reasoning_output') {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s: any) => (typeof s === 'string' ? s : s?.text ?? '')).join('')
        : '';
      if (summary) reasoningParts.push(summary);
    }
  }

  const message: any = { role: 'assistant', content: texts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('\n');

  const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
  const stopMap: Record<string, string> = { completed: 'stop', incomplete: 'length', failed: 'stop' };

  return {
    id: obj.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: obj.created ?? Math.floor(Date.now() / 1000),
    model: obj.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : (stopMap[obj.status] ?? 'stop'),
      },
    ],
    usage: usage
      ? {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      }
      : null,
  };
}

export function extractResponsesUsage(resp: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  const u = resp?.usage;
  if (!u || typeof u !== 'object') return null;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : u.input_tokens + u.output_tokens,
  };
}

export function normalizeResponsesError(error: any): { status: number; message: string; quota: boolean } {
  const status = error?.status ?? error?.response?.status ?? 500;
  let body: any = error?.response?.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const message = body?.error?.message ?? body?.message ?? error?.message ?? 'upstream responses error';
  const text = String(message).toLowerCase();
  const quota = status === 429
    || text.includes('rate limit')
    || text.includes('quota')
    || text.includes('rate_limit')
    || text.includes('too many requests');
  return { status, message: String(message), quota };
}

/* Streaming: transcode upstream Responses SSE into OpenAI chat chunks.
 * Handled events: `response.output_text.delta` (text), `response.reasoning_*
 * (reasoning), `response.function_call_arguments.delta` (tool args),
 * `response.completed` / `data: [DONE]` (finish + [DONE]). Unknown events are
 * ignored so provider-specific additions never break the stream. */
export function createResponsesToOpenAIStream(requestedModel: string): Transform {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now()}`;
  let buffer = '';
  let roleSent = false;
  let doneSent = false;
  const toolArgs: Record<string, string> = {};

  const chunk = (delta: any, finish: string | null = null): string => `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  const done = (): string => {
    if (doneSent) return '';
    doneSent = true;
    return 'data: [DONE]\n\n';
  };
  const ensureRole = (push: (s: string) => void): void => {
    if (roleSent) return;
    roleSent = true;
    push(chunk({ role: 'assistant', content: '' }));
  };

  return new Transform({
    transform(piece: Buffer, _enc: BufferEncoding, cb: any) {
      try {
        const push = (s: string): void => { (this as any).push(s); };
        buffer += piece.toString('utf8');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const raw of frames) {
          const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length === 0) continue;
          let event = '';
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          for (const payload of dataLines) {
            if (payload === '[DONE]') { push(done()); continue; }
            let data: any;
            try { data = JSON.parse(payload); } catch { continue; }
            if (event === 'response.output_text.delta' && typeof data.delta === 'string') {
              ensureRole(push);
              push(chunk({ content: data.delta }));
            } else if ((event === 'response.reasoning_text.delta' || event === 'response.reasoning_summary_text.delta') && typeof data.delta === 'string') {
              ensureRole(push);
              push(chunk({ reasoning_content: data.delta } as any));
            } else if (event === 'response.function_call_arguments.delta') {
              ensureRole(push);
              const callId = String(data.item_id ?? data.id ?? 'call_0');
              toolArgs[callId] = (toolArgs[callId] ?? '') + String(data.delta ?? '');
              push(chunk({
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name: data.name ?? '', arguments: String(data.delta ?? '') },
                }],
              }));
            } else if (event === 'response.completed' || event === 'response.done' || event === 'response.failed') {
              push(chunk({}, 'stop'));
              push(done());
            } else if (data?.type === 'response.completed') {
              push(chunk({}, 'stop'));
              push(done());
            }
          }
        }
        cb(null);
      } catch (err: any) {
        cb(err);
      }
    },
    flush(cb: any) {
      (this as any).push(done());
      cb(null);
    },
  });
}

/* Buffered replay: re-emit a COMPLETED OpenAI chat completion as SSE chunks.
 * Used ONLY as a fallback when an upstream route rejects `stream: true`
 * outright (e.g. Kie.ai's /codex/v1/responses answers HTTP 500 to streaming
 * requests while non-streaming works). The client still receives a valid
 * OpenAI chat SSE stream (role -> content/tool_calls -> finish -> [DONE]);
 * nothing is fabricated — every byte comes from the real completion.
 * `usage` (when present) rides on the final chunk so stream usage capture
 * (services/stream-usage.ts extractUsage) records real tokens. */
export function chatCompletionToOpenAIStream(completion: any, requestedModel: string): Readable {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now()}`;
  const choice = completion?.choices?.[0] ?? {};
  const message = choice?.message ?? {};
  const text = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const usage = completion?.usage && typeof completion.usage === 'object' ? completion.usage : null;

  const chunk = (delta: any, finishReason: string | null = null, withUsage = false): string => {
    const body: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage && usage) body.usage = usage;
    return `data: ${JSON.stringify(body)}\n\n`;
  };

  const frames: string[] = [chunk({ role: 'assistant', content: '' })];
  if (text) frames.push(chunk({ content: text }));
  toolCalls.forEach((tc: any, i: number) => {
    frames.push(chunk({
      tool_calls: [{
        index: i,
        id: tc?.id ?? `call_${i}`,
        type: 'function',
        function: {
          name: tc?.function?.name ?? '',
          arguments: typeof tc?.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc?.function?.arguments ?? {}),
        },
      }],
    }));
  });
  frames.push(chunk({}, finish, true));
  frames.push('data: [DONE]\n\n');
  return Readable.from(frames);
}
