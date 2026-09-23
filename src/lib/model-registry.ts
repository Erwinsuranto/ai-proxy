import { registry, RegisteredProvider } from '../providers/registry';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG_ROUTING === 'true';

/** Upstream wire protocol / endpoint a model expects. */
export type ModelProtocol =
  | 'openai'
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini';

export interface ModelMeta {
  /** Wire protocol the upstream model expects. */
  protocol?: ModelProtocol;
  /** Concrete upstream endpoint path (e.g. "/chat/completions" or "/messages"). */
  endpoint?: string;
  /** Route id within a multi-route provider (e.g. 'kie-gemini'). Optional. */
  routeId?: string;
  /** Raw metadata as returned by the upstream discovery endpoint. */
  metadata?: any;
}

export interface ModelRegistration {
  model: string;
  providerId: string;
  backendModel?: string;
  priority: number;
  enabled: boolean;
  /** Wire protocol the upstream expects for this model (default "openai"). */
  protocol?: ModelProtocol;
  /** Upstream endpoint path chosen for this model. */
  endpoint?: string;
  /** Route id within a multi-route provider (e.g. 'kie-gemini'). Optional. */
  routeId?: string;
  /** Raw upstream metadata returned by model discovery. */
  metadata?: any;
  /** True for ADMIN-DECLARED aliases: `backendModel` is INTERNAL routing
   *  information and its id must never appear in the client-facing catalog
   *  (/v1/models), even if the upstream advertises the same id. The backend
   *  model remains fully usable for routing. */
  isInternalAlias?: boolean;
}

const DEFAULT_PRIORITY = 100;

/**
 * Default routing priority per provider (lower number = tried first).
 * NVIDIA is always preferred, GoRouter is the secondary provider, and
 * OpenRouter (and any other provider) is only used as a last-resort fallback.
 */
const PROVIDER_PRIORITY: Record<string, number> = {
  nvidia: 50,
  inferx: 70,
  gorouter: 75,
  onehop: 80,
  orcarouter: 84,
  zen: 60,
  logfare: 72,
  agentrouter: 85,
  tokenharbor: 82,
  codecraftapi: 83,
  cline: 87,
  tabitoken: 88,
  bai: 68,
  unli: 65,
  llm7: 93,
  seekai: 90,
  hcnsec: 95,
  teamorouter: 96,
  bazaarlink: 97,
  vyceai: 86,
  tokenforge: 89,
  atria: 89,
  hive: 81,
  apmix: 79,
  invibuilder: 80,
  inception: 78,
  jiji: 77,
  tokenrouter: 87,
  huggingface: 98,
  gmi: 99,
  openrouter: 100,
};

/**
 * Per-model provider priority overrides applied ON TOP of PROVIDER_PRIORITY.
 * Looked up by the model's normalized backend id (org prefix stripped, dots
 * normalized to dashes). Lets a specific client-facing model steer traffic —
 * e.g. "claude-4.8" -> backend "claude-opus-4-8" prefers GoRouter (direct
 * upstream channel) and falls back to SeekAI, before any other provider's
 * default priority is considered. Providers not listed here keep their
 * PROVIDER_PRIORITY default.
 */
const MODEL_PROVIDER_PRIORITY: Record<string, Record<string, number>> = {
  'claude-opus-4-8': {
    gorouter: 10,
    seekai: 20,
  },
  /* Kie.ai Codex channel: these GPT/Codex ids are ALSO advertised by other
   * providers (codecraftapi, experientiallabs). Without an override the
   * strict provider-lock picks the lower default priority and the Kie route is
   * never reached. Pin Kie first so the bare model name resolves to the Codex
   * Responses route; explicit prefixes keep working unchanged. */
  'gpt-6-astra': { 'kie.ai': 10 },
  'gpt-5-6-sol': { 'kie.ai': 10 },
  'gpt-5-6-terra': { 'kie.ai': 10 },
  'gpt-5-6-luna': { 'kie.ai': 10 },
  'gpt-5-5': { 'kie.ai': 10 },
  'gpt-5-4': { 'kie.ai': 10 },
};

/** Normalize a model id for MODEL_PROVIDER_PRIORITY lookups (de-prefixed, dot->dash). */
function normalizeModelKey(id: string): string {
  return stripOrgPrefix(id).replace(/\./g, '-').toLowerCase();
}

