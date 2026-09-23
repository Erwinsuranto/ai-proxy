// UNLI exposes an OpenAI-compatible auto-routing model endpoint
// (GET /v1/models returns the single virtual model "unli-auto"). Any
// OpenAI/Anthropic/DeepSeek model name is accepted upstream and routed
// automatically. This list is a manual fallback when the live /models
// endpoint is unavailable, so the provider stays routable for the model
// names clients actually request.
export const MODELS: string[] = [
  'unli-auto',
  'deepseek-v4-flash',
  'deepseek-v4-flash-free',
  'deepseek-v4-pro',
  'deepseek-chat',
  'gpt-4o',
  'gpt-4.1',
  'claude-sonnet-4',
  'claude-opus-4',
  'gemini-3-flash',
  'glm-5.3',
  'glm-5.2',
  'llama-3.3-70b',
  'qwen3-coder',
  'mistral-small-3.1',
];