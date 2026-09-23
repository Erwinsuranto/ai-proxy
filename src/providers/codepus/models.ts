// Codepus (https://api.codepus.ai) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia. HANYA id yang terkonfirmasi merespons pada
// testing 2026-09-08 yang didaftarkan.
// Catatan: plan free hanya expose glm-5.2 (rute penuh); model lain ditolak
// dengan error model_not_available_on_plan.
export const MODELS: string[] = [
  'glm-5.2',
];
