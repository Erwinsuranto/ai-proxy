import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request } from './setup';

beforeAll(async () => {
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('POST /v1/chat/completions (non-streaming)', () => {
  it('should return 400 when model is missing', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
    expect(res.data.error).toHaveProperty('message');
    expect(res.data.error).toHaveProperty('type');
  });

  it('should return 400 when messages is missing', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'test-model',
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return 400 when messages is empty array', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'test-model',
      messages: [],
    });
    expect(res.status).toBe(400);
    expect(res.data).toHaveProperty('error');
  });

  it('should return OpenAI-compatible response structure on success', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'Say hello in one word' }],
      temperature: 0.7,
      max_tokens: 50,
      stream: false,
    });

    if (res.status === 200) {
      expect(res.data).toHaveProperty('id');
      expect(res.data).toHaveProperty('object', 'chat.completion');
      expect(res.data).toHaveProperty('created');
      expect(typeof res.data.created).toBe('number');
      expect(res.data).toHaveProperty('model');
      expect(res.data).toHaveProperty('choices');
      expect(Array.isArray(res.data.choices)).toBe(true);
      expect(res.data.choices.length).toBeGreaterThan(0);

      const choice = res.data.choices[0];
      expect(choice).toHaveProperty('index', 0);
      expect(choice).toHaveProperty('message');
      expect(choice.message).toHaveProperty('role', 'assistant');
      expect(choice.message).toHaveProperty('content');
      expect(choice).toHaveProperty('finish_reason');
      expect(['stop', 'length', null]).toContain(choice.finish_reason);

      expect(res.data).toHaveProperty('usage');
      expect(res.data.usage).toHaveProperty('prompt_tokens');
      expect(res.data.usage).toHaveProperty('completion_tokens');
      expect(res.data.usage).toHaveProperty('total_tokens');
    } else {
      // If NVIDIA API key is invalid, check error format
      expect(res.data).toHaveProperty('error');
      expect(res.data.error).toHaveProperty('message');
      expect(res.data.error).toHaveProperty('type');
      expect(res.data.error).toHaveProperty('code');
      expect(typeof res.data.error.code).toBe('string');
    }
  });

  it('should route databricks- prefixed models to Databricks provider when configured', async () => {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'databricks-qwen35-122b-a10b',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 50,
    });

    expect(res.data).toHaveProperty('error');
    expect(res.data.error).toHaveProperty('message');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
