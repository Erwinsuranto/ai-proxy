import { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { modelRegistry, getAllKeyManagers, syncProviderApiKeys } from '../services/provider';
import { registry } from '../providers/registry';
import { config } from '../config';
import { loadProviderState } from '../lib/provider-state';
import {
  loadApiKeysForProvider,
  getApiKeyCount,
  toPublicRecord,
  addApiKey,
  deleteApiKey,
  setApiKeyStatus,
  findApiKey,
  ApiKeyValidationError,
  ApiKeyDuplicateError,
  computeKeyLabelSuggestion,
} from '../lib/api-key-store';
import {
  getUsageAggregates,
  getUsageByProvider,
  getUsageByModel,
  getAllUsage,
  queryUsage,
  getUsageRecordByIndex,
  UsageQuery,
} from '../lib/usage-store';
import { getPricingStatus, PRICING_REGISTRY } from '../lib/pricing';
import { providerCooldown, PROVIDER_COOLDOWN_MS } from '../lib/provider-cooldown';
import { providerRefreshCooldown, PROVIDER_REFRESH_COOLDOWN_MS } from '../lib/provider-refresh-cooldown';
import {
  createClientKey,
  listClientKeys,
  setClientKeyStatus,
  deleteClientKey,
  getClientKeyById,
  ClientKeyValidationError,
} from '../lib/client-key-store';
import {
  listCombos,
  createCombo,
  updateCombo,
  setComboStatus,
  deleteCombo,
  getComboById,
  ComboValidationError,
  PublicComboRecord,
  findActiveComboDuplicate,
  toPublicCombo,
} from '../lib/combo-store';
import { getRoute, routeMatchesModel } from '../lib/provider-routes';
import {
  loadPricingEntries,
  upsertPricing,
  setPricingEnabled,
  deletePricing,
  PricingValidationError,
} from '../lib/pricing-store';
import {
  createBackup,
  restoreBackup,
  listBackups,
  getBackupInfo,
  readBackupRaw,
  deleteBackup,
  applyRetention,
} from '../lib/backup';
import {
  collectFullBackupEntries,
  appendEntriesToArchive,
  createFullBackupArchive,
  FULL_BACKUP_FILENAME_RE,
} from '../lib/full-backup';

/* Resolve admin UI asset paths so they work whether the process is launched
 * from `dist/` (compiled) or `src/` (tsx dev). The HTML + CSS are plain files
 * shipped in `src/admin/`; the JS is emitted to `dist/admin/` by `tsc`. */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_SRC_DIR = path.join(PROJECT_ROOT, 'src', 'admin');
const ADMIN_DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'admin');

function readAdminFile(name: string): string | null {
  // 1. Prefer the compiled dist copy (production / after `npm run build`).
  const distPath = path.join(ADMIN_DIST_DIR, name);
  if (fs.existsSync(distPath)) {
    try { return fs.readFileSync(distPath, 'utf-8'); } catch { /* fall through */ }
  }
  // 2. Fall back to src for plain assets (html, css) — never for .js (browser can't run TS).
  if (!name.endsWith('.js')) {
    const srcPath = path.join(ADMIN_SRC_DIR, name);
    if (fs.existsSync(srcPath)) {
      try { return fs.readFileSync(srcPath, 'utf-8'); } catch { /* fall through */ }
    }
  }
  return null;
}

