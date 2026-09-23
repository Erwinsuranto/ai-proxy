// Hive (thehive.ai V3) has no OpenAI-style model-discovery endpoint
// (GET /models is 404), so the catalog is static. Chat surface
// (POST /chat/completions) serves the VLM plus an LLM gateway: note that
// the LLM ids ONLY answer streaming requests (plain calls 500 upstream),
// which the provider handles via automatic stream fallback.
export const MODELS: string[] = [
  'hive/vision-language-model',
  'deepseek-ai/deepseek-v4.1-flash',
  'zai-org/glm-5.3-flash',
];
