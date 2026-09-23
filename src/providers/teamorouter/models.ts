// TeamoRouter exposes an OpenAI-compatible /v1/models endpoint, but we only
// route the FREE models through this provider. This list is used as the
// authoritative model catalog so discovery never exposes paid models.
export const MODELS: string[] = [
  'deepseek-v4-flash-free',
  'deepseek-v4-pro-free',
  'glm-5.3-flash-free',
];
