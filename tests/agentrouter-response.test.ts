import { describe, it, expect } from 'vitest';
import { anthropicToOpenAI, parseResponseBody, findTextInResponse } from '../src/providers/agentrouter/response';
import { createAnthropicToOpenAIStream } from '../src/providers/agentrouter/stream';

function collectStream(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    stream.on('data', (d: Buffer) => out.push(d.toString()));
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

describe('AgentRouter Anthropic response transformer', () => {
  it('translates a single text block into an OpenAI content string', () => {
    const out = anthropicToOpenAI(
      {
        id: 'msg_1',
        model: 'anthropic/claude-opus-4.8',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      'anthropic/claude-opus-4.8',
    );
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.role).toBe('assistant');
    expect(out.choices[0].message.content).toBe('OK');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.id).toBe('msg_1');
    expect(out.model).toBe('anthropic/claude-opus-4.8');
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it('concatenates multiple text blocks into one string', () => {
    const out = anthropicToOpenAI(
      {
        id: 'msg_2',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
          { type: 'text', text: '!' },
        ],
        stop_reason: 'end_turn',
      },
      'm',
    );
    expect(out.choices[0].message.content).toBe('Hello world!');
  });

  it('returns an empty string (not null) for an empty content array', () => {
    const out = anthropicToOpenAI({ id: 'msg_3', content: [], stop_reason: 'end_turn' }, 'm');
    expect(out.choices[0].message.content).toBe('');
    expect(out.choices[0].finish_reason).toBe('stop');
  });

  it('accepts a plain string content directly', () => {
    const out = anthropicToOpenAI({ id: 'msg_4', content: 'OK', stop_reason: 'end_turn' }, 'm');
    expect(out.choices[0].message.content).toBe('OK');
  });

  it('keeps id, model, created and usage fields', () => {
    const out = anthropicToOpenAI(
      { id: 'msg_5', model: 'anthropic/claude-x', content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens', usage: { input_tokens: 2, output_tokens: 8 } },
      'm',
    );
    expect(out.id).toBe('msg_5');
    expect(out.model).toBe('anthropic/claude-x');
    expect(typeof out.created).toBe('number');
    expect(out.choices[0].finish_reason).toBe('length');
    expect(out.usage).toEqual({ prompt_tokens: 2, completion_tokens: 8, total_tokens: 10 });
  });

  it('extracts tool_use blocks into OpenAI tool_calls', () => {
    const out = anthropicToOpenAI(
      {
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'x' } },
        ],
        stop_reason: 'tool_use',
      },
      'm',
    );
    expect(out.choices[0].message.content).toBe('calling');
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'x' }) } },
    ]);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });

  it('ignores thinking/redacted_thinking blocks but preserves reasoning', () => {
    const out = anthropicToOpenAI(
      {
        content: [
          { type: 'thinking', thinking: 'secret chain of thought' },
          { type: 'text', text: 'final' },
        ],
        stop_reason: 'end_turn',
      },
      'm',
    );
    expect(out.choices[0].message.content).toBe('final');
    expect(out.choices[0].message.reasoning_content).toBe('secret chain of thought');
  });

  it('does not crash on missing content or null blocks', () => {
    const out1 = anthropicToOpenAI({ id: 'a' }, 'm');
    expect(out1.choices[0].message.content).toBe('');
    const out2 = anthropicToOpenAI({ id: 'b', content: null }, 'm');
    expect(out2.choices[0].message.content).toBe('');
  });
});

