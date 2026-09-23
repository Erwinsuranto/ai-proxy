/* ============================================================================
 * nvidia-api · Client key request guard
 * ----------------------------------------------------------------------------
 * Route-level enforcement for per-client API keys minted by the
 * "Create API Key" feature. The auth hook (server.ts) resolves the presented
 * credential and attaches the client-key record to `request.clientKey`; these
 * helpers turn that record into provider/model permission checks.
 *
 * COMBO integration (Client → Provider → Model → Provider API Key):
 *  - An ACTIVE combo for (client key, model) is an additional authorization
 *    source: it GRANTS access to its model even when the model is not in the
 *    key's own allowedModels (admin explicitly wired that pair).
 *  - When the request resolves to an active combo, `resolveComboRequestContext`
 *    builds the request-scoped routing pin: provider-locked routing + optional
 *    provider-API-key pinning (see lib/combo-context.ts). Cross-provider
 *    references are impossible: the provider key is validated against the
 *    combo's providerId on every request.
 * ========================================================================== */
import { FastifyRequest, FastifyReply } from 'fastify';
import { ClientApiKeyRecord, checkClientKeyModelAccess, recordClientKeyBlocked } from './client-key-store';
import { openAIError } from '../utils/openaiResponse';
import { findActiveComboForModel } from './combo-store';
import { findApiKey } from './api-key-store';
import { ComboRequestContext } from './combo-context';

/** Client-key identity threaded through the provider service for usage
 *  attribution (apiKey / apiKeyMasked columns in usage records). */
export interface ClientKeyContext {
  id: string;
  maskedKey: string;
}

export function getClientKey(request: FastifyRequest): ClientApiKeyRecord | undefined {
  return (request as any).clientKey as ClientApiKeyRecord | undefined;
}

export function getClientKeyContext(request: FastifyRequest): ClientKeyContext | null {
  const ck = getClientKey(request);
  return ck ? { id: ck.id, maskedKey: ck.maskedKey } : null;
}

/** Base model of a (possibly "prefix/model"-style) request. Prefixes are an
 *  OpenAI-compatibility detail and never inspected for permission purposes. */
function baseModelOf(requestedModel: string): string {
  const slash = requestedModel.indexOf('/');
  if (slash > 0) {
    const base = requestedModel.slice(slash + 1);
    if (base) return base;
  }
  return requestedModel;
}

/**
 * Enforces provider/model permissions for a client key on a `/v1/*` route.
 * Sends the error response and returns null when access is denied; returns
 * the model the request should ROUTE as when access is granted:
 *
 *  - plain allowed model   → unchanged
 *  - "prefix/model" form   → the base model id (prefixes are accepted as an
 *    OpenAI-style compatibility detail but carry no information — routing by
 *    the base id means every prefix behaves identically, so the key's
 *    provider binding can never be probed by prefix guessing)
 *
 * Authorization sources (neither may be bypassed, they never conflict):
 *  1. the key's allowedModels allowlist (original behavior), and
 *  2. an ACTIVE combo for (client key, model) — grants access to its model
 *     and pins routing to the combo's provider (+ provider API key).
 * A request for a model that has NO combo and is NOT allowlisted → 403, no
 * silent search for another provider.
 *
 * Denied requests are recorded as 'blocked' usage rows attributed to the key.
 */
