// Empero exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable.
export const MODELS: string[] = [
  'glm-5.3-flash',
  'qwen3.8-flash',
];
