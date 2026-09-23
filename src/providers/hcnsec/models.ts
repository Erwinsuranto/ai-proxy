// HCNSec exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable
// (network error, WAF block, or a key that lacks /models access). It mirrors a
// common Chinese open-model catalog HCNSec may serve so the provider stays
// routable.
export const MODELS: string[] = [
  'qwen2.5-72b-instruct',
  'qwen2.5-32b-instruct',
  'deepseek-chat',
  'deepseek-r1',
  'glm-4-flash',
  'DeepSeek-V4-Flash',
  'DeepSeek-V4-Pro',
  'glm-5.2',
  'Kimi-K2.6',
  'MiniMax-M3',
  'Qwen3.6-27B',
  'kat-coder-pro-v2.5',
  'step-3.5-flash',
  'step-3.5-flash-2603',
  'step-3.7-flash',
  'step-explore',
];