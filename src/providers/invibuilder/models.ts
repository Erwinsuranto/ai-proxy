// Invibuilder exposes an OpenAI-compatible model-discovery endpoint
// (GET /api/v1/models). This list is the manual fallback when the live
// endpoint is unavailable, mirroring the catalog served at last check
// (verified 2026-09-17: 58 models, chat OK for kimi-k3, deepseek-v4.1-flash,
// glm-5.3-flash).
export const MODELS: string[] = [
  'a1/kimi-k3',
  'ar/deepseek-v4.1-flash',
  'z-ai/glm-5.3-flash',
  'deepseek-v4.1-flash',
  'a1/deepseek-v4-flash',
  'a1/deepseek-v4-pro',
  'a1/glm-5.3',
  'a1/glm-5.2',
  'ar1/Qwen3.8-27B',
  'hy4',
  'a1/hy3',
  'a1/mimo-v2.5-pro',
  'a1/minimax-m3',
  'ar1/hy3-free',
  'ar1/nemotron-3.5-lightning-free',
  'nvidia/nemotron-3.5-lightning:free',
  'cohere/north-mini-code:free',
  'liquid/lfm-2.5-2.6b:free',
  'nex-agi/nex-n2.5-pro:free',
  'auto:free',
];
