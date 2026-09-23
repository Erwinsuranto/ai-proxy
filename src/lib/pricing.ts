/**
 * Token cost estimation (USD).
 *
 * Prices are keyed by `provider` + exact model id and expressed per 1M tokens.
 * Effective pricing = admin-managed store (config/model-pricing.json) layered
 * on top of the built-in registry below. The dashboard only sums per-request
 * costs stored on each UsageRecord — it never fabricates a price: if a model's
 * input/output price is unknown the record's cost stays `null` (rendered as N/A).
 * A pricing miss for an EQUIVALENT model-id form (org prefix / dot-dash alias,
 * as usage records store the client-requested id) resolves through the
 * unambiguous alias fallback documented on `getModelPrice`.
 *
 * Pricing references are **approximate public list prices** used solely for
 * cost *estimation* in the admin dashboard; they do not reflect B2B/reseller
 * rates and never affect request routing.
 */

import { findPricingEntry, loadPricingEntries } from './pricing-store';

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerM?: number;
  /** USD per 1M output (completion) tokens. */
  outputPerM?: number;
}

export type PriceKey = `${string}/${string}`;

/**
 * Exact provider/model prices. Do not add a provider-wide default here: two
 * models behind the same provider can have different prices, and an unknown
 * model must remain unknown rather than being assigned a guessed price.
 */
