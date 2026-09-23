// Inception Labs exposes an OpenAI-compatible model-discovery endpoint
// (GET /v1/models). This list is the manual fallback when the live endpoint
// is unavailable, mirroring the catalog served at last check
// (verified 2026-09-17: mercury-2 OK, mercury-2.5 OK with large max_tokens;
// legacy "mercury" v1 is access-denied for new accounts).
export const MODELS: string[] = [
  'mercury-2',
  'mercury-2.5',
];
