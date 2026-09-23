// Groq exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// so models are normally registered dynamically at startup. This list is only
// used as a manual fallback when the live /models endpoint is unavailable.
export const MODELS: string[] = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
  'groq/compound',
  'groq/compound-mini',
  'whisper-large-v3-turbo',
];