/**
 * Returns the portion of a model id after the first "/" (the org/vendor prefix).
 * e.g. "deepseek-ai/deepseek-v4-flash" -> "deepseek-v4-flash".
 * If there is no "/", the id is returned unchanged.
 * Used for namespace-tolerant matching so that a client request for a canonical
 * prefixed id (e.g. "deepseek-ai/deepseek-v4-flash") resolves to a provider that
 * registered the same model under a different (or no) org prefix.
 */
function stripOrgPrefix(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(slash + 1) : model;
}

/** True when the model id carries an org/vendor namespace prefix (e.g. "anthropic/..."). */
export function hasOrgPrefix(model: string): boolean {
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1;
}

/**
 * Provider-agnostic alias generator. Given a canonical backend model id, returns
 * the additional client-facing ids that must resolve to the SAME provider entry.
 *
 * Rules (applied to EVERY provider — never hardcoded to a vendor):
 *   1. Strip the org/vendor prefix:            anthropic/claude-opus-4.8 -> claude-opus-4.8
 *   2. Normalize dots to dashes in the result: claude-opus-4.8          -> claude-opus-4-8
 *
 * Examples:
 *   anthropic/claude-opus-4.8 -> ["claude-opus-4.8", "claude-opus-4-8"]
 *   anthropic/claude-opus-5   -> ["claude-opus-5"]
 *   openai/gpt-5.6-sol        -> ["gpt-5.6-sol", "gpt-5-6-sol"]
 *   google/gemini-2.5-pro     -> ["gemini-2.5-pro", "gemini-2-5-pro"]
 *   deepseek/deepseek-v3      -> ["deepseek-v3"]
 *   z-ai/glm-5.2              -> ["glm-5.2", "glm-5-2"]
 *
 * The canonical id itself is never returned (only genuinely new aliases), and
 * duplicates are removed.
 */
export function generateModelAliases(id: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => { if (v && v !== id) out.add(v); };

  const deprefixed = stripOrgPrefix(id);
  add(deprefixed);                        // de-prefixed form
  add(deprefixed.replace(/\./g, '-'));    // dot -> dash normalized form

  // Case-insensitive aliases: lowercase forms so clients can request any casing
  // (e.g. "DeepSeek-V4-Pro", "deepseek-v4-pro" or "DEEPSEEK-V4-PRO" all resolve).
  const lower = deprefixed.toLowerCase();
  add(lower);                             // lowercase de-prefixed form
  add(lower.replace(/\./g, '-'));         // lowercase dot -> dash form

  return Array.from(out);
}

export class ModelRegistry {
  // NOTE: registry keys are normalized to LOWERCASE so lookups are
  // case-insensitive. The original canonical upstream id is preserved on each
  // ModelRegistration via `model` (for primary registrations) or `backendModel`
  // (for aliases), so the upstream is always called with the exact provider id.
  private entries: Map<string, ModelRegistration[]> = new Map();
  private aliases: Map<string, string> = new Map();

  /**
   * Exclusivity map: normalizeModelKey(canonical model) -> allowed provider ids.
   * When set, a model routes ONLY through the listed providers — candidates from
   * any other provider are dropped, so traffic never falls back outside the
   * pinned set. Used to keep all SeekAI-served models on SeekAI's own path
   * (stable gorouter -> seekai only for claude-opus-4-8) and every Empero-served
   * model on Empero's own path (never falling back to e.g. BAI when BAI
   * advertises the same model id).
   */
  private exclusive: Map<string, string[]> = new Map();

  /** Canonical model keys sensor SeekAI currently serves (re-derived on load). */
  private seekaiExclusiveModels: Set<string> = new Set();

  /** Canonical model keys Empero currently serves (re-derived on load). */
  private emperoExclusiveModels: Set<string> = new Set();

  /** Canonical model keys Bitdeer currently serves (re-derived on load). */
  private bitdeerExclusiveModels: Set<string> = new Set();

  /** Canonical model keys Xkiro currently serves (re-derived on load). One path via xkiro base URL, no fallback to bitdeer. */
  private xkiroExclusiveModels: Set<string> = new Set();

  setExclusive(model: string, providers: string[]): void {
    this.exclusive.set(normalizeModelKey(model), providers);
  }

  getExclusive(model: string): string[] | undefined {
    return this.exclusive.get(normalizeModelKey(model));
  }

