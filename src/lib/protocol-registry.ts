/* ============================================================================
 * nvidia-api · Generic protocol registry (multi-route foundation)
 * ----------------------------------------------------------------------------
 * Maps a RouteProtocol id to the adapter module that implements it. Adapters
 * are protocol-level: any provider/route may reference them without new code.
 * This registry only stores metadata + lazy loader paths; request paths use
 * the adapter modules directly so bundling stays static and auditable.
 * ========================================================================== */

import { RouteProtocol, ROUTE_PROTOCOLS } from './route-protocol';

export interface ProtocolDefinition {
  id: RouteProtocol;
  /** Request/response shape family. */
  requestShape: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini';
  supportsStreaming: boolean;
  supportsTools: boolean;
  /** Static adapter module implementing build/parse helpers. */
  adapterModule: string;
}

const BUILT_INS: ProtocolDefinition[] = [
  {
    id: 'openai-chat',
    requestShape: 'openai-chat',
    supportsStreaming: true,
    supportsTools: true,
    adapterModule: '../lib/adapters/openai-chat',
  },
  {
    id: 'openai-responses',
    requestShape: 'openai-responses',
    supportsStreaming: true,
    supportsTools: true,
    adapterModule: '../lib/adapters/openai-responses',
  },
  {
    id: 'anthropic-messages',
    requestShape: 'anthropic-messages',
    supportsStreaming: true,
    supportsTools: true,
    adapterModule: '../lib/adapters/anthropic-messages',
  },
  {
    id: 'gemini',
    requestShape: 'gemini',
    supportsStreaming: true,
    supportsTools: true,
    adapterModule: '../lib/adapters/gemini',
  },
];

const definitions = new Map<RouteProtocol, ProtocolDefinition>(
  BUILT_INS.map((d): [RouteProtocol, ProtocolDefinition] => [d.id, d]),
);

export function getProtocolDefinition(protocol: RouteProtocol): ProtocolDefinition | undefined {
  return definitions.get(protocol);
}

export function listProtocols(): ProtocolDefinition[] {
  return ROUTE_PROTOCOLS.map((id) => definitions.get(id)!).filter(Boolean);
}

export function isSupportedProtocol(value: any): value is RouteProtocol {
  return definitions.has(value);
}
