// KKToken exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable.
export const MODELS: string[] = [
  'claude-opus-5-thinking',
  'claude-opus-4-8',
  'claude-opus-4-8-thinking',
  'claude-opus-5',
];