export const PRICING_REGISTRY: Record<PriceKey, ModelPrice> = {
  // ── NVIDIA NIM / nvidia.com ──────────────────────────────────────────────
  'nvidia/z-ai/glm-5.2':               { inputPerM: 0.1,  outputPerM: 0.4 },
  'nvidia/nemotron-ultra-550b':        { inputPerM: 0.25, outputPerM: 0.6 },
  'nvidia/nemotron-vision':            { inputPerM: 0.1,  outputPerM: 0.3 },

  // ── OpenRouter ───────────────────────────────────────────────────────────
  'openrouter/anthropic/claude-sonnet-4-6':   { inputPerM: 3,  outputPerM: 15 },
  'openrouter/anthropic/claude-opus-5':       { inputPerM: 5,  outputPerM: 25 },
  'openrouter/anthropic/claude-haiku-4-5':    { inputPerM: 1,  outputPerM: 5 },
  'openrouter/anthropic/claude-fable-5':      { inputPerM: 2,  outputPerM: 10 },
  'openrouter/openai/gpt-5.6-luna':           { inputPerM: 1.25, outputPerM: 10 },
  'openrouter/deepseek/deepseek-v4-flash':    { inputPerM: 0.268, outputPerM: 0.4 },
  'openrouter/deepseek/deepseek-v4-pro':      { inputPerM: 2.19, outputPerM: 0.0 },
  'openrouter/google/gemini-3.6-flash':       { inputPerM: 0.1, outputPerM: 0.4 },
  'openrouter/google/gemini-3.1-flash-lite':  { inputPerM: 0.1, outputPerM: 0.4 },
  'openrouter/grok-4.6':                      { inputPerM: 3, outputPerM: 15 },
  'openrouter/grok-4.5':                      { inputPerM: 3, outputPerM: 15 },
  'openrouter/moondream/moondream-2.5':       { inputPerM: 0.25, outputPerM: 0.25 },

  // ── TokenHarbor (all routed via free-tier; treat most as $0 / unknown) ───
  'tokenharbor/deepseek-v4-flash:free':       { inputPerM: 0, outputPerM: 0 },
  'tokenharbor/deepseek/deepseek-v4-pro-0813-free': { inputPerM: 0, outputPerM: 0 },
  'tokenharbor/grok-4.6':                     { inputPerM: 3, outputPerM: 15 },

  // ── Freebuff (codebuff free-tier via localhost:8787) ─────────────────────
  'freebuff/openai/gpt-5.6-luna':             { inputPerM: 0, outputPerM: 0 },
  'freebuff/deepseek-v4-flash:free':          { inputPerM: 0, outputPerM: 0 },
  'freebuff/deepseek/deepseek-v4-pro-0813-free': { inputPerM: 0, outputPerM: 0 },
  'freebuff/crof/kimi-k3-eco':                { inputPerM: 0.2, outputPerM: 0.8 },
  'freebuff/qwen/qwen3.8-max-free':           { inputPerM: 0,  outputPerM: 0 },
  'freebuff/mimo-v2.5-pro-premium':           { inputPerM: 1,  outputPerM: 3 },

  // ── GMI (api.gmi-serving.com/v1; free tier models) ────────────────────────
  'gmi/MiniMaxAI/MiniMax-M3':                 { inputPerM: 0, outputPerM: 0 },
  'gmi/MiniMaxAI/MiniMax-M2.7':               { inputPerM: 0, outputPerM: 0 },

  // ── GoRouter ─────────────────────────────────────────────────────────────
  /* Exact provider/model only — GoRouter fronts many different models with
     different prices, so no provider-wide default is registered here.
     Claude Opus 4.8 public list price: $5 / 1M input, $25 / 1M output. */
  'gorouter/claude-opus-4-8':       { inputPerM: 5, outputPerM: 25 },

  // ── GLM ──────────────────────────────────────────────────────────────────
  'glm/z-ai/glm-5.2':               { inputPerM: 0.1,  outputPerM: 0.4 },
  'glm/glm-5.2':                    { inputPerM: 0.1,  outputPerM: 0.4 },

  // ── BAI ──────────────────────────────────────────────────────────────────
  'bai/deepseek-v4-flash':          { inputPerM: 0, outputPerM: 0 },

  // ── StepFun ──────────────────────────────────────────────────────────────
  'stepfun/step-2-mini':             { inputPerM: 0.1, outputPerM: 0.3 },
  'stepfun/step-3-0.2b':             { inputPerM: 0.1, outputPerM: 0.3 },

  // ── Groq ─────────────────────────────────────────────────────────────────
  'groq/deepseek-v4-flash':         { inputPerM: 0.12, outputPerM: 0.12 },

  // ── OneHop ───────────────────────────────────────────────────────────────
  'onehop/deepseek-v4-flash':       { inputPerM: 0.268, outputPerM: 0.4 },

  // ── Cline ────────────────────────────────────────────────────────────────
  'cline/anthropic/claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'cline/anthropic/claude-opus-5':     { inputPerM: 5, outputPerM: 25 },

  // ── CodeCraft API ────────────────────────────────────────────────────────
  'codecraftapi/gemma-2-2b':            { inputPerM: 0.115, outputPerM: 0.23 },
  'codecraftapi/deepseek-v4-flash-0731': { inputPerM: 0.115, outputPerM: 0.115 },
  'codecraftapi/gpt-5.6-luna':          { inputPerM: 0.3565, outputPerM: 0.3565 },
  'codecraftapi/deepseek-v4-pro-0813':  { inputPerM: 0.552, outputPerM: 0.552 },
  'codecraftapi/qwen3.8-27b':           { inputPerM: 0.575, outputPerM: 0.575 },
  'codecraftapi/seed-2.1-turbo':        { inputPerM: 0.92, outputPerM: 0.92 },
  'codecraftapi/seed-2.1-pro':          { inputPerM: 1.15, outputPerM: 1.15 },
  'codecraftapi/kimi-k2.6':             { inputPerM: 1.219, outputPerM: 1.219 },
  'codecraftapi/gemini-3.7-flash':      { inputPerM: 1.242, outputPerM: 1.242 },
  'codecraftapi/glm-5.3':               { inputPerM: 1.357, outputPerM: 1.357 },
  'codecraftapi/glm-5.2':               { inputPerM: 1.357, outputPerM: 1.357 },
  'codecraftapi/qwen3.8-max':           { inputPerM: 1.7595, outputPerM: 1.7595 },
  'codecraftapi/qwen3.7-max':           { inputPerM: 1.7595, outputPerM: 1.7595 },
  'codecraftapi/muse-spark-1.1':        { inputPerM: 1.817, outputPerM: 1.817 },
  'codecraftapi/deepseek-v4-pro-max':   { inputPerM: 2.047, outputPerM: 2.047 },
  'codecraftapi/gemini-3.6-flash':      { inputPerM: 2.4955, outputPerM: 2.4955 },
  'codecraftapi/grok-4.5':              { inputPerM: 2.806, outputPerM: 2.806 },
  'codecraftapi/grok-4.6':              { inputPerM: 2.806, outputPerM: 2.806 },
  'codecraftapi/claude-sonnet-5':       { inputPerM: 3.3235, outputPerM: 3.3235 },
  'codecraftapi/gpt-5.6-terra':         { inputPerM: 3.5765, outputPerM: 3.5765 },
  'codecraftapi/gemini-3.1-pro':        { inputPerM: 4.4735, outputPerM: 4.4735 },
  'codecraftapi/kimi-k3':               { inputPerM: 4.9795, outputPerM: 4.9795 },
  'codecraftapi/claude-opus-5':         { inputPerM: 8.303, outputPerM: 8.303 },
  'codecraftapi/claude-mythos-preview': { inputPerM: 8.303, outputPerM: 8.303 },
  'codecraftapi/claude-opus-4.8':       { inputPerM: 8.303, outputPerM: 8.303 },
  'codecraftapi/claude-opus-4.6':       { inputPerM: 8.303, outputPerM: 8.303 },
  'codecraftapi/claude-opus-4.7':       { inputPerM: 8.303, outputPerM: 8.303 },
  'codecraftapi/gpt-5.6-sol':           { inputPerM: 8.947, outputPerM: 8.947 },
  'codecraftapi/gpt-5.5':               { inputPerM: 8.947, outputPerM: 8.947 },
  'codecraftapi/gpt-5.5-pro':           { inputPerM: 8.947, outputPerM: 8.947 },
  'codecraftapi/claude-fable-5':        { inputPerM: 16.606, outputPerM: 16.606 },

  // ── Kilo ─────────────────────────────────────────────────────────────────
  'kilo/deepseek-v4-flash':         { inputPerM: 0.268, outputPerM: 0.4 },
};

