// DeepBricks exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable
// (network error, WAF block, or a key that lacks /models access). It mirrors the
// well-known GPT/Claude/Gemini catalog DeepBricks serves so the provider stays
// routable.
export const MODELS: string[] = [
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-instruct',
  'claude-3.5-sonnet',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'o1',
  'o1-mini',
  'o3-mini',
  'o4-mini',
];
