// AgentRouter model catalog: static catalog, backend-model mapping, alias
// generation, protocol mapping, and capability metadata. This is the source of
// truth when discovery is blocked — the same catalog keeps the provider healthy
// and routable regardless of GET /v1/models.

import { Protocol, CatalogEntry } from './types';
import { generateModelAliases } from '../../lib/model-registry';
import { detectProtocolFromMetadata, endpointForProtocol, guessProtocolFromName, stripOrgPrefix } from './protocol';

/** Built-in default static catalog (used when config/env provides none). */
export const DEFAULT_STATIC_MODELS: CatalogEntry[] = [
  { id: 'anthropic/claude-opus-4.8', protocol: 'anthropic' },
  { id: 'anthropic/claude-opus-5', protocol: 'anthropic' },
  { id: 'anthropic/claude-sonnet-5', protocol: 'anthropic' },
  { id: 'openai/gpt-5.6-sol', protocol: 'openai' },
];

export interface CatalogModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  aliases: string[];
  protocol: Protocol;
  endpoint: string;
  backend?: string;
  capability?: string[];
  metadata?: any;
}

function resolveCatalogProtocol(entry: CatalogEntry): Protocol {
  if (entry.protocol) return entry.protocol;
  return guessProtocolFromName(entry.id);
}

/** Build enriched model entries from the static catalog. */
export function buildStaticModels(entries: CatalogEntry[], now: number = Date.now()): CatalogModel[] {
  return entries.map((entry) => {
    const protocol = resolveCatalogProtocol(entry);
    const aliases = generateModelAliases(entry.id);
    const capability = protocol === 'anthropic' ? ['anthropic_messages'] : ['openai_chat_completions'];
    return {
      id: entry.id,
      object: 'model',
      created: Math.floor(now / 1000),
      owned_by: 'agentrouter',
      aliases,
      protocol,
      endpoint: endpointForProtocol(protocol),
      backend: entry.id,
      capability,
      metadata: { static: true, protocol },
    };
  });
}

/**
 * Normalize discovered models from upstream metadata into canonical CatalogModel
 * entries (protocol + endpoint from metadata, never a hardcoded name).
 */
export function normalizeDiscoveredModels(list: any[], now: number = Date.now()): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const raw of list) {
    const id: string = typeof raw === 'string' ? raw : raw?.id;
    if (!id) continue;
    const protocol = detectProtocolFromMetadata(raw);
    const finalProtocol: Protocol = protocol ?? guessProtocolFromName(id);
    const aliases = generateModelAliases(id);
    out.push({
      id,
      object: 'model',
      created: typeof raw === 'string' ? Math.floor(now / 1000) : (raw?.created ?? Math.floor(now / 1000)),
      owned_by: (typeof raw === 'string' ? undefined : raw?.owned_by) ?? 'agentrouter',
      aliases,
      protocol: finalProtocol,
      endpoint: endpointForProtocol(finalProtocol),
      backend: id,
      capability: finalProtocol === 'anthropic' ? ['anthropic_messages'] : ['openai_chat_completions'],
      metadata: typeof raw === 'string' ? undefined : raw,
    });
  }
  return out;
}

/** Rebuild a protocol lookup map keyed by canonical id + aliases. */
export function buildProtocolMap(models: CatalogModel[]): Map<string, Protocol> {
  const map = new Map<string, Protocol>();
  for (const m of models) {
    if (!m?.id) continue;
    map.set(m.id, m.protocol);
    for (const a of Array.isArray(m.aliases) ? m.aliases : []) map.set(a, m.protocol);
  }
  return map;
}

export { stripOrgPrefix };