  registerAlias(alias: string, target: string): void {
    this.aliases.set(alias.toLowerCase(), target);
  }

  removeAlias(alias: string): void {
    this.aliases.delete(alias.toLowerCase());
  }

  getAliases(): Array<{ alias: string; target: string }> {
    const result: Array<{ alias: string; target: string }> = [];
    for (const [alias, target] of this.aliases) {
      result.push({ alias, target });
    }
    result.sort((a, b) => a.alias.localeCompare(b.alias));
    return result;
  }

  resolveAlias(model: string): string {
    return this.aliases.get(model.toLowerCase()) ?? model;
  }

  /**
   * Insert or update a single registry entry (no alias generation). Internal.
   */
  private upsert(model: string, providerId: string, priority: number, enabled: boolean, backendModel: string | undefined, meta?: ModelMeta, isInternalAlias = false): void {
    const existing = this.entries.get(model.toLowerCase()) || [];
    const idx = existing.findIndex(e => e.providerId === providerId);
    if (idx >= 0) {
      existing[idx] = {
        model,
        providerId,
        backendModel: backendModel ?? existing[idx].backendModel,
        priority,
        enabled,
        protocol: meta?.protocol ?? existing[idx].protocol,
        endpoint: meta?.endpoint ?? existing[idx].endpoint,
        routeId: meta?.routeId ?? existing[idx].routeId,
        metadata: meta?.metadata ?? existing[idx].metadata,
        isInternalAlias: isInternalAlias || existing[idx].isInternalAlias || false,
      };
    } else {
      existing.push({
        model,
        providerId,
        backendModel: backendModel ?? undefined,
        priority,
        enabled,
        protocol: meta?.protocol,
        endpoint: meta?.endpoint,
        routeId: meta?.routeId,
        metadata: meta?.metadata,
        isInternalAlias,
      });
    }
    existing.sort((a, b) => a.priority - b.priority);
    this.entries.set(model.toLowerCase(), existing);
  }

  /**
   * Register a model for a provider. For a PRIMARY registration (i.e. the model
   * id is its own backend), provider-agnostic aliases are generated and
   * registered automatically, each pointing back to the SAME provider with the
   * original id preserved as backendModel. Registering an alias (backendModel
   * set and different from model) does NOT recurse, preventing alias explosions
   * and duplicates.
   */
  registerModel(model: string, providerId: string, priority: number = DEFAULT_PRIORITY, enabled: boolean = true, backendModel?: string | null, meta?: ModelMeta): void {
    this.upsert(model, providerId, priority, enabled, backendModel ?? undefined, meta);

    const isPrimary = !backendModel || backendModel === model;
    if (!isPrimary) {
      /* ADMIN-DECLARED alias: also register the BACKEND id itself as an
       * INTERNAL alias so explicit "prefix/backend-model" requests still
       * resolve. The backend id is routing information — it stays hidden
       * from /v1/models but remains usable. */
      this.upsert(backendModel!, providerId, priority, enabled, backendModel, meta, true);
      return;
    }

    for (const alias of generateModelAliases(model)) {
      // Alias resolves to the same provider; backend stays the canonical id.
      this.upsert(alias, providerId, priority, enabled, model, meta);
    }
  }

  /** Returns the wire protocol/endpoint metadata registered for a model+provider (if any). */
  getModelMeta(model: string, providerId: string): ModelMeta | undefined {
    const existing = this.entries.get(this.resolveAlias(model).toLowerCase());
    if (!existing) return undefined;
    const entry = existing.find(e => e.providerId === providerId);
    if (!entry) return undefined;
    return { protocol: entry.protocol, endpoint: entry.endpoint, routeId: entry.routeId, metadata: entry.metadata };
  }

  setBackendModel(model: string, providerId: string, backendModel: string | null): void {
    const existing = this.entries.get(model);
    if (!existing) return;
    const entry = existing.find(e => e.providerId === providerId);
    if (entry) entry.backendModel = backendModel ?? undefined;
  }

  getBackendModel(model: string, providerId: string): string | undefined {
    const existing = this.entries.get(this.resolveAlias(model).toLowerCase());
    if (!existing) return undefined;
    const entry = existing.find(e => e.providerId === providerId);
    return entry?.backendModel;
  }

