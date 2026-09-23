// KiosAPI router (https://router.kiosapi.com) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia. HANYA id yang terkonfirmasi merespons HTTP 200
// pada testing 2026-09-03 yang didaftarkan (21 model).
export const MODELS: string[] = [
  'Qwen/Qwen3.8-27B',
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-v4-flash',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'grok-4.5',
  'grok-4.6',
  'grok-composer-2.5-fast',
  'hy3',
  'minimaxai/minimax-m3',
  'moonshotai/kimi-k3',
  'nvidia/nemotron-3-super-120b-a12b',
  'oc/big-pickle',
  'oc/mimo-v2.5',
  'oc/muse-spark-1.2-contributor',
  'oc/nemotron-3-ultra',
  'openai/gpt-oss-20b',
  'qwen3.8-flash',
];
