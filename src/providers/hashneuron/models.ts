// HashNeuron (hashneuron.space) — RouteOpen OpenAI-compatible gateway.
// Katalog dari GET /v1/models upstream (4 model per 2026-09-14;
// `glm-5.3-free` tanpa prefix sudah di-delist upstream: no_channel_available).
// Status per 2026-09-14:
// - composer-2.5, grok-4.5, grok-4.6: OK (daily budget reset 00:00 UTC)
// - z-ai/glm-5.3-free: OK (butuh max_tokens >= 500 karena reasoning tokens)
export const MODELS: string[] = [
  'composer-2.5',
  'grok-4.5',
  'grok-4.6',
  'z-ai/glm-5.3-free',
];