  getPriority(model: string, providerId: string): number | undefined {
    const existing = this.entries.get(this.resolveAlias(model).toLowerCase());
    if (!existing) return undefined;
    const entry = existing.find(e => e.providerId === providerId);
    return entry?.priority;
  }

  getProvidersForModel(model: string): ModelRegistration[] {
    // Keys are stored lowercase, so normalize the request to match any casing.
    const key = this.resolveAlias(model).toLowerCase();
    // Exclusivity pin (looked up on the RESOLVED key so aliases like
    // "claude-4.8" -> "claude-opus-4-8" inherit the same pin).
    const pinned = this.exclusive.get(normalizeModelKey(key));

    // 1. Exact-key match takes precedence when it exists.
    const exact = this.entries.get(key);
    if (exact) {
      const enabled = exact.filter(e => e.enabled);
      if (enabled.length > 0) {
        const eligible = pinned ? enabled.filter(e => pinned.includes(e.providerId)) : enabled;
        if (eligible.length > 0) {
          if (DEBUG) {
            console.log(`[ModelRegistry][DEBUG] "${model}" matched EXACT key "${key}" -> ${eligible.map(e => e.providerId).join(', ')}`);
          }
          return eligible;
        }
        if (DEBUG && exact.length > 0) {
          console.log(`[ModelRegistry][DEBUG] "${model}" has exact key "${key}" but its candidates ${enabled.map(e => e.providerId).join(', ')} do NOT include pinned providers [${pinned?.join(', ')}] — falling back to namespace match`);
        }
      }
      if (DEBUG && exact.length > 0) {
        console.log(`[ModelRegistry][DEBUG] "${model}" has exact key "${key}" but all ${exact.length} registration(s) are DISABLED — falling back to namespace match`);
      }
    }

    // 2. Namespace-tolerant fallback. A client may request a model using a
    //    canonical org prefix (e.g. "deepseek-ai/deepseek-v4-flash") while a
    //    provider registered it under a different or absent prefix
    //    (e.g. NVIDIA's "deepseek-v4-flash"). Match on the base name (portion
    //    after the first "/") so the request still resolves to every provider
    //    that supports the model. Priority still decides the order, so NVIDIA
    //    (lower priority number) is preferred over OpenRouter.
    const base = stripOrgPrefix(key).toLowerCase();
    const collected = new Map<string, ModelRegistration>();
    for (const registrations of this.entries.values()) {
      for (const e of registrations) {
        if (!e.enabled) continue;
        if (pinned && !pinned.includes(e.providerId)) continue;
        if (e.model.toLowerCase() === key || stripOrgPrefix(e.model).toLowerCase() === base) {
          const prev = collected.get(e.providerId);
          if (!prev || e.priority < prev.priority) {
            collected.set(e.providerId, e);
          }
        }
      }
    }

    const result = Array.from(collected.values());
    result.sort((a, b) => a.priority - b.priority);
    if (DEBUG) {
      if (result.length > 0) {
        console.log(`[ModelRegistry][DEBUG] "${model}" matched via base-name "${base}" -> ${result.map(e => `${e.providerId}(backend=${e.backendModel ?? e.model})`).join(', ')}`);
      } else {
        console.log(`[ModelRegistry][DEBUG] "${model}" REJECTED: no exact key "${key}" and no registered model shares base-name "${base}"`);
      }
    }
    return result;
  }

  getModelsForProvider(providerId: string): ModelRegistration[] {
    const result: ModelRegistration[] = [];
    for (const registrations of this.entries.values()) {
      for (const r of registrations) {
        if (r.providerId === providerId) {
          result.push(r);
        }
      }
    }
    result.sort((a, b) => a.priority - b.priority);
    return result;
  }

  removeModel(model: string, providerId: string): void {
    const existing = this.entries.get(model.toLowerCase());
    if (!existing) return;
    const filtered = existing.filter(e => e.providerId !== providerId);
    if (filtered.length === 0) {
      this.entries.delete(model);
    } else {
      this.entries.set(model, filtered);
    }
  }

  setEnabled(model: string, providerId: string, enabled: boolean): void {
    const existing = this.entries.get(model.toLowerCase());
    if (!existing) return;
    const entry = existing.find(e => e.providerId === providerId);
    if (entry) entry.enabled = enabled;
  }

