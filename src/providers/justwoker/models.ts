// JustWoker exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable
// (network error, WAF block, or a key that lacks /models access). It mirrors the
// well-known DeepSeek catalog JustWoker serves so the provider stays routable.
export const MODELS: string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-r1',
  'claude-opus-4-8',
  'claude-opus-4-8-thinking',
  'claude-opus-4-7',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
];
