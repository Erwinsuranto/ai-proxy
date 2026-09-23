// AgentRouter WAF/CAPTCHA/HTML challenge detection and discovery classification.
// Self-contained — does not depend on the shared lib/discovery module so this
// provider is fully independent.

import { ProviderStatus } from './types';
import { wafLog } from './logger';

/** Keywords identifying well-known bot-challenge / WAF interstitials. */
export const WAF_KEYWORDS: Record<string, string[]> = {
  aliyun: ['aliyun', 'aliyun_waf', 'aliyuncaptcha', 'aliyun web application firewall'],
  cloudflare: ['cloudflare', 'cf-chl', 'cf-ray', 'just a moment', 'challenge-platform'],
  akamai: ['akamai', 'akamaiwaf', '_abck', 'ak_bmsc'],
  imperva: ['imperva', 'incapsula', 'blocked because we detected a high risk', 'acd_cmd'],
  captcha: ['captcha', 'slider', 'verify you are human', 'recaptcha', 'g-recaptcha', 'geetest'],
  unknown: ['access denied', 'request blocked', 'security check', 'bot trapped', 'too many requests from this ip'],
};

function normalizeContentType(contentType: string | null): string {
  return (contentType ?? '').toLowerCase();
}

/** Whether a raw body/content-type looks like a (possibly unknown) HTML challenge. */
export function detectWAF(contentType: string | null, rawText: string): boolean {
  const ct = normalizeContentType(contentType);
  if (ct.includes('text/html')) return true;

  const lower = rawText.toLowerCase();
  const looksHtml =
    lower.trimStart().startsWith('<') ||
    lower.includes('<!doctype') ||
    lower.includes('<html') ||
    lower.includes('<script') ||
    lower.includes('<form');

  const keywordHit = Object.values(WAF_KEYWORDS).flat().some((k) => lower.includes(k));

  // Only treat keyword hits as WAF when the body is clearly not JSON, so a
  // legitimate JSON payload containing a word is not flagged.
  return keywordHit && (looksHtml || ct === '' || ct.includes('text/plain'));
}

/** The specific WAF vendor(s) matched, for diagnostics. */
export function detectWAFVendor(contentType: string | null, rawText: string): string[] {
  const ct = normalizeContentType(contentType);
  if (ct.includes('text/html')) return ['html'];
  const lower = rawText.toLowerCase();
  const found: string[] = [];
  for (const [vendor, keys] of Object.entries(WAF_KEYWORDS)) {
    if (keys.some((k) => lower.includes(k))) found.push(vendor);
  }
  const looksHtml =
    lower.trimStart().startsWith('<') || lower.includes('<!doctype') || lower.includes('<html');
  if (found.length === 0 && looksHtml) found.push('unknown');
  return found;
}

/** HTTP-error mapping to an AgentRouter provider status. */
export function statusFromError(error: any): { status: ProviderStatus; httpStatus: number | null; reason: string } {
  const httpStatus = error?.status ?? error?.response?.status ?? null;
  const code = error?.code ?? '';
  const msg = String(error?.message ?? 'unknown error');

  if (code === 'ECONNABORTED' || /timeout/i.test(msg) || code === 'ETIMEDOUT') {
    return { status: 'timeout', httpStatus, reason: `request timed out: ${msg}` };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'authentication_failed', httpStatus, reason: `auth failed (HTTP ${httpStatus})` };
  }
  if (httpStatus === 429) {
    return { status: 'rate_limited', httpStatus, reason: `rate limited (HTTP ${httpStatus})` };
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { status: 'upstream_error', httpStatus, reason: `upstream error (HTTP ${httpStatus})` };
  }
  return { status: 'upstream_error', httpStatus, reason: `request failed: ${msg}` };
}

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

function extractContentType(headers: any): string | null {
  if (!headers) return null;
  const ct = headers['content-type'] ?? headers['Content-Type'];
  return typeof ct === 'string' ? ct : null;
}

function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export interface ClassifyInput {
  elapsedMs: number;
  response?: { status: number; headers?: Record<string, any>; data: any };
  error?: any;
  /** Structural extractor; returns model array or null when schema mismatches. */
  extract: (data: any) => any[] | null;
}

export interface ClassifyResult {
  status: ProviderStatus;
  reason: string;
  httpStatus: number | null;
  contentType: string | null;
  responseBytes: number;
  responseTime: number;
  blockedByWAF: boolean;
  models: any[];
}

/**
 * Classify a discovery attempt. Pure — no side effects; caller persists state.
 */
export function classifyDiscovery(input: ClassifyInput): ClassifyResult {
  const { response, error } = input;

  if (error && !response) {
    const { status, httpStatus, reason } = statusFromError(error);
    const body = error?.response?.data;
    const rawText =
      body === undefined || body === null ? '' : typeof body === 'string' ? body : safeStringify(body);
    const contentType = extractContentType(error?.response?.headers);
    const blockedByWAF = rawText ? detectWAF(contentType, rawText) : false;
    if (blockedByWAF) {
      const vendors = detectWAFVendor(contentType, rawText);
      wafLog(`WAF challenge on error response (${vendors.join('/') || 'unknown'})`);
      return {
        status: 'blocked_by_waf',
        reason: 'upstream returned a WAF/CAPTCHA challenge page',
        httpStatus,
        contentType,
        responseBytes: byteLength(rawText),
        responseTime: input.elapsedMs ?? 0,
        blockedByWAF: true,
        models: [],
      };
    }
    return {
      status,
      reason,
      httpStatus,
      contentType,
      responseBytes: byteLength(rawText),
      responseTime: input.elapsedMs ?? 0,
      blockedByWAF: false,
      models: [],
    };
  }

  const httpStatus = response?.status ?? 0;
  const contentType = extractContentType(response?.headers);
  const data = response?.data;
  const rawText = typeof data === 'string' ? data : safeStringify(data);
  const responseBytes = byteLength(rawText);
  const base = { httpStatus, contentType, responseBytes, responseTime: input.elapsedMs ?? 0 };

  if (detectWAF(contentType, rawText)) {
    const vendors = detectWAFVendor(contentType, rawText);
    wafLog(`HTML/CAPTCHA body detected (WAF: ${vendors.join('/') || 'unknown'})`);
    return {
      ...base,
      status: 'blocked_by_waf',
      reason: 'HTML/CAPTCHA body detected (WAF challenge)',
      blockedByWAF: true,
      models: [],
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    const { status, reason } = statusFromError({ status: httpStatus, response });
    return { ...base, status, reason, blockedByWAF: false, models: [] };
  }

  let parsed: any = data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return { ...base, status: 'invalid_response', reason: 'empty response body', blockedByWAF: false, models: [] };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ...base, status: 'invalid_json', reason: 'response body is not valid JSON', blockedByWAF: false, models: [] };
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ...base, status: 'invalid_response', reason: 'JSON body is not an object/array', blockedByWAF: false, models: [] };
  }

  const models = input.extract(parsed);
  if (models === null) {
    return { ...base, status: 'invalid_response', reason: 'JSON did not match expected provider schema', blockedByWAF: false, models: [] };
  }
  if (models.length === 0) {
    return { ...base, status: 'empty_catalog', reason: 'valid JSON but zero models returned', blockedByWAF: false, models: [] };
  }

  return { ...base, status: 'healthy', reason: `discovered ${models.length} models`, blockedByWAF: false, models };
}