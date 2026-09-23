/* ============================================================================
 * nvidia-api · anthropic-messages protocol adapter (reuse, no duplication)
 * ----------------------------------------------------------------------------
 * Re-exports the proven agentrouter translation (transform + response +
 * stream) behind protocol-level names so any route with protocol
 * 'anthropic-messages' can use it without a provider-specific adapter.
 * ========================================================================== */

export { openaiToAnthropic } from '../../providers/agentrouter/transform';
export { anthropicToOpenAI } from '../../providers/agentrouter/response';
export { createAnthropicToOpenAIStream } from '../../providers/agentrouter/stream';

export function extractAnthropicUsage(resp: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  const u = resp?.usage;
  if (!u || typeof u !== 'object') return null;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
  };
}

export function normalizeAnthropicError(error: any): { status: number; message: string; quota: boolean } {
  const status = error?.status ?? error?.response?.status ?? 500;
  let body: any = error?.response?.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const message = body?.error?.message ?? body?.message ?? error?.message ?? 'upstream messages error';
  const text = String(message).toLowerCase();
  const quota = status === 429
    || text.includes('rate limit')
    || text.includes('overloaded')
    || text.includes('rate_limit')
    || text.includes('too many requests');
  return { status, message: String(message), quota };
}
