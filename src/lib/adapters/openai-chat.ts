/* ============================================================================
 * nvidia-api · openai-chat protocol adapter (passthrough)
 * ----------------------------------------------------------------------------
 * Default behavior for all existing single-endpoint providers: the gateway
 * already speaks OpenAI Chat Completions, so no translation is applied.
 * Usage/error helpers use the same field names as the rest of the gateway.
 * ========================================================================== */

export function buildOpenAIChatRequest(chatPayload: any): any {
  return { ...chatPayload };
}

export function parseOpenAIChatResponse(resp: any): any {
  return resp;
}

export function extractOpenAIChatUsage(resp: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  const u = resp?.usage;
  if (!u) return null;
  const prompt = u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.inputTokens;
  const completion = u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.outputTokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : prompt + completion,
  };
}

/** Normalize an upstream error to {status, message, retryable, quota}. */
export function normalizeOpenAIChatError(error: any): { status: number; message: string; quota: boolean } {
  const status = error?.status ?? error?.response?.status ?? 500;
  let body: any = error?.response?.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const message = body?.error?.message ?? body?.message ?? error?.message ?? 'upstream error';
  const text = String(message).toLowerCase();
  const quota = status === 429
    || text.includes('rate limit')
    || text.includes('quota exceeded')
    || text.includes('rate_limit')
    || text.includes('too many requests');
  return { status, message: String(message), quota };
}
