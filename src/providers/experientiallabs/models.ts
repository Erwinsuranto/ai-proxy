// ExperientialLabs (https://api.experientiallabs.ai) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models (±696 id, owned_by "exp"). Daftar ini
// hanya fallback manual saat /models tidak tersedia. HANYA id yang terkonfirmasi
// merespons HTTP 200 pada testing 2026-09-05 yang didaftarkan.
// Catatan: gpt-6-astra (rute upstream OpenAI Responses) mensyaratkan max_tokens >= 16.
export const MODELS: string[] = [
  'claude-fable-5.1',
  'gpt-6-astra',
];
