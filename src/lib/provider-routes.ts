/* ============================================================================
 * nvidia-api · Generic provider route registry (multi-route foundation)
 * ----------------------------------------------------------------------------
 * One provider owns one baseUrl and N routes. A route contributes only a
 * RELATIVE path (never a host); the full URL is always baseUrl + route.path
 * resolved generically — no `if provider === ...` branches anywhere.
 *
 * Provider selection stays provider-first and provider-locked (see
 * services/provider.ts). Route resolution below NEVER crosses providers: it
 * only chooses among routes registered for the already-selected providerId.
 *
 * Security: route paths are validated to relative paths, `{model}` is the
 * only allowed placeholder, and model values are encoded + rejected on
 * traversal characters. Base URLs are validated for newly registered route
 * owners; existing env-configured providers are untouched.
 * ========================================================================== */

import { RouteProtocol, isRouteProtocol } from './route-protocol';

export interface RouteConfig {
  /** Unique route id within its provider (e.g. 'kie-gemini'). */
  id: string;
  /** Provider that owns this route (e.g. 'kie'). */
  providerId: string;
  /** Human-readable route name for Admin UI. */
  name: string;
  /** Relative path, e.g. '/codex/v1/responses' or '/gemini/v1/models/{model}:streamGenerateContent'. */
  path: string;
  /** Wire protocol spoken on this route. */
  protocol: RouteProtocol;
  /** HTTP method (currently only POST is used). */
  method: 'POST';
  /** Streaming mode declared by the route. */
  streaming: boolean | 'sse';
  /** Disabled routes are never selected. */
  enabled: boolean;
  /** Exact model ids served by this route (case-insensitive). */
  models?: string[];
  /** Lowercase prefixes served by this route (e.g. ['gemini-']). Longest match wins. */
  modelPrefixes?: string[];
  /** Lower number = preferred when several routes match the same model. */
  priority?: number;
}

export class RouteValidationError extends Error { }
export class RouteResolutionError extends Error {
  code: 'PROVIDER_HAS_NO_ROUTES' | 'NO_MATCHING_ROUTE' | 'ROUTE_DISABLED' | 'INVALID_MODEL';
  constructor(code: RouteResolutionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_PATH_LENGTH = 2048;
const MAX_MODEL_LENGTH = 256;
/* Allowed path chars: strict allowlist, `{model}` handled separately. */
const PATH_CHAR_RE = /^[A-Za-z0-9/_.:\-]+$/;

function hasDotDotSegment(path: string): boolean {
  return path.split('/').some((seg) => seg === '..' || seg === '.');
}

/** Validate a route path. Returns the trimmed path or throws. */
export function validateRoutePath(path: any): string {
  if (typeof path !== 'string') {
    throw new RouteValidationError('route path must be a string');
  }
  const p = path.trim();
  if (!p.startsWith('/')) {
    throw new RouteValidationError(`route path must be relative and start with '/': ${p.slice(0, 80)}`);
  }
  if (p.length > MAX_PATH_LENGTH) {
    throw new RouteValidationError('route path too long');
  }
  if (p.includes('://') || p.includes('\\') || p.includes('//')) {
    throw new RouteValidationError('route path must not contain scheme, backslashes or empty segments');
  }
  if (/[\s\x00-\x1f\x7f]/.test(p)) {
    throw new RouteValidationError('route path must not contain whitespace or control characters');
  }
  if (hasDotDotSegment(p)) {
    throw new RouteValidationError('route path must not contain dot segments');
  }
  const withoutPlaceholder = p.split('{model}').join('');
  if (/{|}/.test(withoutPlaceholder)) {
    throw new RouteValidationError('route path supports only the {model} placeholder');
  }
  const occurrences = p.split('{model}').length - 1;
  if (occurrences > 1) {
    throw new RouteValidationError('route path must contain at most one {model} placeholder');
  }
  if (!PATH_CHAR_RE.test(withoutPlaceholder)) {
    throw new RouteValidationError('route path contains disallowed characters');
  }
  return p;
}

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

/** True when a hostname must never be used as a route target (SSRF guard). */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const parts = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    return isPrivateIPv4(parts);
  }
  return false;
}