  /** Toggle the enabled flag on EVERY model registration for a provider. */
  setAllModelsEnabled(providerId: string, enabled: boolean): void {
    for (const registrations of this.entries.values()) {
      for (const e of registrations) {
        if (e.providerId === providerId) {
          e.enabled = enabled;
        }
      }
    }
  }

  setPriority(model: string, providerId: string, priority: number): void {
    const existing = this.entries.get(model.toLowerCase());
    if (!existing) return;
    const entry = existing.find(e => e.providerId === providerId);
    if (entry) {
      entry.priority = priority;
      existing.sort((a, b) => a.priority - b.priority);
    }
  }

  getAllEntries(): ModelRegistration[] {
    const result: ModelRegistration[] = [];
    for (const registrations of this.entries.values()) {
      result.push(...registrations);
    }
    return result;
  }

  /** Client-facing catalog entries only — internal backend aliases are
   *  excluded so /v1/models never advertises upstream/backend model ids. */
  getPublicEntries(): ModelRegistration[] {
    return this.getAllEntries().filter(e => !e.isInternalAlias);
  }

async loadFromProviders(): Promise<void> {
     // Load the catalog for EVERY registered provider — including disabled ones —
     // so the registry is never empty when a provider is disabled, and so an
     // enable() later has the models immediately available. Discovery failure
     // for one provider (returns 0 models) must not be interpreted as "no
     // provider exists": each provider is handled independently, and failures
     // fall back to last-known-good caches/static lists inside the provider.
     //
     // Providers are discovered IN PARALLEL: each load is independent (its own
     // upstream call, its own failure handling), and registerModel() is
     // idempotent, so concurrent registration is safe. A sequential loop made
     // total refresh time the SUM of every provider's latency — including dead
     // upstreams that wait out their full HTTP timeout — which stalled request
     // paths that trigger on-demand rediscovery.
      const providers = registry.getAllProviders();
      await Promise.allSettled(
        providers.map(p => this.loadFromProvider(p.identity.providerId)),
      );
      // Pastikan xkiro menang atas bitdeer untuk model overlap (deepseek) -> satu jalur base url xkiro
      for (const k of this.xkiroExclusiveModels) {
        this.exclusive.set(k, ['xkiro']);
      }
    }

