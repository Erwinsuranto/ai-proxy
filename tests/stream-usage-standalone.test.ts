import { describe, it, expect } from 'vitest';
import { extractUsage, wrapStream } from '../src/services/stream-usage';
import { Readable, PassThrough } from 'stream';

function collectStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });
}

describe('extractUsage', () => {
  it('returns tokens from prompt_tokens/completion_tokens/total_tokens', () => {
    const result = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    expect(result).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it('returns tokens from promptTokens/completionTokens/totalTokens', () => {
    const result = extractUsage({ usage: { promptTokens: 5, completionTokens: 15, totalTokens: 20 } });
    expect(result).toEqual({ promptTokens: 5, completionTokens: 15, totalTokens: 20 });
  });

  it('calculates totalTokens when only prompt+completion given', () => {
    const result = extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(result).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it('prefers total_tokens over sum', () => {
    const result = extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 100 } });
    expect(result).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 100 });
  });

  it('returns null when no usage', () => {
    const result = extractUsage({ choices: [] });
    expect(result).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it('returns null when usage is null', () => {
    const result = extractUsage({ usage: null });
    expect(result).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it('returns null total when usage is only partially available', () => {
    const result = extractUsage({ usage: { prompt_tokens: 10 } });
    expect(result).toEqual({ promptTokens: 10, completionTokens: null, totalTokens: null });
  });

  it('returns null when body is empty object', () => {
    const result = extractUsage({});
    expect(result).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it('parses JSON string body', () => {
    const result = extractUsage('{"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}');
    expect(result).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it('returns null on invalid JSON string', () => {
    const result = extractUsage('not json');
    expect(result).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it('returns null on undefined', () => {
    const result = extractUsage(undefined);
    expect(result).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });
});

describe('wrapStream', () => {
  it('captures usage from final SSE chunk', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);

    const outputPromise = collectStream(stream);

    input.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    input.write('data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    input.write('data: [DONE]\n\n');
    input.end();

    await outputPromise;

    const usage = getUsage();
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it('returns null when no usage in stream', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);

    const outputPromise = collectStream(stream);

    input.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    input.write('data: [DONE]\n\n');
    input.end();

    await outputPromise;

    const usage = getUsage();
    expect(usage).toBeNull();
  });

  it('returns null when usage is null in final chunk', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);

    const outputPromise = collectStream(stream);

    input.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    input.write('data: {"choices":[{"delta":{}}],"usage":null}\n\n');
    input.write('data: [DONE]\n\n');
    input.end();

    await outputPromise;

    const usage = getUsage();
    expect(usage).toBeNull();
  });

  it('updates usage when later chunk has different usage', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);

    const outputPromise = collectStream(stream);

    input.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    input.write('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    input.write('data: [DONE]\n\n');
    input.end();

    await outputPromise;

    const usage = getUsage();
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it('clears earlier usage when a later chunk explicitly sends usage:null', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);
    const outputPromise = collectStream(stream);
    input.write('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    input.write('data: {"usage":null}\n\n');
    input.end();
    await outputPromise;
    expect(getUsage()).toBeNull();
  });

  it('passes stream data through without modification', async () => {
    const input = new PassThrough();
    const { stream, getUsage } = wrapStream(input);

    const outputPromise = collectStream(stream);

    input.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
    input.write('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
    input.write('data: [DONE]\n\n');
    input.end();

    const output = await outputPromise;
    expect(output).toBe('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n');

    const usage = getUsage();
    expect(usage).toBeNull();
  });
});

// Regression tests for the audited streaming-usage bug:
//   - `chatCompletionStream()` previously passed the stream *object*
//     (`{stream, keyIndex, tag}`) to `recordUsageFor()`, and usage was extracted
//     from the response body only — leaving streaming tokens null for 326/397
//     successful requests.
//   - `tryChatCompletionStream()` now wraps the underlying stream with
//     `wrapStream(result.stream)` (NOT the wrapper object) and records usage from
//     the final SSE chunk deferred until the `end` event. If upstream does not
//     provide usage, it stays null (never estimated).
describe('streaming usage regression (provider stream wrapper)', () => {
  function makeProviderResult() {
    // Mirror the shape returned by `chatCompletionStream()` providers:
    //   { stream, keyIndex, tag }
    const upstream = new PassThrough();
    const result = { stream: upstream, keyIndex: 0, tag: 'K#1' };
    return { result, upstream };
  }

  function feedWithUsage(upstream: PassThrough) {
    upstream.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    upstream.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n');
    upstream.write('data: [DONE]\n\n');
    upstream.end();
  }

  function feedWithoutUsage(upstream: PassThrough) {
    upstream.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    upstream.write('data: {"choices":[{"delta":{}}]}\n\n');
    upstream.write('data: [DONE]\n\n');
    upstream.end();
  }

  it('wraps `result.stream` (not the `{stream,keyIndex,tag}` object) and records usage when upstream provides it', async () => {
    const { result, upstream } = makeProviderResult();
    // Must use the nested `.stream` — wrapping the wrapper object must throw
    // (it has no `.pipe`). This guards against re-introducing the bug.
    expect(() => (wrapStream as any)(result)).toThrow();

    const { stream, getUsage } = wrapStream(result.stream);
    const done = collectStream(stream);
    feedWithUsage(upstream);

    const output = await done;
    expect(output).toContain('"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}');

    const usage = getUsage();
    expect(usage).toEqual({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  it('records null usage (never estimates) when upstream does not provide usage in any chunk', async () => {
    const { result, upstream } = makeProviderResult();
    const { stream, getUsage } = wrapStream(result.stream);
    const done = collectStream(stream);
    feedWithoutUsage(upstream);

    const output = await done;
    // Stream content is passed through unchanged to the client.
    expect(output).toContain('"delta":{"content":"hi"}');
    expect(output).toContain('data: [DONE]');

    const usage = getUsage();
    expect(usage).toBeNull();
  });

  // Regression: upstream chunks do NOT align to `\n` boundaries. A single SSE
  // event carrying usage in the FINAL chunk may be split across multiple
  // `transform()` calls. Without a line-buffer, that event's JSON.parse fails
  // and the streamed request is recorded with `usage: null` even though
  // upstream did send real tokens.
  it('captures usage even when the final usage chunk is split across buffers', async () => {
    const upstream = new PassThrough();
    const { stream, getUsage } = wrapStream(upstream);
    const done = collectStream(stream);

    upstream.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');

    // Split the usage event across many small writes.
    const usageLine = 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14}}\n\n';
    for (let i = 0; i < usageLine.length; i++) {
      upstream.write(usageLine[i]);
    }
    upstream.write('data: [DONE]\n\n');
    upstream.end();

    await done;
    const usage = getUsage();
    expect(usage).toEqual({ promptTokens: 8, completionTokens: 6, totalTokens: 14 });
  });

  // Regression: usage carried in the final byte buffer without a trailing `\n`
  // must still be captured (handler `_flush` in the Transform).
  it('captures usage when the final usage line has no trailing newline', async () => {
    const upstream = new PassThrough();
    const { stream, getUsage } = wrapStream(upstream);
    const done = collectStream(stream);
    upstream.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    upstream.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}');
    upstream.end();
    await done;
    expect(getUsage()).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  });

  // Regression: usage with CRLF-delimited SSE lines.
  it('handles CRLF SSE lines', async () => {
    const upstream = new PassThrough();
    const { stream, getUsage } = wrapStream(upstream);
    const done = collectStream(stream);
    upstream.write('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\r\n\r\n');
    upstream.write('data: [DONE]\r\n\r\n');
    upstream.end();
    await done;
    expect(getUsage()).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
  });
});
