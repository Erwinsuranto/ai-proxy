/* ============================================================================
 * nvidia-api · Kie.ai route specification (DATA, not branching logic)
 * ----------------------------------------------------------------------------
 * Single provider, single base URL, three routes. Resolution stays generic:
 * provider-routes.resolveRoute() matches models to these entries — no
 * `if provider === 'kie'` / `if model === ...` branches anywhere in core.
 *
 * NOTE: the Codex path below is exactly the user-supplied
 * `/codex/v1/responses` (NOT the older documented `/api/v1/responses`).
 * If upstream docs differ, verify via health check — never silently rewrite.
 * ========================================================================== */

import { RouteConfig } from './provider-routes';

export const KIE_PROVIDER_ID = 'kie.ai';
export const KIE_BASE_URL = 'https://api.kie.ai';

export const KIE_ROUTES: RouteConfig[] = [
  {
    id: 'kie-gemini',
    providerId: KIE_PROVIDER_ID,
    name: 'Kie.ai Gemini',
    path: '/gemini/v1/models/{model}:streamGenerateContent',
    protocol: 'gemini',
    method: 'POST',
    streaming: true,
    enabled: true,
    modelPrefixes: ['gemini-'],
    priority: 10,
  },
  {
    id: 'kie-claude',
    providerId: KIE_PROVIDER_ID,
    name: 'Kie.ai Claude',
    path: '/claude/v1/messages',
    protocol: 'anthropic-messages',
    method: 'POST',
    streaming: true,
    enabled: true,
    modelPrefixes: ['claude-'],
    priority: 20,
  },
  {
    id: 'kie-codex',
    providerId: KIE_PROVIDER_ID,
    name: 'Kie.ai Codex',
    path: '/codex/v1/responses',
    protocol: 'openai-responses',
    method: 'POST',
    streaming: true,
    enabled: true,
    models: [
      'gpt-5-5',
      'gpt-5-4',
      'gpt-5-6-sol',
      'gpt-5-6-terra',
      'gpt-5-6-luna',
      'gpt-6-astra',
    ],
    modelPrefixes: ['gpt-', 'codex', 'o1-', 'o3-', 'o4-'],
    priority: 30,
  },
];