   /**
    * Loads (or refreshes) the model catalog for a single provider. Safe to call
    * repeatedly — registerModel is idempotent and updates existing entries.
    *
    * Alias generation is provider-agnostic and handled inside registerModel():
    * every registered backend model automatically gets de-prefixed and
    * dot->dash normalized aliases pointing back to the same provider. Providers
    * do not need to (and should not) generate aliases themselves.
    *
    * Optional per-model enrichment fields consumed here:
    *   - `protocol`:  wire protocol the upstream expects (see ModelProtocol).
    *   - `endpoint`:  concrete upstream path chosen for this model.
    *   - `routeId`:   route id within a multi-route provider.
    *   - `metadata`:  raw upstream metadata (kept verbatim for diagnostics).
    */
   async loadFromProvider(providerId: string): Promise<number> {
     const p = registry.getProviderByIdAllowDisabled(providerId);
     if (!p) {
       console.warn(`[ModelRegistry] loadFromProvider("${providerId}"): provider not configured/enabled`);
       return 0;
     }
try {
      // SeekAI is a dedicated provider channel: every model it serves must route
      // exclusively through SeekAI (its own path), never falling back to other
      // providers. claude-opus-4-8 is the exception: it stays pinned to
      // GoRouter-first -> SeekAI-second (see MODEL_PROVIDER_PRIORITY). Discovery
      // below re-derives the pin set on every load so model churn is reflected.
      if (providerId === 'seekai') {
        this.seekaiExclusiveModels = new Set<string>();
      }
      if (providerId === 'empero') {
        this.emperoExclusiveModels = new Set<string>();
      }
      if (providerId === 'bitdeer') {
        this.bitdeerExclusiveModels = new Set<string>();
      }
      if (providerId === 'xkiro') {
        this.xkiroExclusiveModels = new Set<string>();
      }
      const models = await p.instance.listModels();
      const list = models?.data && Array.isArray(models.data) ? models.data : [];

      // Re-derive exclusivity pins FROM THE CURRENT catalog BEFORE the empty-list
      // short-circuit, so model churn (including "this provider now serves
      // nothing") immediately releases stale pins. Both failure paths inside a
      // provider (last-known-good cache / static fallback) never yield an empty
      // list, so a genuinely empty list means "serves nothing".
      if (providerId === 'seekai') {
        for (const m of list) {
          const id: string = typeof m === 'string' ? m : m.id;
          if (!id) continue;
          this.seekaiExclusiveModels.add(normalizeModelKey(id));
        }
        for (const modelKey of this.seekaiExclusiveModels) {
          // claude-opus-4-8 is the dedicated gorouter-first channel with seekai
          // as fallback (priority overrides). Other models route only through
          // SeekAI (own path, no external provider fallback).
          if (modelKey === 'claude-opus-4-8') {
            this.exclusive.set(modelKey, ['gorouter', 'seekai']);
            continue;
          }
          this.exclusive.set(modelKey, ['seekai']);
        }
        console.log(`[ModelRegistry] SeekAI exclusive models: ${Array.from(this.seekaiExclusiveModels).join(', ')}`);
      }
      if (providerId === 'empero') {
        // Release pins that are no longer served. A pin means the model routes
        // ONLY through Empero; when Empero drops the model from its catalog the
        // pin must go, otherwise the model stays jailed to a provider that can't
        // serve it (e.g. BAI advertises the same id and should take over).
        for (const [key, allowed] of this.exclusive) {
          if (allowed.length === 1 && allowed[0] === 'empero') {
            this.exclusive.delete(key);
          }
        }
        for (const m of list) {
          const id: string = typeof m === 'string' ? m : m.id;
          if (!id) continue;
          this.emperoExclusiveModels.add(normalizeModelKey(id));
        }
        for (const modelKey of this.emperoExclusiveModels) {
          this.exclusive.set(modelKey, ['empero']);
        }
        console.log(`[ModelRegistry] Empero exclusive models: ${Array.from(this.emperoExclusiveModels).join(', ')}`);
      }

      // Bitdeer: only the explicitly-curated FREE models are registered, and
      // they must route EXCLUSIVELY through Bitdeer. Without the pin, the
      // namespace-tolerant matcher would also resolve these model bases to
      // paid providers (e.g. OpenRouter's "deepseek/deepseek-v4-flash"),
      // charging the user instead of using the free Bitdeer channel.
      if (providerId === 'bitdeer') {
        for (const [key, allowed] of this.exclusive) {
          if (allowed.length === 1 && allowed[0] === 'bitdeer') {
            this.exclusive.delete(key);
          }
        }
        for (const m of list) {
          const id: string = typeof m === 'string' ? m : m.id;
          if (!id) continue;
          this.bitdeerExclusiveModels.add(normalizeModelKey(id));
        }
        for (const modelKey of this.bitdeerExclusiveModels) {
          // Jangan pin ke bitdeer jika xkiro sudah claim model yang sama (deepseek overlap) -> xkiro satu jalur
          if (this.xkiroExclusiveModels.has(modelKey)) continue;
          this.exclusive.set(modelKey, ['bitdeer']);
        }
        console.log(`[ModelRegistry] Bitdeer exclusive models: ${Array.from(this.bitdeerExclusiveModels).join(', ')}`);
      }

      // Xkiro: semua model xkiro harus satu jalur via xkiro base URL, jangan fallback ke bitdeer.
      // Pin exclusive agar deepseek dsb. dari xkiro tidak ditarik ke bitdeer (deepseek-ai/DeepSeek-V4-Flash overlap).
      if (providerId === 'xkiro') {
        for (const [key, allowed] of this.exclusive) {
          if (allowed.length === 1 && allowed[0] === 'xkiro') {
            this.exclusive.delete(key);
          }
        }
        for (const m of list) {
          const id: string = typeof m === 'string' ? m : m.id;
          if (!id) continue;
          this.xkiroExclusiveModels.add(normalizeModelKey(id));
        }
        for (const modelKey of this.xkiroExclusiveModels) {
          // Overwrite bitdeer pin jika overlap (xkiro menang untuk model yang sama)
          this.exclusive.set(modelKey, ['xkiro']);
        }
        console.log(`[ModelRegistry] Xkiro exclusive models: ${Array.from(this.xkiroExclusiveModels).join(', ')}`);
      }

      if (list.length === 0) {
        console.warn(`[ModelRegistry] Provider "${providerId}" returned 0 models from listModels() — NO models registered for this provider`);
        return 0;
      }
// A disabled provider keeps its models known to the registry (admin and
        // /v1/models still see them) but marked NOT routable, so request paths
        // (getProvidersForModel) never select it. An enable() flips the flag.
        const enabled = !registry.isDisabled(providerId);
        let registered = 0;
        let aliasCount = 0;
        let lastPriority = 0;
        for (const m of list) {
          const id: string = typeof m === 'string' ? m : m.id;
          if (!id) continue;
          // Base provider priority, then model-level override (if any). The
          // model override lets specific client models steer traffic (e.g.
          // claude-4.8 -> backend claude-opus-4-8 prefers GoRouter, then
          // SeekAI) before any generic provider priority.
          const modelOverride = MODEL_PROVIDER_PRIORITY[normalizeModelKey(id)]?.[providerId];
          const priority = modelOverride ?? PROVIDER_PRIORITY[providerId] ?? DEFAULT_PRIORITY;
          const meta: ModelMeta = {
           protocol: m?.protocol,
           endpoint: m?.endpoint,
           routeId: m?.routeId,
           metadata: m?.metadata,
          };
         // Register the canonical upstream id. registerModel() auto-generates
         // and registers the provider-agnostic aliases pointing back here.
this.registerModel(id, providerId, priority, enabled, undefined, meta);
          registered++;
          lastPriority = priority;
         const aliases = generateModelAliases(id);
         aliasCount += aliases.length;
         if (DEBUG) {
           console.log(`[ModelRegistry][DEBUG] discovered model="${id}" provider="${providerId}" protocol="${meta.protocol ?? 'openai'}" aliases=${JSON.stringify(aliases)}`);
         }
       }
       console.log(`[ModelRegistry] Loaded ${list.length} models from provider "${providerId}" (+${aliasCount} auto-aliases, priority=${lastPriority})`);
       return registered;
     } catch (e: any) {
       if (e?.type === 'provider_refresh_cooldown') throw e;
       console.warn(`[ModelRegistry] Failed to load models from ${providerId}: ${e.message}`);
       return 0;
     }
   }

