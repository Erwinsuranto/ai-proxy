// OpenCode Inference API — free chat models.
//
// This is a SEPARATE channel from OpenCode Zen (src/providers/zen). Its base
// URL is https://opencode.ai/inference/openai/v1 and free models are invoked
// WITHOUT an Authorization header. The catalog below is intentionally minimal:
// only models documented for the Inference API. Zen models are never merged
// in here, and Inference models are never merged into the Zen catalog.
export const MODELS: string[] = [
  'big-pickle',
  'mimo-v2.5-free',
  'nemotron-3-super-free',
];
