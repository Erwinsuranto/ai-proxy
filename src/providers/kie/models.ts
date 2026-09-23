// Kie.ai static model catalog — fallback + route binding metadata.
//
// Live Codex ids are merged from GET /codex/v1/models at discovery time;
// Gemini/Claude ids have no upstream list endpoint, so they are registered
// from this curated list. `routeId`/`protocol`/`endpoint` flow into
// ModelRegistry entries (see loadFromProvider meta passthrough) purely as
// routing metadata — request-time resolution always uses the generic
// provider-routes resolver, never hardcoded branches.

export interface KieStaticModel {
  id: string;
  routeId: 'kie-gemini' | 'kie-claude' | 'kie-codex';
  protocol: 'gemini' | 'anthropic-messages' | 'openai-responses';
  endpoint: string;
}

const GEMINI_MODELS: string[] = [
  'gemini-3-8-flash',
  'gemini-3-7-flash',
  'gemini-3-6-flash',
  'gemini-3-5-flash',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

const CLAUDE_MODELS: string[] = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-fable-5',
];

const CODEX_MODELS: string[] = [
  'gpt-6-astra',
  'gpt-5-6-sol',
  'gpt-5-6-terra',
  'gpt-5-6-luna',
  'gpt-5-5',
  'gpt-5-4',
];

export const KIE_STATIC_MODELS: KieStaticModel[] = [
  ...GEMINI_MODELS.map((id): KieStaticModel => ({
    id,
    routeId: 'kie-gemini',
    protocol: 'gemini',
    endpoint: '/gemini/v1/models/{model}:streamGenerateContent',
  })),
  ...CLAUDE_MODELS.map((id): KieStaticModel => ({
    id,
    routeId: 'kie-claude',
    protocol: 'anthropic-messages',
    endpoint: '/claude/v1/messages',
  })),
  ...CODEX_MODELS.map((id): KieStaticModel => ({
    id,
    routeId: 'kie-codex',
    protocol: 'openai-responses',
    endpoint: '/codex/v1/responses',
  })),
];

export const KIE_CODEX_MODELS_ENDPOINT = '/codex/v1/models';
