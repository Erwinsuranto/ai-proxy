// Token Harbor exposes an OpenAI-compatible model-discovery endpoint
// (GET /v1/models), so models are normally registered dynamically at startup.
// This list is only used as a manual fallback when the live /models endpoint
// is unavailable. Client-facing ids resolve to these (plus auto-aliases).
export const MODELS: string[] = [
  'th-orchestra',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'kimi-k3',
  'kimi-k3:free',
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'mimo-v2.5:free',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash:free',
  'gemini-3.1-pro-preview',
  'gemini-3.6-flash',
  'qwen3.8-max',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'grok-4.5',
  'glm-5.2',
  'minimax-m3',
];