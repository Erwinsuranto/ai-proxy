// Hugging Face Inference Providers exposes an OpenAI-compatible catalog at
// GET /v1/models (base URL: https://router.huggingface.co/v1). Discovery from
// the live /models endpoint takes precedence when available; these entries only
// serve as a static fallback.
//
// Free / $0 models (verified on router.huggingface.co/v1/models):
//   - prism-ml/Ternary-Bonsai-27B-gguf        ($0/$0 @ together)
//   - prism-ml/Ternary-Bonsai-27B-AWQ-4bit    ($0/$0 @ together)
//
// Other widely-available (paid) models are listed below the free tier so the
// catalog still resolves popular requests when discovery is unreachable.
export const MODELS: string[] = [
  'Qwen/Qwen3.8-27B',
  'prism-ml/Ternary-Bonsai-27B-gguf',
  'prism-ml/Ternary-Bonsai-27B-AWQ-4bit',
  'Qwen/Qwen3.8-2.4T-A95B',
  'Qwen/Qwen3.5-122B-A10B',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen2.5-72B-Instruct',
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'meta-llama/Llama-3.3-70B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.1',
  'google/gemma-2-27b-it',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'HuggingFaceH4/zephyr-7b-beta',
];