/** Validate a provider base URL for route owners. Returns trimmed URL or throws. */
export function validateBaseUrl(baseUrl: any): string {
  if (typeof baseUrl !== 'string') {
    throw new RouteValidationError('base URL must be a string');
  }
  const b = baseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(b);
  } catch {
    throw new RouteValidationError('base URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RouteValidationError('base URL must use http(s)');
  }
  if (parsed.username || parsed.password) {
    throw new RouteValidationError('base URL must not contain credentials');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new RouteValidationError('base URL host is not allowed');
  }
  return b;
}

/** Validate + normalize a model id used for {model} substitution. */
export function validateRouteModel(model: any): string {
  if (typeof model !== 'string') {
    throw new RouteResolutionError('INVALID_MODEL', 'model must be a string');
  }
  const m = model.trim();
  if (!m) {
    throw new RouteResolutionError('INVALID_MODEL', 'model is required for route resolution');
  }
  if (m.length > MAX_MODEL_LENGTH) {
    throw new RouteResolutionError('INVALID_MODEL', 'model id too long');
  }
  if (/[\s\x00-\x1f\x7f?#]/.test(m) || m.includes('..') || m.includes('\\')) {
    throw new RouteResolutionError('INVALID_MODEL', 'model id contains disallowed characters');
  }
  return m;
}

/**
 * Substitute {model} safely. Models containing '/' (org prefixes) are rejected
 * for templated paths — callers must pass the short backend id.
 */
export function substituteModelInPath(path: string, model: string): string {
  const safePath = validateRoutePath(path);
  const safeModel = validateRouteModel(model);
  if (!safePath.includes('{model}')) return safePath;
  if (safeModel.includes('/')) {
    throw new RouteResolutionError(
      'INVALID_MODEL',
      'org-prefixed model ids cannot be substituted into route paths; use the short backend id',
    );
  }
  return safePath.split('{model}').join(encodeURIComponent(safeModel));
}

/** Build the full upstream URL generically: baseUrl + route.path. */
export function buildRouteUrl(baseUrl: string, routePath: string, model: string): string {
  const base = validateBaseUrl(baseUrl);
  const resolved = substituteModelInPath(routePath, model);
  const url = base + resolved;
  if (!url.startsWith(base + '/')) {
    throw new RouteValidationError('resolved route URL escapes the provider base URL');
  }
  return url;
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((v) => String(v).toLowerCase().trim()).filter((v) => v.length > 0);
}

/** True when an ENABLED route serves the model (exact match beats prefixes). */
export function routeMatchesModel(route: RouteConfig, model: string): boolean {
  if (!route.enabled) return false;
  const wanted = String(model || '').toLowerCase().trim();
  if (!wanted) return false;
  if (normalizeList(route.models).includes(wanted)) return true;
  let best = -1;
  for (const prefix of normalizeList(route.modelPrefixes)) {
    if (wanted.startsWith(prefix) && prefix.length > best) best = prefix.length;
  }
  return best >= 0;
}

export interface ResolvedRoute {
  route: RouteConfig;
  /** Short backend model id to substitute into {model} paths. */
  backendModel: string;
}

/* In-memory route store. Discovery/provider wiring registers here; Admin CRUD
 * will use the same functions later. Existing single-endpoint providers are
 * NOT registered — absence means "legacy behavior", never an error. */
const routesByProvider: Map<string, RouteConfig[]> = new Map();

function normalizeRoute(input: any): RouteConfig {
  if (!input || typeof input !== 'object') {
    throw new RouteValidationError('route must be an object');
  }
  const id = String(input.id ?? input.routeId ?? '').trim();
  const providerId = String(input.providerId ?? '').trim();
  const name = String(input.name ?? id).trim();
  if (!id) throw new RouteValidationError('route id is required');
  if (!providerId) throw new RouteValidationError('route providerId is required');
  if (!isRouteProtocol(input.protocol)) {
    throw new RouteValidationError(`unknown route protocol: ${String(input.protocol)}`);
  }
  if (input.method !== undefined && input.method !== 'POST') {
    throw new RouteValidationError('route method must be POST');
  }
  const streaming = input.streaming;
  if (streaming !== true && streaming !== false && streaming !== 'sse') {
    throw new RouteValidationError('route streaming must be true, false or "sse"');
  }
  return {
    id,
    providerId,
    name: name || id,
    path: validateRoutePath(input.path),
    protocol: input.protocol,
    method: 'POST',
    streaming,
    enabled: input.enabled !== false,
    models: Array.isArray(input.models) ? input.models.map(String) : undefined,
    modelPrefixes: Array.isArray(input.modelPrefixes) ? input.modelPrefixes.map(String) : undefined,
    priority: typeof input.priority === 'number' ? input.priority : 100,
  };
}

/** Register (or replace) routes. Same (providerId,id) entries are replaced. */
export function registerProviderRoutes(routes: RouteConfig[]): void {
  for (const raw of routes) {
    const route = normalizeRoute(raw);
    const list = routesByProvider.get(route.providerId) || [];
    const idx = list.findIndex((r) => r.id === route.id);
    if (idx >= 0) list[idx] = route;
    else list.push(route);
    routesByProvider.set(route.providerId, list);
  }
}

/** All routes (including disabled) for a provider, sorted by priority. */
export function getRoutesForProvider(providerId: string): RouteConfig[] {
  const list = routesByProvider.get(providerId) || [];
  return [...list].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

/** Enabled routes only. */
export function getEnabledRoutesForProvider(providerId: string): RouteConfig[] {
  return getRoutesForProvider(providerId).filter((r) => r.enabled);
}

export function getRoute(providerId: string, routeId: string): RouteConfig | undefined {
  return getRoutesForProvider(providerId).find((r) => r.id === routeId);
}

/** True when the provider registered explicit routes (otherwise legacy path). */
export function hasRoutes(providerId: string): boolean {
  return (routesByProvider.get(providerId) || []).length > 0;
}

export function setRouteEnabled(providerId: string, routeId: string, enabled: boolean): boolean {
  const list = routesByProvider.get(providerId);
  if (!list) return false;
  const route = list.find((r) => r.id === routeId);
  if (!route) return false;
  route.enabled = enabled;
  return true;
}

/** Clears route registrations (used by tests). */
export function clearProviderRoutes(): void {
  routesByProvider.clear();
}

/**
 * Resolve the route for a model WITHIN one provider. Never consults another
 * provider. Exact `models` matches win over `modelPrefixes`; ties break by
 * route priority, then longest prefix, then route id for determinism.
 */
export function resolveRoute(providerId: string, model: string): ResolvedRoute {
  const backendModel = validateRouteModel(model);
  const all = getRoutesForProvider(providerId);
  if (all.length === 0) {
    throw new RouteResolutionError(
      'PROVIDER_HAS_NO_ROUTES',
      `provider "${providerId}" has no registered routes`,
    );
  }
  const enabled = all.filter((r) => r.enabled);
  if (enabled.length === 0) {
    throw new RouteResolutionError(
      'ROUTE_DISABLED',
      `all routes for provider "${providerId}" are disabled`,
    );
  }
  const wanted = backendModel.toLowerCase();
  const scored: Array<{ route: RouteConfig; exact: boolean; prefixLen: number }> = [];
  for (const route of enabled) {
    if (normalizeList(route.models).includes(wanted)) {
      scored.push({ route, exact: true, prefixLen: wanted.length });
      continue;
    }
    let best = -1;
    for (const prefix of normalizeList(route.modelPrefixes)) {
      if (wanted.startsWith(prefix) && prefix.length > best) best = prefix.length;
    }
    if (best >= 0) scored.push({ route, exact: false, prefixLen: best });
  }
  if (scored.length === 0) {
    throw new RouteResolutionError(
      'NO_MATCHING_ROUTE',
      `no enabled route of provider "${providerId}" serves model "${backendModel}"`,
    );
  }
  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const pa = a.route.priority ?? 100;
    const pb = b.route.priority ?? 100;
    if (pa !== pb) return pa - pb;
    if (a.prefixLen !== b.prefixLen) return b.prefixLen - a.prefixLen;
    return a.route.id.localeCompare(b.route.id);
  });
  return { route: scored[0].route, backendModel };
}

/**
 * Resolve the full upstream URL for (provider, baseUrl, model) generically.
 * baseUrl always comes from the provider; path always from its own route.
 */
export function resolveRouteUrl(providerId: string, baseUrl: string, model: string): { url: string; route: RouteConfig; backendModel: string } {
  const { route, backendModel } = resolveRoute(providerId, model);
  return { url: buildRouteUrl(baseUrl, route.path, backendModel), route, backendModel };
}
