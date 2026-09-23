// FlatKey router (https://router.flatkey.ai) exposes an OpenAI-compatible
// /v1/models endpoint with ~96 models, but HANYA model yang terkonfirmasi
// berfungsi dengan key ini yang didaftarkan agar provider tidak memasukkan
// model berbayar/mahal ke dalam routing. deepseek-v4-flash terkonfirmasi GRATIS
// (tidak memotong credit); deepseek-v4-pro berbayar namun stabil dipakai.
export const MODELS: string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];