export function enforceClientKeyModelAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedModel: string,
): string | null {
  const clientKey = getClientKey(request);
  if (!clientKey) return requestedModel;

  const base = baseModelOf(requestedModel);
  const activeCombo = findActiveComboForModel(clientKey.id, requestedModel)
    || findActiveComboForModel(clientKey.id, base);
  if (activeCombo && activeCombo.providerId !== clientKey.providerId) {
    const message = `Combo provider "${activeCombo.providerId}" does not match the client API key provider`;
    request.log.warn({
      requestId: request.id,
      comboId: activeCombo.id,
      clientKeyId: clientKey.id,
      clientProviderId: clientKey.providerId,
      comboProviderId: activeCombo.providerId,
    }, 'invalid combo provider ownership');
    recordClientKeyBlocked(clientKey, requestedModel, 403, message, request.id as string);
    reply.status(403).send(openAIError(403, message));
    return null;
  }
  const denial = checkClientKeyModelAccess(clientKey, requestedModel);
  if (!denial) {
    /* "prefix/model" form: route as the base id so the gateway (not the
     * client) owns the provider knowledge. */
    if (base !== requestedModel && clientKey.allowedModels.includes(base)) {
      return base;
    }
    /* COMBO: when an active combo pins the base model, route as the base so
     * the combo always wins over any prefix spelling (an allowlisted literal
     * like "provX/model" can never bypass the combo's provider pin). */
    if (base !== requestedModel && activeCombo) {
      return base;
    }
    return requestedModel;
  }

  /* COMBO authorization source: an active combo for this client key + model
   * grants access even outside allowedModels. Routing then follows the combo
   * (see resolveComboRequestContext). The exact request string is matched
   * first so slashed registry ids (e.g. "org/model-x") work, then the
   * stripped base for prefixed spellings. */
  const combo = activeCombo;
  if (combo) {
    return combo.model;
  }

  request.log.warn({
    requestId: request.id,
    clientKeyId: clientKey.id,
    provider: clientKey.providerId,
    model: requestedModel,
    status: denial.status,
  }, 'client key model access denied');

  recordClientKeyBlocked(clientKey, requestedModel, denial.status, denial.message, request.id as string);
  reply.status(denial.status).send(openAIError(denial.status, denial.message));
  return null;
}

/**
 * Resolves the active combo for a client key + effective model into the
 * request-scoped routing context. Returns null when no combo applies (the
 * request then follows the normal provider-locked routing policy).
 *
 * The provider API key is re-validated on EVERY request (ownership + active
 * status) against the combo's provider. A missing/disabled pinned credential
 * degrades to the provider's own multi-key rotation — it NEVER widens to
 * another provider's credential.
 */
export function resolveComboRequestContext(
  request: FastifyRequest,
  effectiveModel: string,
): ComboRequestContext | null {
  const clientKey = getClientKey(request);
  if (!clientKey || !effectiveModel) return null;

  const combo = findActiveComboForModel(clientKey.id, effectiveModel);
  if (!combo) return null;

  /* Re-check the client-key/provider ownership at request time as a defense
   * against stale or manually edited combo data. A combo cannot widen a
   * client key into another provider, even if its stored tuple is invalid. */
  if (combo.providerId !== clientKey.providerId) {
    request.log.warn({
      requestId: request.id,
      comboId: combo.id,
      clientKeyId: clientKey.id,
      clientProviderId: clientKey.providerId,
      comboProviderId: combo.providerId,
    }, 'combo provider does not match client key provider — refusing combo');
    return null;
  }

  let providerRawKey: string | null = null;
  if (combo.providerKeyId) {
    /* Ownership check against the combo's provider prevents any
     * cross-provider credential reference, even if store data were edited. */
    const keyRec = findApiKey(combo.providerId, combo.providerKeyId);
    if (keyRec && keyRec.providerId === combo.providerId && keyRec.status === 'active') {
      providerRawKey = keyRec.key; // runtime use only — never logged/exposed
    } else {
      request.log.warn({
        requestId: request.id,
        comboId: combo.id,
        providerId: combo.providerId,
        providerKeyId: combo.providerKeyId,
      }, 'combo provider API key unavailable — using provider multi-key rotation');
    }
  }

  return {
    comboId: combo.id,
    providerId: combo.providerId,
    model: combo.model,
    routeId: combo.routeId ?? null,
    providerKeyId: providerRawKey ? combo.providerKeyId : null,
    providerRawKey,
  };
}
