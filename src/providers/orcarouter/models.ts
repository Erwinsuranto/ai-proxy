// OneHop exposes a live model-discovery endpoint (GET /v1/models), so models
// are registered dynamically at startup instead of being hardcoded here.
// This list is only used as a last-resort fallback when the live endpoint is
// unreachable AND no API key is configured; it is intentionally empty so we
// never invent models the account may not have access to.
export const MODELS: string[] = [];
