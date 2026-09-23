/* ============================================================================
 * nvidia-api · Route protocol identifiers (generic multi-route foundation)
 * ----------------------------------------------------------------------------
 * Protocol ids are protocol-level, never provider-level: any provider may use
 * any protocol without a new adapter. Legacy single-endpoint providers keep
 * working through the 'openai'/'anthropic' aliases mapped below.
 * ========================================================================== */

/** Wire protocols a route can speak. */
export type RouteProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini';

/** Legacy protocol labels kept by ModelRegistry entries. */
export type LegacyModelProtocol = 'openai' | 'anthropic';

export const ROUTE_PROTOCOLS: RouteProtocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini',
];

export function isRouteProtocol(value: any): value is RouteProtocol {
  return typeof value === 'string' && (ROUTE_PROTOCOLS as string[]).includes(value);
}

/** Normalize legacy labels so old registry metadata keeps resolving. */
export function normalizeRouteProtocol(value: any): RouteProtocol | undefined {
  if (isRouteProtocol(value)) return value;
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'openai' || v === 'chat' || v === 'chat_completions') return 'openai-chat';
  if (v === 'anthropic' || v === 'messages') return 'anthropic-messages';
  if (v === 'responses' || v === 'openai_responses') return 'openai-responses';
  if (v === 'gemini' || v === 'google' || v === 'generativelanguage') return 'gemini';
  return undefined;
}

/** Map a route protocol back to the legacy ModelRegistry label. */
export function routeToLegacyProtocol(protocol: RouteProtocol): LegacyModelProtocol {
  return protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
}
