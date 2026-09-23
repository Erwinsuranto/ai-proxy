// Freebuff exposes an OpenAI-compatible endpoint via the local freebuff2api
// gateway (http://localhost:8787/v1). Models are discovered dynamically at
// startup via GET /v1/models; this list is the fallback when the live endpoint
// is unavailable.
export const MODELS: string[] = [
  'mimo/mimo-v2.5',
  'minimax/minimax-m3',
  'openai/gpt-5.6-luna',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'z-ai/glm-5.2',
  'crof/kimi-k3-eco',
  'anthropic/claude-fable-5',
  'meta/muse-spark-1.2-contributor',
];
