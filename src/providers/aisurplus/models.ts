// Aisurplus (https://aisurplus.io) — pool router OpenAI-compatible.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia (key revoked, saldo kosong, atau jaringan error).
// HANYA id berstatus "serving" di papan pasar (portal-api/markets) yang
// didaftarkan agar model waiting/no_source tidak masuk routing.
export const MODELS: string[] = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'grok-4.5',
  'grok-4.6',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k3',
  'kimi-k3-256k',
];
