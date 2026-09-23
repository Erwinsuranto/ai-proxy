// VyceAI exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable
// (network error, WAF block, or a key that lacks /models access). It mirrors the
// well-known catalog VyceAI serves so the provider stays routable.
export const MODELS: string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-lr',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-5',
  'grok-4.5',
  'grok-4.6',
  'mimo-v2.5-pro-premium',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'nemotron-ultra-550b',
  'nemotron-vision',
];
