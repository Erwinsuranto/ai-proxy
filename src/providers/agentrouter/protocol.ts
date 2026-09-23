// AgentRouter protocol selection + endpoint mapping.
//
// A model's wire protocol is decided from its metadata (never hardcoded to a
// name). When no metadata is available (e.g. static catalog or blocked
// discovery), a safe name-based fallback is applied: `claude-*` models go to the
// Anthropic Messages endpoint, everything else to OpenAI Chat Completions.

import { Protocol, OPENAI_CHAT_ENDPOINT, ANTHROPIC_MESSAGES_ENDPOINT } from './types';

/** Strip the org/vendor prefix: "anthropic/claude-opus-4-8" -> "claude-opus-4-8". */
export function stripOrgPrefix(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(slash + 1) : model;
}

/**
 * Determine the protocol for a discovered model from upstream metadata. Returns
 * undefined when metadata carries no protocol hint (caller applies its fallback).
 */
export function detectProtocolFromMetadata(raw: any): Protocol | undefined {
  if (!raw || typeof raw === 'string') return undefined;

  const explicit = String(raw.protocol ?? raw.api ?? raw.wire ?? '').toLowerCase();
  if (explicit === 'anthropic' || explicit === 'messages') return 'anthropic';
  if (explicit === 'openai' || explicit === 'chat_completions' || explicit === 'chat') return 'openai';

  const hints: string[] = [];
  const push = (v: any) => {
    if (typeof v === 'string') hints.push(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach(push);
  };
  push(raw.endpoints);
  push(raw.supported_endpoints);
  push(raw.endpoint);
  push(raw.supported_apis);
  push(raw.type);
  push(raw.mode);

  const supportsAnthropic = hints.some((h) => h.includes('message') || h.includes('anthropic'));
  const supportsOpenAI = hints.some((h) => h.includes('chat/completions') || h.includes('completions') || h.includes('openai'));
  if (supportsAnthropic && !supportsOpenAI) return 'anthropic';
  if (supportsOpenAI && !supportsAnthropic) return 'openai';
  return undefined;
}

/** Name-based fallback: claude-* -> anthropic, otherwise openai. */
export function guessProtocolFromName(model: string): Protocol {
  return stripOrgPrefix(model || '').toLowerCase().startsWith('claude') ? 'anthropic' : 'openai';
}

/**
 * Resolve a model's protocol using an explicit per-model map first, then the
 * name-based fallback. Accepts canonical ids and de-prefixed aliases.
 */
export function resolveProtocol(model: string, map: Map<string, Protocol>): Protocol {
  if (!model) return 'openai';
  const fromMap = map.get(model) ?? map.get(stripOrgPrefix(model));
  if (fromMap) return fromMap;
  return guessProtocolFromName(model);
}

/** Endpoint path for a given protocol. */
export function endpointForProtocol(protocol: Protocol): string {
  return protocol === 'anthropic' ? ANTHROPIC_MESSAGES_ENDPOINT : OPENAI_CHAT_ENDPOINT;
}