/**
 * Returns the effective price for the exact `provider` + `model`, or
 * `undefined` when that pair has no known price.
 *
 * Lookup order:
 *   1. admin-managed store (config/model-pricing.json) — an ENABLED entry
 *      OVERRIDES any built-in price; a DISABLED entry forces the pair to be
 *      treated as UNKNOWN (even if a built-in price exists).
 *   2. built-in PRICING_REGISTRY exact match.
 *   3. admin-managed store, alias-normalized model (see modelIdVariants).
 *      Usage records store the model id in the form the CLIENT requested
 *      (canonical id, de-prefixed alias, or dot/dash variant), while prices
 *      are registered per canonical catalog id. The fallback resolves those
 *      genuinely equivalent forms to the SAME registered price. It never adds
 *      a price for a model that has none: an ambiguous match (several
 *      variants registered with different prices / mixed enabled state)
 *      yields `undefined`, never a guess.
 *   4. built-in PRICING_REGISTRY, alias-normalized model — same guard.
 *
 * A `$0` price is a valid, known price (free models) — the caller must
 * distinguish it from `undefined` (unknown price).
 */
export function getModelPrice(provider: string | null | undefined, model: string | null | undefined): ModelPrice | null | undefined {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  if (!p || !m) return undefined;

  // 1. Admin-managed entry takes precedence (enabled → override, disabled → unknown).
  const stored = findPricingEntry(p, m);
  if (stored) {
    return stored.enabled ? { inputPerM: stored.inputPerM, outputPerM: stored.outputPerM } : undefined;
  }

  // 2. Built-in registry, case-insensitive exact match only.
  const exactKey = `${p}/${m}` as PriceKey;
  if (exactKey in PRICING_REGISTRY) return PRICING_REGISTRY[exactKey];

  // 3–4. Alias-normalized fallback (exact match already failed).
  return resolveVariantPrice(p, m);
}

/**
 * Equivalent lookup variants of a model id, generated symmetrically from
 * BOTH sides (requested id and registered id) so any pair of genuinely
 * equivalent forms intersects: lowercased input, the vendor/org prefix
 * stripped, dots⇄dashes. An unknown org prefix is never invented
 * ("org/" is only ever removed, never added).
 */
function modelIdVariants(model: string): string[] {
  const out = new Set<string>();
  const add = (id: string): void => {
    if (!id) return;
    out.add(id);
    out.add(id.replace(/\./g, '-'));
    out.add(id.replace(/-(?=\d)/g, '.'));
  };
  const slash = model.indexOf('/');
  add(model);
  if (slash > 0 && slash < model.length - 1) add(model.slice(slash + 1));
  return Array.from(out);
}

/** Splits a `provider/model` registry key on its FIRST slash. */
function splitPriceKey(key: string): { provider: string; model: string } {
  const slash = key.indexOf('/');
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}

