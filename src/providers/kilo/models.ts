// Kilo Gateway exposes an OpenAI-compatible model-discovery endpoint (GET /models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable.
export const MODELS: string[] = [
  'kilo-auto/free',
  'kilo-auto/balanced',
  'kilo-auto/efficient',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'stepfun/step-3.7-flash:free',
  'cohere/north-mini-code:free',
  'openrouter/free',
];