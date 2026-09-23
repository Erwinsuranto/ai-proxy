// Jiji (jiji.cc) exposes an OpenAI-compatible model-discovery endpoint
// (GET /v1/models). This list is the manual fallback when the live endpoint
// is unavailable, mirroring the catalog served at last check
// (verified 2026-09-19: 6 deepseek models, deepseek-v4-pro-0813 chat OK,
// 5k+ token contexts OK).
export const MODELS: string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'deepseek-v4.1-flash',
];
