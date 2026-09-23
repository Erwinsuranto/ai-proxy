// Atria (https://api.atria-asi.ai) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia. HANYA id yang terkonfirmasi merespons pada
// testing 2026-09-15 yang didaftarkan.
export const MODELS: string[] = [
  'Atria-Dawn-Preview',
];
