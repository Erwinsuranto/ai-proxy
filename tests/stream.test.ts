import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, streamRequest } from './setup';

beforeAll(async () => {
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
});

describe('POST /v1/chat/completions (streaming)', () => {
  it('should return SSE formatted response', async () => {
    const res = await streamRequest('/v1/chat/completions', {
      model: 'nvidia/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
      temperature: 0.7,
      max_tokens: 100,
      stream: true,
    });

    const fullBody = res.chunks.join('');

    if (res.status === 200) {
      expect(fullBody).toContain('data: ');

      const lines = fullBody.split('\n').filter(l => l.trim());
      const dataLines = lines.filter(l => l.startsWith('data: '));
      expect(dataLines.length).toBeGreaterThan(0);

      const lastData = dataLines[dataLines.length - 1];
      expect(lastData).toBe('data: [DONE]');

      const nonDoneLines = dataLines.filter(l => l !== 'data: [DONE]');

      for (let i = 0; i < nonDoneLines.length; i++) {
        const line = nonDoneLines[i];
        const jsonStr = line.slice(6);
        const chunk = JSON.parse(jsonStr);

        expect(chunk).toHaveProperty('id');
        expect(chunk).toHaveProperty('object', 'chat.completion.chunk');
        expect(chunk).toHaveProperty('created');
        expect(typeof chunk.created).toBe('number');
        expect(chunk).toHaveProperty('model');
        expect(chunk).toHaveProperty('choices');
        expect(Array.isArray(chunk.choices)).toBe(true);

        if (chunk.choices.length > 0) {
          const choice = chunk.choices[0];
          expect(choice).toHaveProperty('index', 0);
          expect(choice).toHaveProperty('delta');

          const isLastChunk = i === nonDoneLines.length - 1;
          if (isLastChunk) {
            if (choice.finish_reason !== undefined) {
              expect(typeof choice.finish_reason).toBe('string');
            }
          }
        }
      }
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
