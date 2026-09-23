// Shared standardized provider pipeline logging. Every provider emits the SAME
// log vocabulary so operators see one uniform end-to-end trace regardless of
// which upstream handled the request:
//
//   [PIPELINE][REQUEST]  Provider / BaseURL / Endpoint / Model / Backend / Protocol / Key
//   [PIPELINE][RAW]      HTTP status / ContentType / Headers / body preview (non-JSON saved to file + NON_JSON_RESPONSE flag)
//   [PIPELINE][PARSED]   JSON.parse result
//   [PIPELINE][EXTRACTED_TEXT] where the text was found + its value
//   [PIPELINE][FINAL]    the OpenAI-compatible response sent to the client
//   [PIPELINE][ERROR]    status / latency / retry / cooldown / error
//
// API keys are always masked. Non-JSON bodies (HTML/WAF/CAPTCHA) are saved
// verbatim to disk and flagged NON_JSON_RESPONSE — never converted to JSON.

import * as fs from 'fs';
import * as path from 'path';

let rawDir: string | null = null;

function ensureRawDir(): string {
  if (!rawDir) {
    rawDir = process.env.PIPELINE_RAW_DIR || '/tmp/provider-raw';
    try {
      fs.mkdirSync(rawDir, { recursive: true });
    } catch {
      rawDir = '/tmp';
    }
  }
  return rawDir;
}

/** Mask an API key (keep first 4 + last 4 chars). */
export function maskApiKey(key: string | undefined | null): string {
  if (!key) return '(not set)';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

/** Persist a raw upstream body verbatim and return the file path ('' on failure). */
export function saveRawBody(provider: string, model: string, body: any): string {
  const file = path.join(ensureRawDir(), `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  } catch {
    return '';
  }
  return file;
}

function contentTypeOf(headers: any): string | null {
  if (!headers) return null;
  const ct = headers['content-type'] ?? headers['Content-Type'];
  return typeof ct === 'string' ? ct : null;
}

function preview(body: any): string {
  if (typeof body === 'string') return body.slice(0, 400).replace(/\n/g, '\\n');
  return JSON.stringify(body)?.slice(0, 400) ?? String(body);
}

/** True when a body is NOT JSON (HTML / CAPTCHA / empty / plain text). */
export function isNonJsonBody(body: any): boolean {
  if (typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return false;
    } catch {
      return true;
    }
  }
  return trimmed.length > 0;
}

export interface RequestInfo {
  provider: string;
  baseUrl: string;
  endpoint: string;
  model: string;
  backendModel?: string;
  protocol?: string;
  keyMasked?: string;
}

export function logPipelineRequest(info: RequestInfo): void {
  console.log(
    `[PIPELINE][REQUEST] Provider=${info.provider}  BaseURL=${info.baseUrl}  Endpoint=POST ${info.endpoint}  ` +
      `Model=${info.model}  Backend=${info.backendModel ?? info.model}  Protocol=${info.protocol ?? 'openai'}  ` +
      `Key=${info.keyMasked ?? '(not set)'}`,
  );
}

export interface RawInfo {
  provider: string;
  model: string;
  backendModel?: string;
  endpoint?: string;
  protocol?: string;
  status?: number;
  headers?: any;
  body: any;
  latencyMs?: number;
}

export function logPipelineRaw(info: RawInfo): void {
  const ct = contentTypeOf(info.headers);
  const len = typeof info.body === 'string' ? info.body.length : JSON.stringify(info.body)?.length ?? 0;
  const nonJson = isNonJsonBody(info.body);
  console.log(
    `[PIPELINE][RAW] Provider=${info.provider}  Model=${info.model}  Backend=${info.backendModel ?? info.model}  ` +
      `Endpoint=${info.endpoint ?? 'n/a'}  Protocol=${info.protocol ?? 'openai'}  HTTP=${info.status ?? 'n/a'}  ` +
      `ContentType=${ct ?? 'n/a'}  Length=${len}  Latency=${info.latencyMs ?? 'n/a'}ms  Body=${preview(info.body)}`,
  );
  if (nonJson) {
    const saved = saveRawBody(info.provider, info.model, info.body);
    console.log(
      `[PIPELINE][RAW] Provider=${info.provider}  NON_JSON_RESPONSE  type=${typeof info.body}  len=${len}` +
        (saved ? `  full body saved to ${saved}` : ''),
    );
  }
}

export function logPipelineParsed(provider: string, model: string, body: any, wasJson: boolean, parseError?: string | null): void {
  if (wasJson) {
    console.log(`[PIPELINE][PARSED] Provider=${provider}  Model=${model}  JSON.parse OK  Body=${JSON.stringify(body)?.slice(0, 2000)}`);
  } else {
    console.log(`[PIPELINE][PARSED] Provider=${provider}  Model=${model}  NOT-JSON${parseError ? `  parseError=${parseError}` : ''}`);
  }
}

export function logPipelineExtracted(provider: string, model: string, text: string, location: string): void {
  console.log(`[PIPELINE][EXTRACTED_TEXT] Provider=${provider}  Model=${model}  Location=${location}  Text=${JSON.stringify(text)}`);
}

export function logPipelineFinal(provider: string, model: string, response: any, latencyMs?: number, finishReason?: string | null): void {
  const rendered = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
  const fr = finishReason ?? (typeof response === 'object' && response?.choices?.[0]?.finish_reason) ?? 'n/a';
  console.log(
    `[PIPELINE][FINAL] Provider=${provider}  Model=${model}  FinishReason=${fr}  Latency=${latencyMs ?? 'n/a'}ms\n${rendered}`,
  );
}

export interface ErrorInfo {
  provider: string;
  model: string;
  status?: number;
  error: string;
  latencyMs?: number;
  retry?: boolean;
  cooldown?: boolean;
}

export function logPipelineError(info: ErrorInfo): void {
  const flags = [
    info.retry ? 'RETRY' : null,
    info.cooldown ? 'COOLDOWN' : null,
  ].filter(Boolean).join(' ');
  console.log(
    `[PIPELINE][ERROR] Provider=${info.provider}  Model=${info.model}  HTTP=${info.status ?? 'n/a'}  ` +
      `Latency=${info.latencyMs ?? 'n/a'}ms  Error=${info.error}${flags ? `  ${flags}` : ''}`,
  );
}

export function logPipelineRateLimit(provider: string, model: string, cooldownSeconds: number, status?: number): void {
  console.log(`[PIPELINE][RATE_LIMIT] Provider=${provider}  Model=${model}  HTTP=${status ?? 429}  Cooldown=${cooldownSeconds}s`);
}
