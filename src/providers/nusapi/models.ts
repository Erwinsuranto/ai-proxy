// NusAPI router (https://nusapi.xyz) — OpenAI-compatible router.
// Model diambil dinamis dari GET /v1/models. Daftar ini hanya fallback manual
// saat /models tidak tersedia. HANYA id yang terkonfirmasi merespons HTTP 200
// pada testing 2026-09-05 yang didaftarkan (18 model).
export const MODELS: string[] = [
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
  'deepseek-ai/deepseek-v4-pro-0813',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'hy3',
  'minimaxai/minimax-m3',
  'moonshotai/kimi-k3',
  'oc/big-pickle',
  'oc/ling-3.0-flash-fin',
  'oc/mimo-v2.5',
  'oc/muse-spark-1.2-contributor',
  'oc/muse-spark-1.3-contributor',
  'oc/nemotron-3.5-lightning',
  'oc/nemotron-3-ultra',
  'openai/gpt-oss-20b',
  'qwen3.8-flash',
];
