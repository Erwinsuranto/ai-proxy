// GMI (https://api.gmi-serving.com/v1) exposes an OpenAI-compatible
// model-discovery endpoint (GET /v1/models), so models are registered
// dynamically at startup. This list is only a manual fallback when the live
// /v1/models endpoint is unavailable; the upstream catalog includes free
// models (is_free: true) which show up in /v1/models automatically.
export const MODELS: string[] = [
  'MiniMaxAI/MiniMax-M3',
  'MiniMaxAI/MiniMax-M2.7',
];