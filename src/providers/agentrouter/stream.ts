// AgentRouter SSE stream handling.
//   - OpenAI-compatible upstream streams are passed through verbatim.
//   - Anthropic Messages SSE streams are transcoded to OpenAI Chat Completions
//     chunk events (text + tool deltas) + a final [DONE].
//
// Handled events: message_start, content_block_start (text/tool_use),
// content_block_delta (text_delta / thinking_delta / input_json_delta),
// message_delta (stop_reason + usage), message_stop.

import { Transform } from 'stream';
import { responseExtractLog } from './logger';

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

/**
 * Transcode an Anthropic Messages SSE stream into OpenAI `chat.completion.chunk`
 * events plus a final `data: [DONE]`. Handles text and tool-use deltas.
 */
export function createAnthropicToOpenAIStream(requestedModel: string): Transform {
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let id = `chatcmpl-${Date.now()}`;
  let sentRole = false;
  let toolIndex = 0;
  // Track tool names/ids announced by content_block_start so that input_json
  // deltas can be attributed to the right tool call.
  const toolNames: Record<number, string> = {};
  // Accumulate the full assistant text across all deltas (for end-of-stream log).
  let accumText = '';
  let extractLogged = false;

  function chunk(delta: any, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  return new Transform({
    transform(piece: Buffer, _enc, cb) {
      const push = (data: string): void => { this.push(data); };
      const ensureRole = (): void => {
        if (sentRole) return;
        sentRole = true;
        push(chunk({ role: 'assistant', content: '' }, null));
      };

      buffer += piece.toString('utf8');
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        let evt: any;
        try { evt = JSON.parse(jsonStr); } catch { continue; }

        if (evt.type === 'message_start') {
          if (evt.message?.id) id = evt.message.id;
          ensureRole();
          continue;
        }

        if (evt.type === 'content_block_start') {
          ensureRole();
          const block = evt.content_block;
          const idx = evt.index ?? 0;
          if (block?.type === 'tool_use') {
            toolNames[idx] = block.name || '';
            toolIndex = Math.max(toolIndex, idx);
            // Emit a tool_call header with the name so OpenAI clients see it.
            const toolCalls = [
              {
                index: idx,
                id: block.id ?? `call_${idx}`,
                type: 'function',
                function: { name: block.name || '', arguments: '' },
              },
            ];
            push(chunk({ tool_calls: toolCalls }, null));
          } else if (block?.type === 'text') {
            if (block.text) {
              accumText += block.text;
              push(chunk({ content: block.text }, null));
            }
          } else if (block?.type === 'thinking' && block.thinking) {
            push(chunk({ reasoning_content: block.thinking }, null));
          }
          continue;
        }

        if (evt.type === 'content_block_delta') {
          ensureRole();
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            accumText += evt.delta.text;
            push(chunk({ content: evt.delta.text }, null));
          } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
            push(chunk({ reasoning_content: evt.delta.thinking }, null));
          } else if (evt.delta?.type === 'input_json_delta') {
            const idx = evt.index ?? toolIndex;
            const toolCalls = [
              {
                index: idx,
                id: `call_${idx}`,
                type: 'function',
                function: { name: toolNames[idx] ?? '', arguments: evt.delta.partial_json ?? '' },
              },
            ];
            push(chunk({ tool_calls: toolCalls }, null));
          }
          continue;
        }

        if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          const fr = STOP_REASON_MAP[evt.delta.stop_reason] ?? 'stop';
          /* Anthropic carries the final token usage on message_delta. Emit it
           * as an [OI]-style usage chunk so downstream usage capture (and the
           * usage dashboard) records real tokens instead of null. */
          if (evt.usage && typeof evt.usage === 'object') {
            const inTok = typeof evt.usage.input_tokens === 'number' ? evt.usage.input_tokens : null;
            const outTok = typeof evt.usage.output_tokens === 'number' ? evt.usage.output_tokens : null;
            if (inTok !== null || outTok !== null) {
              push(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                usage: {
                  prompt_tokens: inTok ?? 0,
                  completion_tokens: outTok ?? 0,
                  total_tokens: (inTok ?? 0) + (outTok ?? 0),
                },
              })}\n\n`);
            }
          }
          push(chunk({}, fr));
          continue;
        }

        if (evt.type === 'message_stop') {
          if (!extractLogged) {
            extractLogged = true;
            responseExtractLog(requestedModel, accumText, 'stream.content_block_delta[].delta.text');
          }
          push('data: [DONE]\n\n');
          continue;
        }

        // Any other Anthropic event is ignored (ping, error fields, etc.).
      }
      cb();
    },
    flush(cb) {
      if (!extractLogged) {
        extractLogged = true;
        responseExtractLog(requestedModel, accumText, 'stream.content_block_delta[].delta.text(flush)');
      }
      this.push('data: [DONE]\n\n');
      cb();
    },
  });
}

/** Passthrough identity stream (used for OpenAI-compatible / proxy-mode SSE). */
export function passthroughStream(): Transform {
  return new Transform({
    transform(piece: Buffer, _enc, cb) {
      this.push(piece);
      cb();
    },
  });
}