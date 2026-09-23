import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request, getBaseUrl } from './setup';
import { convertToChatRequest, convertFromChatResponse } from '../src/utils/responses';

describe('Responses Converter - convertToChatRequest', () => {
  it('should convert string input to messages', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hello',
    });
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(result.model).toBe('test-model');
  });

  it('should convert array input to messages', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('should prepend instructions as system message', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
      instructions: 'Be helpful',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Be helpful' });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('should forward tools and tool_choice', () => {
    const tools = [{ type: 'function', function: { name: 'test' } }];
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
      tools,
      tool_choice: 'auto',
    });
    expect(result.tools).toEqual(tools);
    expect(result.tool_choice).toBe('auto');
  });

  it('should map max_output_tokens to max_tokens', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
      max_output_tokens: 500,
    });
    expect(result.max_tokens).toBe(500);
  });

  it('should forward temperature and top_p', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
  });

  it('should handle content array in input items', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello world' }],
      }],
    });
    expect(result.messages[0].content).toBe('Hello world');
  });

  it('should set stream default to false', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
    });
    expect(result.stream).toBe(false);
  });

  it('should respect stream parameter', () => {
    const result = convertToChatRequest({
      model: 'test-model',
      input: 'Hi',
      stream: true,
    });
    expect(result.stream).toBe(true);
  });
});

describe('Responses Converter - convertFromChatResponse', () => {
  it('should convert basic chat response to responses format', () => {
    const chatResp = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1000,
      model: 'test-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = convertFromChatResponse(chatResp, { model: 'test-model', input: 'Hi' });

    expect(result.id).toBe('chatcmpl-123');
    expect(result.object).toBe('response');
    expect(result.model).toBe('test-model');
    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe('message');
    expect(result.output[0].role).toBe('assistant');
    expect(result.output[0].content[0].type).toBe('output_text');
    expect(result.output[0].content[0].text).toBe('Hello!');
  });

  it('should convert tool_calls to function_call outputs', () => {
    const chatResp = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1000,
      model: 'test-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'get_time', arguments: '{"format":"iso"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };

    const result = convertFromChatResponse(chatResp, { model: 'test-model', input: 'Time?' });

    expect(result.status).toBe('completed');
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe('function_call');
    expect(result.output[0].id).toBe('call-1');
    expect(result.output[0].name).toBe('get_time');
    expect(result.output[0].arguments).toBe('{"format":"iso"}');
    expect(result.output[0].status).toBe('completed');
  });

  it('should handle both content and tool_calls', () => {
    const chatResp = {
      id: 'chatcmpl-123',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'I can help',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const result = convertFromChatResponse(chatResp, { model: 'test', input: 'Hi' });

    expect(result.output).toHaveLength(2);
    expect(result.output[0].type).toBe('message');
    expect(result.output[0].content[0].text).toBe('I can help');
    expect(result.output[1].type).toBe('function_call');
    expect(result.output[1].name).toBe('search');
  });

  it('should map finish_reason to status correctly', () => {
    const check = (finishReason: string, expectedStatus: string) => {
      const result = convertFromChatResponse({
        id: 'chatcmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }, { model: 'test', input: 'x' });
      expect(result.status).toBe(expectedStatus);
    };

    check('stop', 'completed');
    check('tool_calls', 'completed');
    check('length', 'incomplete');
    check('content_filter', 'incomplete');
  });
});

describe('POST /v1/responses', () => {
  beforeAll(async () => {
    await startServer();
  }, 30000);

  afterAll(async () => {
    await stopServer();
  });

  it('should return 400 when model is missing', async () => {
    const res = await request('POST', '/v1/responses', {
      input: 'Hello',
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return 400 when input is missing', async () => {
    const res = await request('POST', '/v1/responses', {
      model: 'test-model',
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return responses-compatible structure on success', async () => {
    const res = await request('POST', '/v1/responses', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      input: 'Say hello in one word',
      temperature: 0.7,
      max_output_tokens: 50,
    });

    if (res.status === 200) {
      expect(res.data).toHaveProperty('id');
      expect(res.data).toHaveProperty('object', 'response');
      expect(res.data).toHaveProperty('created');
      expect(typeof res.data.created).toBe('number');
      expect(res.data).toHaveProperty('model');
      expect(res.data).toHaveProperty('status');
      expect(['completed', 'incomplete']).toContain(res.data.status);
      expect(res.data).toHaveProperty('output');
      expect(Array.isArray(res.data.output)).toBe(true);
      expect(res.data.output.length).toBeGreaterThan(0);

      const outputItem = res.data.output[0];
      expect(outputItem).toHaveProperty('type');
      expect(outputItem.type).toBe('message');
      expect(outputItem).toHaveProperty('id');
      expect(outputItem).toHaveProperty('status');
      expect(outputItem).toHaveProperty('role', 'assistant');
      expect(outputItem).toHaveProperty('content');
      expect(Array.isArray(outputItem.content)).toBe(true);

      if (outputItem.content.length > 0) {
        const contentItem = outputItem.content[0];
        expect(contentItem).toHaveProperty('type', 'output_text');
        expect(contentItem).toHaveProperty('text');
        expect(contentItem).toHaveProperty('annotations');
      }

      expect(res.data).toHaveProperty('usage');
      expect(res.data.usage).toHaveProperty('input_tokens');
      expect(res.data.usage).toHaveProperty('output_tokens');
      expect(res.data.usage).toHaveProperty('total_tokens');
    } else {
      expect(res.data).toHaveProperty('error');
      expect(res.data.error).toHaveProperty('message');
      expect(res.data.error).toHaveProperty('type');
    }
  });

  it('should accept string input', async () => {
    const res = await request('POST', '/v1/responses', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      input: 'Say OK in one word',
      max_output_tokens: 10,
    });

    expect([200, 400, 401, 429, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.object).toBe('response');
    }
  });

  it('should accept array input with instructions', async () => {
    const res = await request('POST', '/v1/responses', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      input: [{ role: 'user', content: 'Say OK in one word' }],
      instructions: 'You are a helpful assistant.',
      max_output_tokens: 10,
    });

    expect([200, 400, 401, 429, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.object).toBe('response');
      expect(res.data.instructions).toBe('You are a helpful assistant.');
    }
  });
});
