// BazaarLink exposes an OpenAI-compatible catalog at GET /v1/models. Only
// free-tier-capable model IDs are listed here as a fallback catalog; discovery
// from the live /models endpoint takes precedence when available.
export const MODELS: string[] = [
  'auto',
  'auto:free',
  'deepseek/deepseek-v4-flash:free',
  'qwen/qwen3.7-flash:free',
];