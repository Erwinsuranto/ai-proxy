import { Transform, TransformCallback } from 'stream';

/** Represents a single input item in a /v1/responses request. */
interface ResponsesInputItem {
  role?: string;
  content?: string | any[];
  type?: string;
}

/** Converts a /v1/responses request body into a /v1/chat/completions request body. */
export function convertToChatRequest(body: any): any {
  const chat: any = {
    model: body.model,
    stream: body.stream ?? false,
  };

  if (body.input) {
    if (typeof body.input === 'string') {
      chat.messages = [{ role: 'user', content: body.input }];
    } else if (Array.isArray(body.input)) {
      chat.messages = body.input.map((item: ResponsesInputItem) => {
        if (typeof item === 'string') {
          return { role: 'user', content: item };
        }
        if (Array.isArray(item.content)) {
          const textParts = item.content
            .filter((c: any) => c.type === 'input_text' || c.type === 'text')
            .map((c: any) => c.text);
          return { role: item.role || 'user', content: textParts.join('\n') || null };
        }
        return { role: item.role || 'user', content: item.content ?? '' };
      });
    }
  }

  if (body.instructions) {
    chat.messages = [
      { role: 'system', content: body.instructions },
      ...(chat.messages || []),
    ];
  }

  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.tools !== undefined) chat.tools = body.tools;
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  if (body.stop !== undefined) chat.stop = body.stop;

  return chat;
}