/** Variant-layer resolution over the stored entries first, then the built-in registry. */
function resolveVariantPrice(provider: string, model: string): ModelPrice | undefined {
  const reqVariants = new Set(modelIdVariants(model));
  const matches = (candidateModel: string): boolean =>
    modelIdVariants(candidateModel).some(v => reqVariants.has(v));

  // 3. Admin-managed store (override/disabled semantics preserved).
  const storeMatches = loadPricingEntries().filter(e => e.providerId === provider && matches(e.model));
  if (storeMatches.length > 0) {
    const first = storeMatches[0];
    const agree = storeMatches.every(e => e.enabled === first.enabled &&
      (!e.enabled || (e.inputPerM === first.inputPerM && e.outputPerM === first.outputPerM)));
    if (!agree) return undefined;
    return first.enabled
      ? { inputPerM: first.inputPerM, outputPerM: first.outputPerM }
      : undefined;
  }

  // 4. Built-in registry. Distinct matched prices → ambiguous → unknown.
  let matched: ModelPrice | undefined;
  let ambiguous = false;
  for (const key of Object.keys(PRICING_REGISTRY)) {
    const { provider: kp, model: km } = splitPriceKey(key);
    if (kp !== provider || !matches(km)) continue;
    const price = PRICING_REGISTRY[key as PriceKey];
    if (matched && (matched.inputPerM !== price.inputPerM || matched.outputPerM !== price.outputPerM)) {
      ambiguous = true;
      break;
    }
    matched = matched ?? price;
  }
  return ambiguous ? undefined : matched;
}

/**
 * Pricing availability for an exact provider/model pair:
 *   - 'known'   → a registered non-zero price (cost can be computed)
 *   - 'free'    → a registered explicit $0/$0 price (cost IS $0)
 *   - 'unknown' → not registered (cost must stay null / N/A, never $0)
 */
export type PricingStatus = 'known' | 'free' | 'unknown';

export function getPricingStatus(provider: string | null | undefined, model: string | null | undefined): PricingStatus {
  const price = getModelPrice(provider, model);
  if (!price || price.inputPerM === undefined || price.outputPerM === undefined) return 'unknown';
  if (price.inputPerM === 0 && price.outputPerM === 0) return 'free';
  return 'known';
}

/** Per-request cost split by token dimension (USD). */
export interface CostSplit {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/**
 * Computes input/output/total cost separately so usage records and the model
 * breakdown can show each dimension at ITS OWN rate.
 * Returns `null` when the price is unknown or tokens are incomplete — never a
 * fabricated value.
 */
export function computeCostSplit(
  provider: string | null | undefined,
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): CostSplit | null {
  const price = getModelPrice(provider, model);
  if (!price || price.inputPerM === undefined || price.outputPerM === undefined) return null;
  /* Both token dimensions are required. Treating a missing dimension as zero
     would undercharge a request and would turn partial provider usage into a
     fabricated cost. Zero is valid when the provider explicitly reports it. */
  if (
    typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens < 0 ||
    typeof completionTokens !== 'number' || !Number.isFinite(completionTokens) || completionTokens < 0
  ) return null;

  /* Keep the full numeric result (no early rounding); UI formatting is the
     only place where values are rounded. */
  const inputCostUsd = (promptTokens * price.inputPerM) / 1e6;
  const outputCostUsd = (completionTokens * price.outputPerM) / 1e6;
  return { inputCostUsd, outputCostUsd, totalCostUsd: inputCostUsd + outputCostUsd };
}

/**
 * Computes the estimated cost in USD for a single usage record.
 * Returns `null` when the price is unknown (never estimates/guesses).
 *
 * formula: (prompt_tokens × input_price_per_1M/1e6) +
 *          (completion_tokens × output_price_per_1M/1e6)
 */
export function computeCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  const split = computeCostSplit(provider, model, promptTokens, completionTokens);
  return split ? split.totalCostUsd : null;
}

/** Recomputes and returns the per-request cost for a record (or null). */
export function costForRecord(rec: { provider?: string | null; model?: string | null; promptTokens?: number | null; completionTokens?: number | null }): number | null {
  return computeCostUsd(rec.provider, rec.model, rec.promptTokens, rec.completionTokens);
}
