// AgentRouter logging — self-contained, reporting the full telemetry for each
// request: Provider, Model, Backend Model, Protocol, Endpoint, Proxy Mode,
// Discovery, Catalog, Latency and Response status.

import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_ID } from './types';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG_ROUTING === 'true';

export const isDebug = (): boolean => DEBUG;

let rawDir: string | null = null;

function ensureRawDir(): string {
  if (!rawDir) {
    rawDir = process.env.AGENTROUTER_RAW_DIR || '/tmp/agentrouter-raw';
    try {
      fs.mkdirSync(rawDir, { recursive: true });
    } catch {
      rawDir = '/tmp';
    }
  }
  return rawDir;
}

/** Persist the raw upstream body verbatim (string or JSON) and return its path. */
export function saveRawBody(model: string, raw: any): string {
  const dir = ensureRawDir();
  const file = path.join(dir, `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    fs.writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
  } catch {
    return '';
  }
  return file;
}

function maskKeySuffix(key: string): string {
  if (!key) return '(not set)';
  if (key.length <= 8) return '***';
  return '...' + key.slice(-4);
}

export function selectionLog(baseUrl: string, endpoint: string, model: string, protocol: string, backendModel: string, keySuffix: string, proxyMode: boolean): void {
  console.log(`[${PROVIDER_ID}] Base URL: ${baseUrl}`);
  console.log(`[${PROVIDER_ID}] Protocol: ${protocol}`);
  console.log(`[${PROVIDER_ID}] Proxy Mode: ${proxyMode ? 'ON' : 'OFF'}`);
  console.log(`[${PROVIDER_ID}] Endpoint: POST ${baseUrl}${endpoint}`);
  console.log(`[${PROVIDER_ID}] Backend model: ${backendModel}`);
  console.log(`[${PROVIDER_ID}] Client model: ${model}`);
  console.log(`[${PROVIDER_ID}] API key: ${keySuffix}`);
}

export function requestLog(index: number, model: string, backendModel: string, protocol: string, endpoint: string, proxyMode: boolean): void {
  console.log(
    `[${PROVIDER_ID}] Request  KEY#${index + 1}  Model=${model}  Backend=${backendModel}  ` +
    `Protocol=${protocol}  Endpoint=${endpoint}  ProxyMode=${proxyMode ? 'ON' : 'OFF'}`,
  );
}

export function successLog(index: number, model: string, latencyMs: number, status: number): void {
  console.log(`[${PROVIDER_ID}] Success  KEY#${index + 1}  Model=${model}  Latency=${latencyMs}ms  Status=${status}`);
}

export function failureLog(index: number, model: string, status: number, error: string): void {
  console.log(`[${PROVIDER_ID}] Failed   KEY#${index + 1}  Model=${model}  Status=${status}  Error=${error}`);
}

export function rateLimitLog(index: number, cooldownSeconds: number): void {
  console.log(`[${PROVIDER_ID}] RateLimited  KEY#${index + 1}  Cooldown=${cooldownSeconds}s`);
}

export function discoveryLog(message: string): void {
  console.log(`[${PROVIDER_ID}][DISCOVERY] ${message}`);
}

export function catalogLog(message: string): void {
  console.log(`[${PROVIDER_ID}][CATALOG] ${message}`);
}

export function cacheLog(message: string): void {
  console.log(`[${PROVIDER_ID}][CACHE] ${message}`);
}

export function wafLog(message: string): void {
  console.log(`[${PROVIDER_ID}][WAF] ${message}`);
}

export function healthLog(message: string): void {
  console.log(`[${PROVIDER_ID}][HEALTH] ${message}`);
}

/** Log the RAW upstream response body before any parsing/transformation. */
export function responseRawLog(model: string, raw: any): void {
  const type = typeof raw;
  const length = typeof raw === 'string' ? raw.length : JSON.stringify(raw)?.length ?? 0;
  const preview =
    typeof raw === 'string' ? raw.slice(0, 400).replace(/\n/g, '\\n') : JSON.stringify(raw)?.slice(0, 400);
  const file = saveRawBody(model, raw);
  console.log(`[${PROVIDER_ID}][RAW] Model=${model} Type=${type} Length=${length} Preview=${preview} FullBody=${file}`);
}

/** Log the result of JSON.parse over the raw body. */
export function responseParsedLog(model: string, info: { wasJson: boolean; parseError?: string | null; body: any }): void {
  if (info.wasJson) {
    console.log(`[${PROVIDER_ID}][PARSED] Model=${model} JSON.parse OK Body=${JSON.stringify(info.body)?.slice(0, 2000)}`);
  } else {
    console.log(`[${PROVIDER_ID}][PARSED] Model=${model} NOT-JSON (raw body was not a JSON object)${
      info.parseError ? ` parseError=${info.parseError}` : ''
    }`);
  }
}

/** Log where the assistant text was found and its value. */
export function responseExtractLog(model: string, text: string, location: string): void {
  console.log(`[${PROVIDER_ID}][EXTRACTED_TEXT] Model=${model} Location=${location} Text=${JSON.stringify(text)}`);
}

/** Log the final response object right before it is sent back to the client. */
export function responseSentLog(model: string, sent: any): void {
  const rendered = typeof sent === 'string' ? sent : JSON.stringify(sent, null, 2);
  console.log(`[${PROVIDER_ID}][OPENAI_RESPONSE] Model=${model} ${rendered}`);
}

export { maskKeySuffix };