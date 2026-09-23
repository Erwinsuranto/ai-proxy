// Apmix exposes an OpenAI-compatible model-discovery endpoint
// (GET /v1/models). This list is the manual fallback when the live endpoint
// is unavailable, mirroring the free catalog served at last check.
export const MODELS: string[] = [
  'claude-opus-4-7-free',
  'claude-opus-4-8-free',
  'claude-opus-5-free',
  'claude-sonnet-4-6-free',
  'gemini-3-flash-preview-free',
  'glm-5.2-free',
  'gpt-4.1-free',
];