describe('AgentRouter Anthropic SSE stream transcoder', () => {
  it('accumulates content deltas into a growing content field', async () => {
    const t = createAnthropicToOpenAIStream('claude-x');
    const out: string[] = [];
    t.on('data', (d: Buffer) => out.push(d.toString()));
    const done = collectStream(t);

    t.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n');
    t.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n');
    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n');
    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" wor"}}\n\n');
    t.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    t.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    t.end();
    await done;

    const joined = out.join('');
    const chunks = joined
      .split('\n\n')
      .filter((c) => c.startsWith('data:') && !c.includes('[DONE]'))
      .map((c) => JSON.parse(c.slice(5)))
      .filter((j) => j.choices?.[0]?.delta?.content);

    const accumulated = chunks.map((c) => c.choices[0].delta.content).join('');
    expect(accumulated).toBe('Hello wor');
    expect(joined).toContain('data: [DONE]');
  });

  it('emits tool_calls deltas for input_json_delta with the announced tool name', async () => {
    const t = createAnthropicToOpenAIStream('claude-x');
    const out: string[] = [];
    t.on('data', (d: Buffer) => out.push(d.toString()));
    const done = collectStream(t);

    t.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n');
    t.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n');
    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"x\\"}"}}\n\n');
    t.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n');
    t.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    t.end();
    await done;

    const joined = out.join('');
    expect(joined).toContain('"name":"get_weather"');
    expect(joined).toContain('"finish_reason":"tool_calls"');
  });

  it('emits a role chunk before any content and ends with [DONE]', async () => {
    const t = createAnthropicToOpenAIStream('claude-x');
    const out: string[] = [];
    t.on('data', (d: Buffer) => out.push(d.toString()));
    const done = collectStream(t);

    t.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n');
    t.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    t.end();
    await done;

    const joined = out.join('');
    expect(joined).toContain('"role":"assistant"');
    expect(joined.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('parseResponseBody', () => {
  it('parses a JSON string body', () => {
    const r = parseResponseBody('{"content":[{"type":"text","text":"OK"}]}');
    expect(r.wasJson).toBe(true);
    expect(r.body.content[0].text).toBe('OK');
  });

  it('flags a non-JSON string (e.g. WAF HTML) and keeps it verbatim', () => {
    const html = '<!doctypehtml><meta name="aliyun_waf_aa"content="x">';
    const r = parseResponseBody(html);
    expect(r.wasJson).toBe(false);
    expect(r.body).toBe(html);
    expect(r.rawLength).toBe(html.length);
  });

  it('accepts an already-parsed object', () => {
    const r = parseResponseBody({ content: 'OK' });
    expect(r.wasJson).toBe(true);
    expect(r.body.content).toBe('OK');
  });

  it('reports a JSON.parse error on malformed JSON', () => {
    const r = parseResponseBody('{"content": "unterminated');
    expect(r.wasJson).toBe(false);
    expect(r.parseError).toBeTruthy();
  });
});

describe('findTextInResponse', () => {
  it('finds content[].text (array of blocks)', () => {
    const { text, location } = findTextInResponse({ content: [{ type: 'text', text: 'OK' }] });
    expect(text).toBe('OK');
    expect(location).toBe('content');
  });

  it('concatenates every text block in a content array', () => {
    const { text } = findTextInResponse({
      content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }, { type: 'text', text: '!' }],
    });
    expect(text).toBe('Hello world!');
  });

  it('finds a plain string content', () => {
    const { text, location } = findTextInResponse({ content: 'OK' });
    expect(text).toBe('OK');
    expect(location).toBe('content');
  });

  it('finds content[].value (newer Anthropic value blocks)', () => {
    const { text, location } = findTextInResponse({ content: [{ type: 'value', value: 'OK' }] });
    expect(text).toBe('OK');
    expect(location).toBe('content');
  });

  it('finds message.content and choices[].message.content (OpenAI shapes)', () => {
    expect(findTextInResponse({ message: { content: 'A' } }).location).toBe('message.content');
    expect(findTextInResponse({ choices: [{ message: { content: 'B' } }] }).location).toBe('choices[].message.content');
  });

  it('finds output_text / completion / delta.text shapes', () => {
    expect(findTextInResponse({ output_text: 'C' }).location).toBe('output_text');
    expect(findTextInResponse({ completion: 'D' }).location).toBe('completion');
    expect(findTextInResponse({ delta: { text: 'E' } }).location).toBe('delta.text');
    expect(findTextInResponse({ event: { delta: { text: 'F' } } }).location).toBe('event.delta.text');
  });

  it('never treats a non-JSON HTML body as text', () => {
    const { text, location } = findTextInResponse('<!doctypehtml><meta name="aliyun_waf_aa"content="x">');
    expect(text).toBe('');
    expect(location).toContain('non-json-string');
  });

  it('reports no-text-field-found for an object with no text anywhere', () => {
    const { text, location } = findTextInResponse({ id: 'x', usage: { input_tokens: 1 } });
    expect(text).toBe('');
    expect(location).toBe('no-text-field-found');
  });

  it('parses a JSON-encoded string response', () => {
    const { text } = findTextInResponse(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }));
    expect(text).toBe('OK');
  });
});