/** Converts a /v1/chat/completions response object into a /v1/responses response body. */
export function convertFromChatResponse(chatResponse: any, requestBody: any): any {
  const choice = chatResponse.choices?.[0];
  const message = choice?.message || {};

  const output: any[] = [];

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg-${chatResponse.id || ''}`,
      status: 'completed',
      role: 'assistant',
      content: [
        { type: 'output_text', text: message.content, annotations: [] },
      ],
    });
  }

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
        status: 'completed',
      });
    }
  }

  if (output.length === 0) {
    output.push({
      type: 'message',
      id: `msg-${chatResponse.id || ''}`,
      status: 'completed',
      role: 'assistant',
      content: message.content
        ? [{ type: 'output_text', text: message.content, annotations: [] }]
        : [],
    });
  }

  const statusMap: Record<string, string> = {
    stop: 'completed',
    tool_calls: 'completed',
    length: 'incomplete',
    content_filter: 'incomplete',
  };

  return {
    id: chatResponse.id || `resp-${Date.now()}`,
    object: 'response',
    created: chatResponse.created || Math.floor(Date.now() / 1000),
    /* Always report the CLIENT-requested model — never the internal backend
     * model the upstream actually served (routing detail stays internal). */
    model: requestBody.model || chatResponse.model,
    status: statusMap[choice?.finish_reason] || 'completed',
    incomplete_details: choice?.finish_reason === 'length' ? { type: 'max_tokens' } : null,
    instructions: requestBody.instructions || null,
    max_output_tokens: requestBody.max_output_tokens || null,
    temperature: requestBody.temperature ?? null,
    top_p: requestBody.top_p ?? null,
    tools: requestBody.tools || [],
    tool_choice: requestBody.tool_choice || 'auto',
    usage: chatResponse.usage
      ? {
          input_tokens: chatResponse.usage.prompt_tokens || 0,
          output_tokens: chatResponse.usage.completion_tokens || 0,
          total_tokens: chatResponse.usage.total_tokens || 0,
        }
      : null,
    output,
  };
}

/** Tracks the accumulated state of a tool call during streaming responses transformation. */
interface ToolCallState {
  index: number;
  id: string;
  type: string;
  name: string;
  arguments: string;
}

/** Tracks the accumulated state of a streaming responses transformation from chat completions SSE format to responses API SSE format. */
interface TransformState {
  responseId: string;
  model: string;
  created: number;
  chatResponseId: string;
  hasText: boolean;
  hasToolCalls: boolean;
  textBuffer: string;
  toolCallStates: Map<number, ToolCallState>;
  finishReason: string | null;
  usage: any;
  isFirstChunk: boolean;
  textOutputItemEmitted: boolean;
  textContentPartEmitted: boolean;
}

/** Creates a Transform stream that converts a chat completions SSE stream into a responses API SSE stream. */
export function createResponsesStream(
  chatResponseId: string,
  model: string,
  created: number,
): Transform {
  const state: TransformState = {
    responseId: chatResponseId,
    model,
    created: created || Math.floor(Date.now() / 1000),
    chatResponseId,
    hasText: false,
    hasToolCalls: false,
    textBuffer: '',
    toolCallStates: new Map(),
    finishReason: null,
    usage: null,
    isFirstChunk: true,
    textOutputItemEmitted: false,
    textContentPartEmitted: false,
  };

  function writeEvent(event: string, data: any): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function emitResponseDone(): string {
    const statusMap: Record<string, string> = {
      tool_calls: 'completed',
      stop: 'completed',
      length: 'incomplete',
    };
    return writeEvent('response.done', {
      id: state.responseId,
      object: 'response',
      created: state.created,
      model,
      status: statusMap[state.finishReason || ''] || 'completed',
      incomplete_details: state.finishReason === 'length' ? { type: 'max_tokens' } : null,
      instructions: null,
      max_output_tokens: null,
      temperature: null,
      top_p: null,
      tools: [],
      tool_choice: 'auto',
      usage: state.usage
        ? {
            input_tokens: state.usage.prompt_tokens || 0,
            output_tokens: state.usage.completion_tokens || 0,
            total_tokens: state.usage.total_tokens || 0,
          }
        : null,
      output: [],
    });
  }

  function emitFinalOutputs(): string {
    let result = '';

    if (state.hasText) {
      const textContent = [
        { type: 'output_text' as const, text: state.textBuffer, annotations: [] },
      ];
      result += writeEvent('response.output_item.done', {
        type: 'message',
        id: `msg-${state.responseId}`,
        status: 'completed',
        role: 'assistant',
        content: textContent,
      });
    }

    for (const tc of state.toolCallStates.values()) {
      result += writeEvent('response.output_item.done', {
        type: 'function_call',
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: 'completed',
      });
    }

    return result;
  }

  let leftover = '';

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const text = leftover + chunk.toString();
        const lines = text.split('\n');
        leftover = lines.pop() || '';

        let result = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed === 'data: [DONE]') {
            if (state.hasText) {
              result += emitFinalOutputs();
            } else if (state.hasToolCalls) {
              result += emitFinalOutputs();
            }
            result += emitResponseDone();
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};
          const finishReason = choice.finish_reason || null;

          if (finishReason) {
            state.finishReason = finishReason;
          }

          if (delta.role === 'assistant' && state.isFirstChunk) {
            state.isFirstChunk = false;
            state.responseId = parsed.id || state.responseId;
            /* Keep the CLIENT-requested model — never adopt the upstream's
             * internal backend model from the chunk payload. */
            state.model = model;
            state.created = parsed.created || state.created;
          }

          if (delta.content) {
            if (!state.hasText) {
              state.hasText = true;
              result += writeEvent('response.output_item.added', {
                type: 'message',
                id: `msg-${state.responseId}`,
                role: 'assistant',
                content: [],
              });
              result += writeEvent('response.content_part.added', {
                type: 'text',
                text: '',
              });
              state.textOutputItemEmitted = true;
              state.textContentPartEmitted = true;
            }
            state.textBuffer += delta.content;
            result += writeEvent('response.text.delta', {
              delta: delta.content,
            });
          }

          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              let existing = state.toolCallStates.get(idx);

              if (tc.id) {
                const isNew = !existing || existing.id !== tc.id;
                existing = {
                  index: idx,
                  id: tc.id,
                  type: tc.type || 'function',
                  name: tc.function?.name || existing?.name || '',
                  arguments: tc.function?.arguments || '',
                };
                state.toolCallStates.set(idx, existing);

                if (isNew) {
                  state.hasToolCalls = true;
                  result += writeEvent('response.output_item.added', {
                    type: 'function_call',
                    id: existing.id,
                    name: existing.name,
                    arguments: existing.arguments,
                  });
                }
              } else if (existing && tc.function?.arguments) {
                existing.arguments += tc.function.arguments;
                result += writeEvent('response.function_call_arguments.delta', {
                  id: existing.id,
                  delta: tc.function.arguments,
                });
              }
            }
          }

          if (delta.role === 'assistant' && !delta.content && !delta.tool_calls && state.isFirstChunk) {
            state.isFirstChunk = false;
          }
        }

        callback(null, Buffer.from(result));
      } catch (err: any) {
        callback(err);
      }
    },

    flush(callback: TransformCallback) {
      let result = '';
      if (!state.finishReason) {
        if (state.hasText) {
          result += emitFinalOutputs();
        } else if (state.hasToolCalls) {
          result += emitFinalOutputs();
        }
        result += emitResponseDone();
      }
      callback(null, Buffer.from(result));
    },
  });
}
