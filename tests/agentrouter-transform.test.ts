import { describe, it, expect } from 'vitest';
import { openaiToAnthropic, anthropicToOpenAI, createAnthropicToOpenAIStream } from '../src/providers/agentrouter/anthropic-transform';

describe('OpenAI <-> Anthropic translation', () => {
  it('hoists system messages and maps roles/content', () => {
    const body = openaiToAnthropic({
      model: 'anthropic/claude-x',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      max_tokens: 256,
      temperature: 0.5,
      stop: ['END'],
    });
    expect(body.system).toBe('you are helpful');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.5);
    expect(body.stop_sequences).toEqual(['END']);
  });

  it('defaults max_tokens when absent (Anthropic requires it)', () => {
    const body = openaiToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(typeof body.max_tokens).toBe('number');
  });

  it('translates vision image_url parts into anthropic image blocks', () => {
    const body = openaiToAnthropic({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
    });
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('maps tools to anthropic tool schema', () => {
    const body = openaiToAnthropic({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });
    expect(body.tools).toEqual([{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('translates an anthropic response back to an OpenAI chat completion', () => {
    const out = anthropicToOpenAI({
      id: 'msg_1',
      model: 'anthropic/claude-x',
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    }, 'claude-x');
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.content).toBe('answer');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it('translates tool_use blocks into OpenAI tool_calls', () => {
    const out = anthropicToOpenAI({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'x' } }],
      stop_reason: 'tool_use',
    }, 'm');
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'x' }) } },
    ]);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
  });

  it('transcodes an anthropic SSE stream into OpenAI chat.completion.chunk SSE', async () => {
    const t = createAnthropicToOpenAIStream('claude-x');
    const out: string[] = [];
    t.on('data', (d: Buffer) => out.push(d.toString()));
    const done = new Promise<void>((res) => t.on('end', () => res()));

    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n');
    t.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n');
    t.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    t.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    t.end();
    await done;

    const joined = out.join('');
    expect(joined).toContain('"content":"Hel"');
    expect(joined).toContain('"content":"lo"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).toContain('data: [DONE]');
  });
});
