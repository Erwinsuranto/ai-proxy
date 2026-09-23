// LLM7 exposes an OpenAI-compatible model-discovery endpoint (GET /v1/models),
// returning the full catalog (39 entries) but only a subset of models are
// available on the free tier without balance. This list is a manual fallback
// when the live /models endpoint is unavailable, so the provider stays
// routable for the free models clients actually request.
export const MODELS: string[] = [
  'DeepSeek-V4-Flash-0731',
  'codestral-latest',
  'gemini-3.1-flash-lite',
  'gpt-oss:20b',
  'minimax-m2.7',
  'mistral-Nemo-Instruct-2407',
];
