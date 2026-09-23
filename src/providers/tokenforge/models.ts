// TokenForge (https://tokenforge.ai.studio) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia. HANYA id yang terkonfirmasi merespons pada
// testing 2026-09-14 yang didaftarkan.
export const MODELS: string[] = [
  'claude-opus-5',
];