export function adminRoutes(app: FastifyInstance, _opts: any, done: () => void): void {

  /* ─── Admin JSON API authentication ───────────────────────────────────────
   * The static UI files (/admin, /admin/styles.css, /admin/dashboard.js) are
   * exempt from the global auth hook so the browser can load the dashboard.
   * The JSON API endpoints below are protected: every request must present the
   * configured API key via "Authorization: Bearer <key>" or "x-api-key: <key>".
   * ───────────────────────────────────────────────────────────────────────── */
  app.addHook('onRequest', async (request, reply) => {
    /* pathname only — the query string must NEVER influence the static-asset
     * exemption (e.g. "/admin/combos?x=." would otherwise skip auth). */
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'OPTIONS') return;
    const isStaticAsset = pathname === '/admin'
      || pathname === '/admin/styles.css'
      || pathname === '/admin/dashboard.js';
    if (pathname.startsWith('/admin') && !isStaticAsset) {
      const auth = request.headers.authorization || '';
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (request.headers['x-api-key'] as string) || '';
      if (config.apiKey && supplied !== config.apiKey) {
        /* Admin error contract: `error` is always a STRING so the dashboard
         * (and any API consumer) can render it directly. */
        return reply.code(401).send({ error: 'Invalid API key' });
      }
    }
  });

  /* ─── Prevent browser caching of JSON API responses so the dashboard
   * always shows live data. UI assets (HTML/CSS/JS) are unaffected. ─── */
  app.addHook('onSend', async (_request, reply, payload) => {
    const ct = reply.getHeader('content-type');
    if (ct && String(ct).includes('application/json')) {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }
    return payload;
  });

  /* ─── Admin UI routes (HTML/CSS/JS served from disk). Registered before the
   * JSON API routes for readability. Note: Fastify routes are exact-match for
   * non-wildcard paths, so /admin, /admin/styles.css, and /admin/dashboard.js
   * never collide with /admin/providers etc. ────────────────────────────── */
  app.get('/admin', async (_request, reply) => {
    const html = readAdminFile('index.html');
    if (!html) {
      return reply.status(503).type('text/plain').send('Admin UI index.html not found. Did you run `npm run build`?');
    }
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/admin/styles.css', async (_request, reply) => {
    const css = readAdminFile('styles.css');
    if (!css) {
      return reply.status(404).type('text/plain').send('styles.css not found');
    }
    return reply.type('text/css; charset=utf-8').send(css);
  });

  app.get('/admin/dashboard.js', async (_request, reply) => {
    const js = readAdminFile('dashboard.js');
    if (!js) {
      return reply.status(503).type('text/plain').send('dashboard.js not built. Run `npm run build` to compile the admin UI.');
    }
    return reply.type('application/javascript; charset=utf-8').send(js);
  });

  /* ─── JSON API routes (unchanged contract) ─────────────────────────── */

  app.get('/admin/models', async (_request, reply) => {
    const allEntries = modelRegistry.getAllEntries();
    const grouped: Record<string, any[]> = {};
    for (const entry of allEntries) {
      if (!grouped[entry.providerId]) grouped[entry.providerId] = [];
      grouped[entry.providerId].push(entry);
    }
    const providers = registry.getAllConfiguredProviders().map(p => ({
      id: p.identity.providerId,
      name: p.identity.providerName,
      models: grouped[p.identity.providerId] || [],
    }));
    return reply.send(providers);
  });

  app.post('/admin/models', async (request, reply) => {
    const { model, providerId, priority, enabled, backendModel } = request.body as any;
    if (!model || !providerId) {
      return reply.status(400).send({ error: 'model and providerId are required' });
    }
    modelRegistry.registerModel(model, providerId, priority ?? 100, enabled !== false, backendModel);
    return reply.send({ status: 'ok', model, providerId, backendModel });
  });

  app.delete('/admin/models/:providerId/:encodedModel', async (request, reply) => {
    const { providerId, encodedModel } = request.params as any;
    const model = decodeURIComponent(encodedModel);
    modelRegistry.removeModel(model, providerId);
    return reply.send({ status: 'ok', model, providerId });
  });

  app.patch('/admin/models/:providerId/:encodedModel', async (request, reply) => {
    const { providerId, encodedModel } = request.params as any;
    const model = decodeURIComponent(encodedModel);
    const { priority, enabled, backendModel } = request.body as any;
    if (priority !== undefined) {
      modelRegistry.setPriority(model, providerId, priority);
    }
    if (enabled !== undefined) {
      modelRegistry.setEnabled(model, providerId, enabled);
    }
    if (backendModel !== undefined) {
      modelRegistry.setBackendModel(model, providerId, backendModel);
    }
    return reply.send({ status: 'ok', model, providerId, priority, enabled, backendModel });
  });

  app.get('/admin/providers', async (_request, reply) => {
    const allEntries = modelRegistry.getAllEntries();
    const grouped: Record<string, any[]> = {};
    for (const entry of allEntries) {
      if (!grouped[entry.providerId]) grouped[entry.providerId] = [];
      grouped[entry.providerId].push(entry);
    }
    const allProviders = registry.getAllProviders();
    const disabledIds = registry.getDisabledProviders();
    const providers = allProviders.map(p => {
      const cd = providerCooldown.snapshot(p.identity.providerId);
      const remaining = providerCooldown.remainingMs(p.identity.providerId);
      const refreshRemaining = providerRefreshCooldown.remainingMs(p.identity.providerId);
      return {
        id: p.identity.providerId,
        name: p.identity.providerName,
        enabled: !disabledIds.includes(p.identity.providerId),
        models: grouped[p.identity.providerId] || [],
        apiKeyCount: getApiKeyCount(p.identity.providerId),
        /* Recovery cooldown status (per-provider, ~180s window). */
        cooldown: {
          active: remaining > 0,
          remainingMs: remaining,
          remainingSec: Math.ceil(remaining / 1000),
          cooldownUntil: cd.cooldownUntil,
          cooldownMs: PROVIDER_COOLDOWN_MS,
          lastFailureAt: cd.lastFailureAt,
          lastStatus: cd.lastStatus,
          lastError: cd.lastError,
          cooldownCount: cd.cooldownCount,
        },
        refreshCooldown: {
          active: providerRefreshCooldown.isCoolingDown(p.identity.providerId),
          remainingMs: refreshRemaining,
          remainingSeconds: Math.ceil(refreshRemaining / 1000),
          cooldownMs: PROVIDER_REFRESH_COOLDOWN_MS,
        },
      };
    });
    return reply.send(providers);
  });

  app.patch('/admin/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params as any;
    const { enabled } = request.body as any;

    if (enabled === undefined) {
      return reply.status(400).send({ error: 'enabled field is required (true/false)' });
    }

    const provider = registry.getAllProviders().find(p => p.identity.providerId === providerId);
    if (!provider) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }

    let refreshCooldown: any = null;
    if (enabled === true) {
      if (!registry.enableProvider(providerId)) {
        return reply.status(500).send({ error: 'Failed to enable provider' });
      }
      // The provider may have been disabled at startup, so its models were
      // registered as non-routable. Re-validate them against the provider's
      // current catalog and mark them routable again.
      try {
        await modelRegistry.loadFromProvider(providerId);
      } catch (error: any) {
        if (error?.providerRefreshCooldown) {
          refreshCooldown = error.providerRefreshCooldown;
        } else {
          throw error;
        }
      }
      modelRegistry.setAllModelsEnabled(providerId, true);
    } else {
      if (!registry.disableProvider(providerId)) {
        return reply.status(500).send({ error: 'Failed to disable provider' });
      }
      // Keep the models known to the registry (admin still shows them) but mark
      // them non-routable so request routing (getProvidersForModel) can never
      // select this provider while disabled.
      modelRegistry.setAllModelsEnabled(providerId, false);
    }

    return reply.send({
      status: 'ok',
      providerId,
      enabled: !registry.isDisabled(providerId),
      ...(refreshCooldown ? { refreshCooldown } : {}),
    });
  });

  /* ─── Provider API Key management (Admin UI) ─────────────────────────────
   * Keys added here are persisted in config/provider-api-keys.json and merged
   * into the provider's runtime KeyManager rotation. Responses NEVER contain
   * raw credentials — only masked metadata. Raw keys are also excluded from
   * backups (backup.ts has no api-keys dataset by design). ───────────────── */

  /** Resolves a provider or null when unknown (disabled providers included). */
  function findProvider(providerId: string) {
    return registry.getAllProviders().find(p => p.identity.providerId === providerId);
  }

  app.get('/admin/providers/:providerId/api-keys', async (request, reply) => {
    const { providerId } = request.params as any;
    if (!findProvider(providerId)) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }
    const records = loadApiKeysForProvider(providerId);
    const km = getAllKeyManagers()[providerId];
    return reply.send({
      providerId,
      keys: records.map(toPublicRecord),
      envKeyCount: km ? km.keyCount - countManagedActiveKeys(records, km) : 0,
      /* Sequential label suggestion for the Add form (no secret; UI helper). */
      suggestedLabel: computeKeyLabelSuggestion(providerId),
    });
  });

  app.post('/admin/providers/:providerId/api-keys', async (request, reply) => {
    const { providerId } = request.params as any;
    if (!findProvider(providerId)) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }
    if (!getAllKeyManagers()[providerId]) {
      return reply.status(400).send({
        error: `Provider "${providerId}" does not support managed API keys (it does not use a key rotation pool)`,
      });
    }
    const body = (request.body || {}) as any;
    /* Reject keys identical to an environment-configured key so the same raw
     * value never exists twice (as env seed AND managed record). */
    const trimmed = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (trimmed && getAllKeyManagers()[providerId]!.hasRawKey(trimmed)) {
      return reply.status(409).send({ error: 'This API key already exists as an environment-configured key for this provider' });
    }
    try {
      const { record } = addApiKey(providerId, body.apiKey, body.label);
      syncProviderApiKeys(providerId);
      return reply.status(201).send({ success: true, key: toPublicRecord(record) });
    } catch (err: any) {
      if (err instanceof ApiKeyValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      if (err instanceof ApiKeyDuplicateError) {
        return reply.status(409).send({ error: err.message });
      }
      return reply.status(500).send({ error: 'Failed to store API key' });
    }
  });

  app.delete('/admin/providers/:providerId/api-keys/:keyId', async (request, reply) => {
    const { providerId, keyId } = request.params as any;
    if (!findProvider(providerId)) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }
    // deleteApiKey verifies the key exists AND belongs to this provider.
    const deleted = deleteApiKey(providerId, keyId);
    if (!deleted) {
      return reply.status(404).send({ error: `API key "${keyId}" not found for provider "${providerId}"` });
    }
    syncProviderApiKeys(providerId);
    return reply.send({ status: 'ok', providerId, keyId });
  });

  app.patch('/admin/providers/:providerId/api-keys/:keyId', async (request, reply) => {
    const { providerId, keyId } = request.params as any;
    const { enabled } = request.body as any;
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled field is required (true/false)' });
    }
    if (!findProvider(providerId)) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }
    const updated = setApiKeyStatus(providerId, keyId, enabled);
    if (!updated) {
      return reply.status(404).send({ error: `API key "${keyId}" not found for provider "${providerId}"` });
    }
    syncProviderApiKeys(providerId);
    return reply.send({ status: 'ok', key: toPublicRecord(updated) });
  });

  /** Counts persisted active keys currently present in the runtime rotation,
   * so `envKeyCount` reflects only keys that came from environment config. */
  function countManagedActiveKeys(
    records: ReturnType<typeof loadApiKeysForProvider>,
    km: NonNullable<ReturnType<typeof getAllKeyManagers>[string]>,
  ): number {
    let count = 0;
    for (const rec of records) {
      if (rec.status !== 'active') continue;
      for (let i = 0; i < km.keyCount; i++) {
        if (km.getKey(i).key === rec.key) { count++; break; }
      }
    }
    return count;
  }

  /* ─── Client API Keys ("Create API Key" feature) ─────────────────────────
   * Per-client keys minted by the dashboard. Each key is bound to exactly one
   * provider + an allowlist of that provider's models:
   *     API Key → Provider → Allowed Models
   * Provider/model options are validated against the LIVE registries
   * (provider registry + model registry) — the same source of truth the
   * routing layer uses, so newly registered providers/models are instantly
   * available here without any frontend changes. ─────────────────────────── */

  app.get('/admin/client-keys', async (_request, reply) => {
    return reply.send({ keys: listClientKeys() });
  });

  /** Catalog for the Create API Key form: providers + their registered models,
   *  straight from the registry (no hardcoded lists). */
  app.get('/admin/client-keys/catalog', async (_request, reply) => {
    const allEntries = modelRegistry.getAllEntries();
    const grouped: Record<string, string[]> = {};
    for (const entry of allEntries) {
      if (entry.enabled === false) continue;
      (grouped[entry.providerId] ||= []).push(entry.model);
    }
    const disabledIds = new Set(registry.getDisabledProviders());
    const catalog = registry.getAllProviders()
      .filter(p => !disabledIds.has(p.identity.providerId))
      .map(p => ({
        id: p.identity.providerId,
        name: p.identity.providerName,
        models: (grouped[p.identity.providerId] || []).sort(),
      }));
    return reply.send({ providers: catalog });
  });

  app.post('/admin/client-keys', async (request, reply) => {
    const body = (request.body || {}) as any;
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (!providerId) {
      return reply.status(400).send({ error: 'providerId is required' });
    }
    const provider = registry.getAllProviders().find(p => p.identity.providerId === providerId);
    if (!provider) {
      return reply.status(404).send({ error: `Provider "${providerId}" not found` });
    }
    if (registry.getDisabledProviders().includes(providerId)) {
      return reply.status(400).send({ error: `Provider "${providerId}" is disabled` });
    }

    /* Allowed models must be registered for THIS provider in the model
     * registry — a key can never be minted for a foreign provider's model. */
    const registered = new Set(
      modelRegistry.getModelsForProvider(providerId)
        .filter(e => e.enabled !== false)
        .map(e => e.model),
    );
    const requested: string[] = Array.isArray(body.allowedModels) ? body.allowedModels : [];
    const invalid = requested.filter(m => !registered.has(String(m).trim()));
    if (requested.length === 0) {
      return reply.status(400).send({ error: 'allowedModels must contain at least one model' });
    }
    if (invalid.length > 0) {
      return reply.status(400).send({
        error: `Models not registered for provider "${providerId}": ${invalid.join(', ')}`,
      });
    }

    try {
      const { record, rawKey } = createClientKey({ providerId, allowedModels: requested, label: body.label });
      /* The raw key is returned EXACTLY ONCE here — only the SHA-256 hash is
       * persisted, mirroring the project's "never expose secrets" contract. */
      return reply.status(201).send({
        success: true,
        key: {
          id: record.id,
          maskedKey: record.maskedKey,
          providerId: record.providerId,
          allowedModels: record.allowedModels,
          label: record.label,
          status: record.status,
          createdAt: record.createdAt,
        },
        apiKey: rawKey,
      });
    } catch (err: any) {
      if (err instanceof ClientKeyValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: 'Failed to create API key' });
    }
  });

  app.patch('/admin/client-keys/:keyId', async (request, reply) => {
    const { keyId } = request.params as any;
    const { enabled } = request.body as any;
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled field is required (true/false)' });
    }
    const updated = setClientKeyStatus(keyId, enabled);
    if (!updated) {
      return reply.status(404).send({ error: `Client API key "${keyId}" not found` });
    }
    return reply.send({ status: 'ok', key: updated });
  });

  app.delete('/admin/client-keys/:keyId', async (request, reply) => {
    const { keyId } = request.params as any;
    const deleted = deleteClientKey(keyId);
    if (!deleted) {
      return reply.status(404).send({ error: `Client API key "${keyId}" not found` });
    }
    return reply.send({ status: 'ok', keyId });
  });

  /* ─── COMBOS (Client → Provider → Model → Provider API Key) ───────────────
   * Admin-defined routing pins: one client API key → one provider → one of
   * that provider's models → optionally one of that provider's API keys.
   *
   * Every create/edit is re-validated against the LIVE registries (client
   * key store, provider registry, model registry, provider API-key store):
   *  - the model MUST be registered for the selected provider,
   *  - the provider API key MUST belong to the selected provider,
   *  - every referenced entity must exist and be active,
   *  - cross-provider references are impossible (HTTP 400, nothing stored).
   *
   * Responses contain IDs + masked metadata ONLY — raw provider credentials
   * never leave the server. Routing enforcement lives in the request path:
   * client-key-guard.ts (authorization) + services/provider.ts (provider
   * lock) + lib/key-manager.ts (credential pin). ─────────────────────────── */

  /** Validates a (clientKeyId, providerId, model, providerKeyId) tuple against
   *  the live registries. Returns an error message or null when valid. */
  function validateComboEntities(input: {
    clientKeyId: string; providerId: string; model: string; routeId?: string | null; providerKeyId: string | null;
  }): string | null {
    const clientKey = getClientKeyById(input.clientKeyId);
    if (!clientKey) {
      return `Client API key "${input.clientKeyId}" not found`;
    }
    if (clientKey.status !== 'active') {
      return 'Client API key is disabled';
    }
    if (clientKey.providerId !== input.providerId) {
      return `Client API key belongs to provider "${clientKey.providerId}", not "${input.providerId}"`;
    }

    const provider = findProvider(input.providerId);
    if (!provider) {
      return `Provider "${input.providerId}" not found`;
    }
    if (registry.getDisabledProviders().includes(input.providerId)) {
      return `Provider "${input.providerId}" is disabled`;
    }

    /* The model MUST belong to THIS provider — models from other providers
     * are rejected (no cross-provider references). Internal backend aliases
     * are routing-only details and never combo-able. */
    const registered = new Set(
      modelRegistry.getModelsForProvider(input.providerId)
        .filter(e => e.enabled !== false && !e.isInternalAlias)
        .map(e => e.model),
    );
    if (!registered.has(input.model)) {
      return `Model "${input.model}" is not registered for provider "${input.providerId}"`;
    }

    /* Optional multi-route pin: the route must belong to THIS provider,
     * be enabled, and actually serve the combo model. A stale/disabled or
     * mismatched route fails fast here instead of misrouting at runtime. */
    if (input.routeId) {
      const route = getRoute(input.providerId, input.routeId);
      if (!route) {
        return `Route "${input.routeId}" is not registered for provider "${input.providerId}"`;
      }
      if (!route.enabled) {
        return `Route "${input.routeId}" is disabled`;
      }
      if (!routeMatchesModel(route, input.model)) {
        return `Route "${input.routeId}" does not serve model "${input.model}"`;
      }
    }

    if (input.providerKeyId) {
      /* The provider API key MUST belong to the SAME provider. */
      const keyRec = findApiKey(input.providerId, input.providerKeyId);
      if (!keyRec || keyRec.providerId !== input.providerId) {
        return `Provider API key "${input.providerKeyId}" not found for provider "${input.providerId}"`;
      }
      if (keyRec.status !== 'active') {
        return 'Provider API key is disabled';
      }
      const km = getAllKeyManagers()[input.providerId];
      if (!km) {
        return `Provider "${input.providerId}" does not support managed API keys (it does not use a key rotation pool)`;
      }
      if (!km.hasRawKey(keyRec.key)) {
        return 'Provider API key is not in the runtime rotation';
      }
    }
    return null;
  }

  /* GET /admin/combos — list combos with masked enrichment. The endpoint is
   * UNBREAKABLE: any enrichment failure (store/registry glitch, stale combo
   * referencing a deleted entity) degrades to `clientKey/providerKey: null`
   * or, if listing itself fails, a 500 with a STRING error message that the
   * dashboard can render (never an "[object Object]" error object). */
  app.get('/admin/combos', async (request, reply) => {
    let combos: PublicComboRecord[];
    try {
      combos = listCombos();
    } catch (err: any) {
      request.log.error({ err }, 'GET /admin/combos: failed to list combos');
      return reply.status(500).send({ error: `Failed to load combos: ${err?.message || 'internal error'}` });
    }
    const clientKeys = new Map(listClientKeys().map(k => [k.id, k]));
    const providerNames = new Map(
      registry.getAllProviders().map(p => [p.identity.providerId, p.identity.providerName]),
    );
    const keyCache = new Map<string, ReturnType<typeof findApiKey>>();
    const enriched = combos.map(c => {
      const ck = clientKeys.get(c.clientKeyId) || null;
      let providerKey: { id: string; maskedKey: string; label?: string; status: string } | null = null;
      if (c.providerKeyId) {
        try {
          const cacheKey = `${c.providerId}:${c.providerKeyId}`;
          if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, findApiKey(c.providerId, c.providerKeyId));
          const rec = keyCache.get(cacheKey);
          if (rec) providerKey = { id: rec.id, maskedKey: rec.maskedKey, label: rec.label, status: rec.status };
        } catch (err) {
          request.log.warn({ err, comboId: c.id }, 'GET /admin/combos: provider key enrichment failed');
        }
      }
      return {
        ...c,
        clientKey: ck ? { id: ck.id, maskedKey: ck.maskedKey, label: ck.label, status: ck.status } : null,
        providerName: providerNames.get(c.providerId) || c.providerId,
        providerKey,
      };
    });
    return reply.send({ combos: enriched });
  });

  /** Catalog for the Create/Edit Combo form: enabled providers with their own
   *  models + ACTIVE provider API keys (masked), and the client keys. All
   *  data is fetched live from the registries — nothing is hardcoded. The
   *  error contract is a STRING error message (never an error object). */
  app.get('/admin/combos/catalog', async (request, reply) => {
    try {
      const allEntries = modelRegistry.getAllEntries();
      const grouped: Record<string, string[]> = {};
      for (const entry of allEntries) {
        if (entry.enabled === false || entry.isInternalAlias) continue;
        (grouped[entry.providerId] ||= []).push(entry.model);
      }
      const disabledIds = new Set(registry.getDisabledProviders());
      const providers = registry.getAllProviders()
        .filter(p => !disabledIds.has(p.identity.providerId))
        .map(p => ({
          id: p.identity.providerId,
          name: p.identity.providerName,
          models: (grouped[p.identity.providerId] || []).sort(),
          apiKeys: loadApiKeysForProvider(p.identity.providerId)
            .filter(k => k.status === 'active')
            .map(k => ({ id: k.id, maskedKey: k.maskedKey, label: k.label })),
        }));
      return reply.send({
        providers,
        /* Only ACTIVE client keys are selectable in the Create/Edit form —
         * a disabled key could never pass backend validation anyway. */
        clientKeys: listClientKeys().filter(k => k.status === 'active'),
      });
    } catch (err: any) {
      request.log.error({ err }, 'GET /admin/combos/catalog: failed to build catalog');
      return reply.status(500).send({ error: `Failed to load combo catalog: ${err?.message || 'internal error'}` });
    }
  });

  app.post('/admin/combos', async (request, reply) => {
    const body = (request.body || {}) as any;
    const clientKeyId = typeof body.clientKeyId === 'string' ? body.clientKeyId.trim() : '';
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const providerKeyId = typeof body.providerKeyId === 'string' && body.providerKeyId.trim()
      ? body.providerKeyId.trim()
      : null;
    const routeId = typeof body.routeId === 'string' && body.routeId.trim()
      ? body.routeId.trim()
      : null;

    if (!clientKeyId || !providerId || !model) {
      return reply.status(400).send({ error: 'clientKeyId, providerId and model are required' });
    }

    const validationError = validateComboEntities({ clientKeyId, providerId, model, routeId, providerKeyId });
    if (validationError) {
      return reply.status(400).send({ error: validationError });
    }

    try {
      const record = createCombo({ clientKeyId, providerId, model, routeId, providerKeyId });
      /* Public (masked) shape only — same contract as GET /admin/combos. */
      return reply.status(201).send({ success: true, combo: toPublicCombo(record) });
    } catch (err: any) {
      if (err instanceof ComboValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: 'Failed to create combo' });
    }
  });

  app.patch('/admin/combos/:comboId', async (request, reply) => {
    const { comboId } = request.params as any;
    const body = (request.body || {}) as any;

    const existing = getComboById(comboId);
    if (!existing) {
      return reply.status(404).send({ error: `Combo "${comboId}" not found` });
    }

    /* Validate the status field before touching any entity fields. A PATCH may
     * contain both kinds of changes; rejecting an invalid status after an
     * entity update would otherwise leave a partial write behind. */
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled field must be a boolean' });
    }

    /* The FULL resulting tuple (body merged over the existing record) is what
     * gets validated — an edit can never introduce a cross-provider reference,
     * and the re-enable duplicate check below sees the POST-edit entities. */
    const merged = {
      clientKeyId: body.clientKeyId !== undefined ? String(body.clientKeyId).trim() : existing.clientKeyId,
      providerId: body.providerId !== undefined ? String(body.providerId).trim() : existing.providerId,
      model: body.model !== undefined ? String(body.model).trim() : existing.model,
      routeId: body.routeId !== undefined
        ? (typeof body.routeId === 'string' && body.routeId.trim() ? body.routeId.trim() : null)
        : (existing.routeId ?? null),
      providerKeyId: body.providerKeyId !== undefined
        ? (typeof body.providerKeyId === 'string' && body.providerKeyId.trim() ? body.providerKeyId.trim() : null)
        : existing.providerKeyId,
    };

    /* ATOMICITY PRE-CHECK: when this PATCH also re-enables the combo, reject
     * a duplicate-active collision BEFORE any write. Without this, an entity
     * edit combined with a colliding re-enable would persist the entity edit
     * and then fail — a misleading partial write. */
    if (body.enabled === true) {
      const duplicate = findActiveComboDuplicate(merged.clientKeyId, merged.model, comboId);
      if (duplicate) {
        return reply.status(400).send({
          error: `An active combo for this client API key and model already exists (${duplicate.id})`,
        });
      }
    }

    /* Entity edits re-validate the FULL resulting tuple against the live
     * registries — an edit can never introduce a cross-provider reference. */
    const hasEntityEdit = ['clientKeyId', 'providerId', 'model', 'routeId', 'providerKeyId']
      .some(field => body[field] !== undefined);
    if (hasEntityEdit) {
      if (!merged.clientKeyId || !merged.providerId || !merged.model) {
        return reply.status(400).send({ error: 'clientKeyId, providerId and model are required' });
      }
      const validationError = validateComboEntities(merged);
      if (validationError) {
        return reply.status(400).send({ error: validationError });
      }
      try {
        updateCombo(comboId, merged);
      } catch (err: any) {
        if (err instanceof ComboValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        return reply.status(500).send({ error: 'Failed to update combo' });
      }
    }

    if (body.enabled !== undefined) {
      try {
        const updated = setComboStatus(comboId, body.enabled);
        if (!updated) {
          return reply.status(404).send({ error: `Combo "${comboId}" not found` });
        }
      } catch (err: any) {
        if (err instanceof ComboValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        return reply.status(500).send({ error: 'Failed to update combo' });
      }
    }

    /* The combo may have been deleted concurrently mid-PATCH — never answer
     * `{ combo: null }`, that is a 404. Public (masked) shape only. */
    const fresh = getComboById(comboId);
    if (!fresh) {
      return reply.status(404).send({ error: `Combo "${comboId}" not found` });
    }
    return reply.send({ status: 'ok', combo: toPublicCombo(fresh) });
  });

  app.delete('/admin/combos/:comboId', async (request, reply) => {
    const { comboId } = request.params as any;
    const deleted = deleteCombo(comboId);
    if (!deleted) {
      return reply.status(404).send({ error: `Combo "${comboId}" not found` });
    }
    return reply.send({ status: 'ok', comboId });
  });

  app.get('/admin/aliases', async (_request, reply) => {
    return reply.send(modelRegistry.getAliases());
  });

  /* ─── Model Pricing management (Admin UI) ────────────────────────────────
   * Manages PRICE METADATA ONLY — no credentials are visible or editable here.
   * Effective pricing = stored entries (enabled overrides / disabled forces
   * unknown) layered on top of the built-in registry. Historical usage costs
   * are never modified by these endpoints. ─────────────────────────────── */

  app.get('/admin/pricing', async (_request, reply) => {
    const stored = loadPricingEntries();
    const storedKeys = new Set(stored.map(e => e.id));
    const builtin = Object.entries(PRICING_REGISTRY).map(([key, price]) => {
      const slash = key.indexOf('/');
      return {
        id: key,
        providerId: key.slice(0, slash),
        model: key.slice(slash + 1),
        inputPerM: (price as any).inputPerM ?? null,
        outputPerM: (price as any).outputPerM ?? null,
        currency: 'USD',
        enabled: true,
        source: 'builtin' as const,
        /* Built-in prices are public LIST-price estimates, not actual billing. */
        estimate: true,
        overridden: storedKeys.has(key),
      };
    });
    return reply.send({
      entries: stored,
      builtin,
      disclaimer:
        'Built-in entries are approximate public list-price ESTIMATES used for dashboard cost estimation only — they do not reflect actual provider billing. Stored admin entries override them.',
    });
  });

  app.post('/admin/pricing', async (request, reply) => {
    const { providerId, model, inputPerM, outputPerM, enabled } = (request.body || {}) as any;
    try {
      // Provider must be a registered provider (prevents fabricated contexts).
      if (!registry.getAllProviders().find(p => p.identity.providerId === String(providerId || '').toLowerCase())) {
        return reply.status(400).send({ error: `Unknown provider "${providerId}"` });
      }
      // Model must exist in the Model Registry — the UI never creates models.
      if (modelRegistry.getProvidersForModel(String(model || '')).length === 0) {
        return reply.status(400).send({ error: `Model "${model}" is not present in the model registry` });
      }
      const result = upsertPricing(String(providerId), String(model), Number(inputPerM), Number(outputPerM), enabled !== false);
      /* Duplicate handling is an explicit UPDATE — say so in the response. */
      return reply.status(result.created ? 201 : 200).send({
        status: 'ok', created: result.created, entry: result.entry,
      });
    } catch (err: any) {
      if (err instanceof PricingValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: 'Failed to store pricing entry' });
    }
  });

  app.patch('/admin/pricing/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = (request.body || {}) as any;
    try {
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          return reply.status(400).send({ error: 'enabled must be a boolean' });
        }
        const entry = setPricingEnabled(id, body.enabled);
        if (!entry) return reply.status(404).send({ error: `Pricing entry "${id}" not found` });
        return reply.send({ status: 'ok', entry });
      }
      if (body.inputPerM !== undefined || body.outputPerM !== undefined) {
        const existing = loadPricingEntries().find(e => e.id === id);
        if (!existing) return reply.status(404).send({ error: `Pricing entry "${id}" not found` });
        const result = upsertPricing(
          existing.providerId,
          existing.model,
          body.inputPerM !== undefined ? Number(body.inputPerM) : existing.inputPerM,
          body.outputPerM !== undefined ? Number(body.outputPerM) : existing.outputPerM,
          body.enabled !== undefined ? body.enabled !== false : existing.enabled,
        );
        return reply.send({ status: 'ok', created: false, entry: result.entry });
      }
      return reply.status(400).send({ error: 'Nothing to update: provide enabled and/or prices' });
    } catch (err: any) {
      if (err instanceof PricingValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: 'Failed to update pricing entry' });
    }
  });

  app.delete('/admin/pricing/:id', async (request, reply) => {
    const { id } = request.params as any;
    // Only removes the stored CONFIGURATION — historical usage costs untouched.
    if (!deletePricing(id)) {
      return reply.status(404).send({ error: `Pricing entry "${id}" not found` });
    }
    return reply.send({ status: 'ok', id, deleted: true });
  });


  app.post('/admin/aliases', async (request, reply) => {
    const { alias, target } = request.body as any;
    if (!alias || !target) {
      return reply.status(400).send({ error: 'alias and target are required' });
    }
    modelRegistry.registerAlias(alias, target);
    return reply.send({ status: 'ok', alias, target });
  });

  app.delete('/admin/aliases/:encodedAlias', async (request, reply) => {
    const { encodedAlias } = request.params as any;
    const alias = decodeURIComponent(encodedAlias);
    modelRegistry.removeAlias(alias);
    return reply.send({ status: 'ok', alias });
  });

  app.get('/admin/usage', async (request, reply) => {
    const { from, to, provider, model, status } = request.query as any;
    const q: UsageQuery = {};
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (provider) q.provider = provider;
    if (model) q.model = model;
    if (status) q.status = status;
    if (Object.keys(q).length === 0) {
      return reply.send(getUsageAggregates());
    }
    const filtered = getAllUsage().filter(r => {
      if (q.provider && r.provider !== q.provider) return false;
      if (q.model && r.model !== q.model) return false;
      if (q.status && r.status !== q.status) return false;
      if (q.from !== undefined && r.timestamp < q.from) return false;
      if (q.to !== undefined && r.timestamp > q.to) return false;
      return true;
    });
    const totalRequests = filtered.length;
    const totalSuccess = filtered.filter(r => r.status === 'success').length;
    const totalFailed = filtered.filter(r => r.status === 'error').length;
    const totalBlocked = filtered.filter(r => r.status === 'blocked').length;
    const totalPromptTokens = filtered.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
    const totalCompletionTokens = filtered.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
    const totalTokens = filtered.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
    const totalLatency = filtered.reduce((s, r) => s + r.latencyMs, 0);
    const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;
    const totalCostUsd = sumKnownCost(filtered, 'costUsd');
    return reply.send({
      totalRequests, totalSuccess, totalFailed, totalBlocked,
      totalPromptTokens, totalCompletionTokens, totalTokens, avgLatencyMs,
      totalCostUsd,
      totalInputCostUsd: sumKnownCost(filtered, 'inputCostUsd'),
      totalOutputCostUsd: sumKnownCost(filtered, 'outputCostUsd'),
    });
  });

  app.get('/admin/usage/providers', async (request, reply) => {
    const { from, to } = request.query as any;
    const q: UsageQuery = {};
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (Object.keys(q).length === 0) {
      return reply.send(getUsageByProvider());
    }
    const filtered = getAllUsage().filter(r => {
      if (q.from !== undefined && r.timestamp < q.from) return false;
      if (q.to !== undefined && r.timestamp > q.to) return false;
      return true;
    });
    const result: Record<string, any> = {};
    for (const r of filtered) {
      if (!result[r.provider]) result[r.provider] = { requests: 0, success: 0, failed: 0, blocked: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: 0, totalLatencyMs: 0, costUsd: null, inputCostUsd: null, outputCostUsd: null };
      const b = result[r.provider];
      b.requests++;
      if (r.status === 'success') b.success++;
      else if (r.status === 'error') b.failed++;
      else if (r.status === 'blocked') b.blocked++;
      b.promptTokens += r.promptTokens ?? 0;
      b.completionTokens += r.completionTokens ?? 0;
      b.totalTokens += r.totalTokens ?? 0;
      b.totalLatencyMs += r.latencyMs;
      accumulateCosts(b, r);
    }
    for (const id of Object.keys(result)) {
      result[id].avgLatencyMs = result[id].requests > 0 ? Math.round(result[id].totalLatencyMs / result[id].requests) : 0;
      delete result[id].totalLatencyMs;
    }
    return reply.send(result);
  });

  app.get('/admin/usage/models', async (request, reply) => {
    const { from, to } = request.query as any;
    const q: UsageQuery = {};
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (Object.keys(q).length === 0) {
      return reply.send(getUsageByModel());
    }
    const filtered = getAllUsage().filter(r => {
      if (q.from !== undefined && r.timestamp < q.from) return false;
      if (q.to !== undefined && r.timestamp > q.to) return false;
      return true;
    });
    const result: Record<string, any> = {};
    for (const r of filtered) {
      const key = `${r.provider}/${r.model}`;
      if (!result[key]) result[key] = { requests: 0, success: 0, failed: 0, blocked: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: 0, totalLatencyMs: 0, providers: [], provider: r.provider, model: r.model, costUsd: null, inputCostUsd: null, outputCostUsd: null, pricingStatus: 'unknown' };
      const b = result[key];
      b.requests++;
      if (r.status === 'success') b.success++;
      else if (r.status === 'error') b.failed++;
      else if (r.status === 'blocked') b.blocked++;
      b.promptTokens += r.promptTokens ?? 0;
      b.completionTokens += r.completionTokens ?? 0;
      b.totalTokens += r.totalTokens ?? 0;
      b.totalLatencyMs += r.latencyMs;
      accumulateCosts(b, r);
      if (!b.providers.includes(r.provider)) b.providers.push(r.provider);
    }
    for (const id of Object.keys(result)) {
      result[id].avgLatencyMs = result[id].requests > 0 ? Math.round(result[id].totalLatencyMs / result[id].requests) : 0;
      delete result[id].totalLatencyMs;
      /* Rows are keyed by exact `provider/model`, so pricing status always
         matches the pair that produced the row. */
      result[id].pricingStatus = getPricingStatus(result[id].provider, result[id].model);
    }
    return reply.send(result);
  });

  /** Sums known per-request cost values of any cost field into an
   * aggregation row (never treats unknown/null as $0). */
  function accumulateCosts(
    b: { costUsd: number | null; inputCostUsd: number | null; outputCostUsd: number | null },
    r: { costUsd?: number | null; inputCostUsd?: number | null; outputCostUsd?: number | null },
  ): void {
    for (const field of ['costUsd', 'inputCostUsd', 'outputCostUsd'] as const) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) {
        b[field] = (b[field] ?? 0) + v;
      }
    }
  }

  /** Sums one known cost field across records; null when none known. */
  function sumKnownCost(records: Array<{ costUsd?: number | null; inputCostUsd?: number | null; outputCostUsd?: number | null }>, field: 'costUsd' | 'inputCostUsd' | 'outputCostUsd'): number | null {
    let total: number | null = null;
    for (const r of records) {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) {
        total = (total ?? 0) + v;
      }
    }
    return total;
  }

  app.get('/admin/usage/records', async (request, reply) => {
    const { limit, offset, provider, model, status, from, to, search } = request.query as any;
    const q: UsageQuery = {};
    if (provider) q.provider = provider;
    if (model) q.model = model;
    if (status) q.status = status;
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (search) q.search = search;
    if (limit) q.limit = parseInt(limit);
    if (offset) q.offset = parseInt(offset);
    const result = queryUsage(q);
    return reply.send({ total: result.total, records: result.records });
  });

  app.get('/admin/usage/records/:index', async (request, reply) => {
    const { index } = request.params as any;
    const { provider, model, status, from, to, search } = request.query as any;
    const q: UsageQuery = {};
    if (provider) q.provider = provider;
    if (model) q.model = model;
    if (status) q.status = status;
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (search) q.search = search;
    const i = parseInt(index);
    if (isNaN(i) || i < 0) {
      return reply.status(400).send({ error: 'invalid record index' });
    }
    const rec = getUsageRecordByIndex(i, q);
    if (!rec) {
      return reply.status(404).send({ error: `Usage record at index ${i} not found` });
    }
    return reply.send(rec);
  });

  app.get('/admin/logs', async (request, reply) => {
    const { limit, offset, provider, model, status, from, to, search } = request.query as any;
    const q: UsageQuery = {};
    if (provider) q.provider = provider;
    if (model) q.model = model;
    if (status) q.status = status;
    if (from) q.from = parseInt(from);
    if (to) q.to = parseInt(to);
    if (search) q.search = search;
    if (limit) q.limit = parseInt(limit);
    if (offset) q.offset = parseInt(offset);
    const result = queryUsage(q);
    return reply.send({ total: result.total, logs: result.records });
  });

  // ─── Backup / Restore ─────────────────────────────────────────────────────

  app.post('/admin/backup', async (request, reply) => {
    try {
      const backup = createBackup();
      // Retention: if configured via BACKUP_MAX_BACKUPS, prune old ones.
      const maxBackups = parseInt(process.env.BACKUP_MAX_BACKUPS || '0', 10);
      if (maxBackups > 0) {
        try { applyRetention(maxBackups); } catch { /* retention must never fail the backup */ }
      }
      return reply.send({
        status: 'ok',
        backupId: backup.backupId,
        createdAt: backup.createdAt,
        sourceVersion: backup.sourceVersion,
        backupVersion: backup.backupVersion,
        checksum: backup.checksum,
        metadata: backup.metadata,
      });
    } catch (e: any) {
      return reply.status(500).send({ error: `Backup failed: ${e.message}` });
    }
  });

  app.get('/admin/backup/list', async (_request, reply) => {
    try {
      return reply.send(listBackups());
    } catch (e: any) {
      return reply.status(500).send({ error: `Failed to list backups: ${e.message}` });
    }
  });

  /* ─── Full project backup: on-demand ZIP download ────────────────────────
   * GET /admin/backup/download builds a fresh timestamped ZIP
   * (nvidia-api-backup-YYYY-MM-DD-HH-mm-ss.zip) from the allowlisted
   * state/config files (see src/lib/full-backup.ts) and streams it straight
   * to the response — no temporary ZIP file is written to the server and no
   * backup content is ever rendered in the browser. Auth comes from the same
   * admin onRequest hook above (Bearer / x-api-key); no separate mechanism.
   * Registered before the '/admin/backup/download/:backupId' route below so
   * the exact path always resolves to this handler. ───────────────────────── */
  app.get('/admin/backup/download', async (_request, reply) => {
    let collected;
    try {
      collected = collectFullBackupEntries();
    } catch {
      return reply.status(500).send({ error: 'Failed to prepare backup' });
    }
    if (!FULL_BACKUP_FILENAME_RE.test(collected.filename)) {
      return reply.status(500).send({ error: 'Failed to prepare backup' });
    }
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${collected.filename}"`)
      .header('Cache-Control', 'no-store');
    const archive = createFullBackupArchive();
    archive.on('error', () => {
      /* A mid-stream failure can no longer change the status code. Log a
       * generic message (never secrets or filesystem paths) and abort. */
      console.error('[admin] full backup ZIP stream failed');
      try { archive.destroy(); } catch { /* ignore */ }
    });
    reply.send(archive);
    try {
      appendEntriesToArchive(archive, collected.entries);
      await archive.finalize();
    } catch {
      /* Async archive failures surface through the 'error' handler above. */
    }
    return reply;
  });

  app.get('/admin/backup/download/:backupId', async (request, reply) => {
    const { backupId } = request.params as any;
    try {
      const { data, backup } = readBackupRaw(backupId);
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${backup.backupId}.json"`)
        .send(data);
    } catch (e: any) {
      return reply.status(404).send({ error: e.message });
    }
  });

  app.get('/admin/backup/info/:backupId', async (request, reply) => {
    const { backupId } = request.params as any;
    const info = getBackupInfo(backupId);
    if (!info) return reply.status(404).send({ error: `Backup not found: ${backupId}` });
    return reply.send(info);
  });

  app.post('/admin/backup/restore/:backupId', async (request, reply) => {
    const { backupId } = request.params as any;
    try {
      const result = restoreBackup(backupId);
      // The backup lib persists the restored provider state to disk, but the
      // running registry is what actually routes requests. Re-apply the restored
      // disabled set (merged with any env-seeded disabled providers, matching
      // startup) so the live state matches the restored snapshot immediately
      // instead of only after a restart.
      const restoredDisabled = loadProviderState();
      const merged = new Set<string>([...config.disabledProviders, ...restoredDisabled]);
      registry.setDisabled(Array.from(merged));
      /* Refresh catalogs for providers that are now enabled so their models
         are present and routable right away (mirrors the PATCH provider
         enable path). Providers are refreshed IN PARALLEL and the wait is
         BOUNDED: the previous sequential loop made restore latency the SUM
         of every enabled provider's discovery time — including dead upstreams
         that wait out their full HTTP timeout — stalling the request for
         tens of seconds. Model enable/disable flags below are applied to ALL
         providers regardless of whether their refresh finished in time. */
      const enabledProviders = registry
        .getAllProviders()
        .filter((p) => !merged.has(p.identity.providerId));
      await Promise.race([
        Promise.allSettled(
          enabledProviders.map((p) => modelRegistry.loadFromProvider(p.identity.providerId)),
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      for (const p of registry.getAllProviders()) {
        const enabled = !merged.has(p.identity.providerId);
        modelRegistry.setAllModelsEnabled(p.identity.providerId, enabled);
      }
      return reply.send({ status: 'ok', ...result });
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  app.delete('/admin/backup/:backupId', async (request, reply) => {
    const { backupId } = request.params as any;
    try {
      if (!deleteBackup(backupId)) {
        return reply.status(404).send({ error: `Backup not found: ${backupId}` });
      }
      return reply.send({ status: 'ok', backupId, deleted: true });
    } catch (e: any) {
      return reply.status(500).send({ error: `Failed to delete backup: ${e.message}` });
    }
  });

  done();
}