  dumpByProvider(): Array<{ providerId: string; models: Array<{ client: string; backend?: string }> }> {
    const grouped: Record<string, Array<{ client: string; backend?: string }>> = {};
    for (const registrations of this.entries.values()) {
      for (const r of registrations) {
        if (!grouped[r.providerId]) grouped[r.providerId] = [];
        const existing = grouped[r.providerId].find(x => x.client === r.model);
        if (!existing) {
          grouped[r.providerId].push({ client: r.model, backend: r.backendModel });
        }
      }
    }
    return Object.entries(grouped)
      .map(([providerId, models]) => ({ providerId, models: models.sort((a, b) => a.client.localeCompare(b.client)) }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  printRegistry(): void {
    console.log('');
    console.log('===========================================');
    console.log('=== ModelRegistry Contents (Startup) ===');
    console.log('===========================================');
    const groups = this.dumpByProvider();
    if (groups.length === 0) {
      console.log('(empty) — no models registered');
    }
    for (const g of groups) {
      console.log(`Provider: ${g.providerId}`);
      console.log('Models:');
      for (const m of g.models) {
        if (m.backend && m.backend !== m.client) {
          console.log(`  - ${m.client}  (backend: ${m.backend})`);
        } else {
          console.log(`  - ${m.client}`);
        }
      }
    }
    console.log('===========================================');
    console.log('');
  }

  hasModel(model: string, providerId: string): boolean {
    const key = this.resolveAlias(model).toLowerCase();
    const entries = this.entries.get(key);
    if (!entries) return false;
    return entries.some(e => e.providerId === providerId && e.enabled);
  }

  getProviderCountForModel(model: string): number {
    const key = this.resolveAlias(model).toLowerCase();
    const entries = this.entries.get(key);
    if (!entries) return 0;
    return entries.filter(e => e.enabled).length;
  }

  clear(): void {
    this.entries.clear();
    this.aliases.clear();
    this.exclusive.clear();
    this.seekaiExclusiveModels.clear();
    this.emperoExclusiveModels.clear();
    this.bitdeerExclusiveModels.clear();
    this.xkiroExclusiveModels.clear();
  }
}

export const modelRegistry = new ModelRegistry();
