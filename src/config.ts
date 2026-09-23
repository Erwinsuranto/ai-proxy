import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

/** Application configuration settings. */
export interface Config {
  port: number;
  host: string;
  apiKey: string;
  nvidiaApiKey: string;
  nvidiaApiKeys: string[];
  nvidiaBaseUrl: string;
  timeout: number;
  defaultMaxTokens: number;
  logLevel: string;
  debug: boolean;
  modelAlias: string;
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  cloudflareApiTokens: string[];
  openrouterApiKey: string;
  openrouterApiKeys: string[];
  openrouterBaseUrl: string;
  openrouterSiteUrl: string;
  openrouterSiteName: string;
  stepfunApiKey: string;
  stepfunApiKeys: string[];
  stepfunBaseUrl: string;
  glmApiKey: string;
  glmApiKeys: string[];
  glmBaseUrl: string;
  gorouterApiKey: string;
  gorouterApiKeys: string[];
  gorouterBaseUrl: string;
  inferxApiKey: string;
  inferxApiKeys: string[];
  inferxBaseUrl: string;
  onehopApiKey: string;
  onehopApiKeys: string[];
  onehopBaseUrl: string;
  seekaiApiKey: string;
  seekaiApiKeys: string[];
  seekaiBaseUrl: string;
  seekaiTimeout: number;
  hcnsecApiKey: string;
  hcnsecApiKeys: string[];
  hcnsecBaseUrl: string;
  justwokerApiKey: string;
  justwokerApiKeys: string[];
  justwokerBaseUrl: string;
  justwokerTimeout: number;
  bitdeerApiKey: string;
  bitdeerApiKeys: string[];
  bitdeerBaseUrl: string;
  bitdeerTimeout: number;
  hashneuronApiKey: string;
  hashneuronApiKeys: string[];
  hashneuronBaseUrl: string;
  hashneuronTimeout: number;
  teamorouterApiKey: string;
  teamorouterApiKeys: string[];
  teamorouterBaseUrl: string;
  bazaarlinkApiKey: string;
  bazaarlinkApiKeys: string[];
  bazaarlinkBaseUrl: string;
  groqApiKey: string;
  groqApiKeys: string[];
  groqBaseUrl: string;
  kiloApiKey: string;
  kiloApiKeys: string[];
  kiloBaseUrl: string;
  zenApiKey: string;
  zenApiKeys: string[];
  zenBaseUrl: string;
  inferenceBaseUrl: string;
  logfareApiKey: string;
  logfareApiKeys: string[];
  logfareBaseUrl: string;
  emperoApiKey: string;
  emperoApiKeys: string[];
  emperoBaseUrl: string;
  agentrouterApiKey: string;
  agentrouterApiKeys: string[];
  agentrouterBaseUrl: string;
  agentrouterStaticModels: Array<{ id: string; protocol?: 'openai' | 'anthropic' }>;
  agentrouterProxyMode: boolean;
  tokenharborApiKey: string;
  tokenharborApiKeys: string[];
  tokenharborBaseUrl: string;
  codecraftapiApiKey: string;
  codecraftapiApiKeys: string[];
  codecraftapiBaseUrl: string;
  codecraftapiTimeout: number;
  clineApiKey: string;
  clineApiKeys: string[];
  clineBaseUrl: string;
  dahlApiKey: string;
  dahlApiKeys: string[];
  dahlBaseUrl: string;
  tabitokenApiKey: string;
  tabitokenApiKeys: string[];
  tabitokenBaseUrl: string;
  baiApiKey: string;
  baiApiKeys: string[];
  baiBaseUrl: string;
  unliApiKey: string;
  unliApiKeys: string[];
  unliBaseUrl: string;
  tokenrouterApiKey: string;
  tokenrouterApiKeys: string[];
  tokenrouterBaseUrl: string;
  llm7ApiKey: string;
  llm7ApiKeys: string[];
  llm7BaseUrl: string;
  deepbricksApiKey: string;
  deepbricksApiKeys: string[];
  deepbricksBaseUrl: string;
  gmiApiKey: string;
  gmiApiKeys: string[];
  gmiBaseUrl: string;
  xkiroApiKey: string;
  xkiroApiKeys: string[];
  xkiroBaseUrl: string;
  kktokenApiKey: string;
  kktokenApiKeys: string[];
  kktokenBaseUrl: string;
  freebuffApiKey: string;
  freebuffApiKeys: string[];
  freebuffBaseUrl: string;
  vyceaiApiKey: string;
  vyceaiApiKeys: string[];
  vyceaiBaseUrl: string;
  orcarouterApiKey: string;
  orcarouterApiKeys: string[];
  huggingfaceApiKey: string;
  huggingfaceApiKeys: string[];
  huggingfaceBaseUrl: string;
  orcarouterBaseUrl: string;
  flatkeyApiKey: string;
  flatkeyApiKeys: string[];
  flatkeyBaseUrl: string;
  flatkeyTimeout: number;
  aisurplusApiKey: string;
  aisurplusApiKeys: string[];
  aisurplusBaseUrl: string;
  aisurplusTimeout: number;
  kiosapiApiKey: string;
  kiosapiApiKeys: string[];
  kiosapiBaseUrl: string;
  kiosapiTimeout: number;
  nusapiApiKey: string;
  nusapiApiKeys: string[];
  nusapiBaseUrl: string;
  nusapiTimeout: number;
  experientiallabsApiKey: string;
  experientiallabsApiKeys: string[];
  experientiallabsBaseUrl: string;
  experientiallabsTimeout: number;
  codepusApiKey: string;
  codepusApiKeys: string[];
  codepusBaseUrl: string;
  codepusTimeout: number;
  tokenforgeApiKey: string;
  tokenforgeApiKeys: string[];
  tokenforgeBaseUrl: string;
  tokenforgeTimeout: number;
  atriaApiKey: string;
  atriaApiKeys: string[];
  atriaBaseUrl: string;
  atriaTimeout: number;
  hiveApiKey: string;
  hiveApiKeys: string[];
  hiveBaseUrl: string;
  hiveTimeout: number;
  apmixApiKey: string;
  apmixApiKeys: string[];
  apmixBaseUrl: string;
  apmixTimeout: number;
  invibuilderApiKey: string;
  invibuilderApiKeys: string[];
  invibuilderBaseUrl: string;
  invibuilderTimeout: number;
  inceptionApiKey: string;
  inceptionApiKeys: string[];
  inceptionBaseUrl: string;
  inceptionTimeout: number;
  jijiApiKey: string;
  jijiApiKeys: string[];
  jijiBaseUrl: string;
  jijiTimeout: number;
  kieApiKey: string;
  kieApiKeys: string[];
  kieBaseUrl: string;
  kieTimeout: number;
  databricksEndpoints: Array<{ baseUrl: string; apiKey: string }>;
  databricksModelAliasMap: Map<string, string>;
  databricksVirtualAliases: Map<string, string>;
  modelAliases: Map<string, string>;
  virtualRoutes: any[]; // We'll use any for simplicity; could import VirtualRouteConfig if needed
  disabledProviders: string[];
  providerLockedRouting: boolean;
}

/** Loads the default model alias from config/models.json. */
function loadModelAlias(): string {
  const modelsPath = path.resolve(__dirname, '..', 'config', 'models.json');
  try {
    if (fs.existsSync(modelsPath)) {
      const parsed = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
      if (parsed && typeof parsed.model === 'string') {
        return parsed.model;
      }
    }
  } catch (e: any) {
    console.error(`Failed to load model alias from ${modelsPath}:`, e);
  }
  return 'coding';
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  const suffix = key.slice(-4);
  const prefix = key.length > 16 ? key.slice(0, 9) : key.slice(0, 4);
  return prefix + '***' + suffix;
}

function keyVarName(i: number): string {
  return `NVIDIA_API_KEY_${i}`;
}

function checkEnv(name: string): string {
  const val = process.env[name];
  if (val !== undefined && val.trim().length > 0) return 'FOUND';
  return 'NOT FOUND';
}

/** Loads NVIDIA API keys from environment variables, merging sources. */
function loadApiKeys(): string[] {
  const MAX_NUMBERED = 100;
  const checkCount = Math.min(MAX_NUMBERED, 10);

  console.log('--- Env var check (NVIDIA API keys) ---');
  console.log(`  NVIDIA_API_KEYS    = ${checkEnv('NVIDIA_API_KEYS')}`);
  console.log(`  NVIDIA_API_KEY     = ${checkEnv('NVIDIA_API_KEY')}`);
  for (let i = 1; i <= checkCount; i++) {
    const name = keyVarName(i);
    console.log(`  ${name.padEnd(20)} = ${checkEnv(name)}`);
  }
  if (MAX_NUMBERED > checkCount) {
    const foundExtra = [];
    for (let i = checkCount + 1; i <= MAX_NUMBERED; i++) {
      if (checkEnv(keyVarName(i)) === 'FOUND') foundExtra.push(i);
    }
    if (foundExtra.length > 0) {
      console.log(`  ... and NVIDIA_API_KEY_${foundExtra.join(', NVIDIA_API_KEY_')} FOUND`);
    }
  }

  const loaded: { key: string; source: string }[] = [];

  if (process.env.NVIDIA_API_KEYS) {
    const parts = process.env.NVIDIA_API_KEYS.split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    for (let idx = 0; idx < parts.length; idx++) {
      loaded.push({ key: parts[idx], source: `NVIDIA_API_KEYS[${idx}]` });
    }
  }

  if (loaded.length === 0) {
    for (let i = 1; i <= MAX_NUMBERED; i++) {
      const name = keyVarName(i);
      const val = process.env[name];
      if (val !== undefined) {
        const trimmed = val.trim();
        if (trimmed.length > 0) {
          loaded.push({ key: trimmed, source: name });
        }
      }
    }
  }

  if (loaded.length === 0 && process.env.NVIDIA_API_KEY) {
    const trimmed = process.env.NVIDIA_API_KEY.trim();
    if (trimmed.length > 0) {
      loaded.push({ key: trimmed, source: 'NVIDIA_API_KEY' });
    }
  }

  const total = loaded.length;
  console.log('');
  console.log('Loaded keys:');
  for (let i = 0; i < total; i++) {
    console.log(`  KEY#${i + 1} <- ${loaded[i].source} (${maskKey(loaded[i].key)})`);
  }
  console.log(`  TotalKeys=${total}`);
  console.log('');

  if (total === 1) {
    const hasNumbered = (() => {
      for (let i = 1; i <= MAX_NUMBERED; i++) {
        if (checkEnv(keyVarName(i)) === 'FOUND') return true;
      }
      return false;
    })();
    if (hasNumbered) {
      console.warn('WARNING: Only 1 NVIDIA API key loaded, but numbered keys (NVIDIA_API_KEY_1..N) are set.');
      console.warn('  Check loadApiKeys() merging logic.');
    }
  }

  return loaded.map((e) => e.key);
}

function loadCsvKeys(envName: string): string[] {
  const val = process.env[envName];
  if (!val) return [];
  return val.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
}

function loadProviderKeys(prefix: string, numberedFirst = false): string[] {
  // CSV var name. Untuk mode numberedFirst gunakan nama yang benar (PREFIX + 'S',
  // mis. GOROUTER_API_KEY -> GOROUTER_API_KEYS). Mode lama dipertahankan apa adanya
  // agar provider lain (OpenRouter, dll) tidak berubah perilakunya.
  /* CSV alias candidates: the documented plural form (PREFIX + 'S') is ALWAYS
   * accepted in addition to the legacy stripped form. Without this, providers
   * loaded in legacy mode (OpenRouter, StepFun, GLM, Cloudflare) silently
   * ignore their documented OPENROUTER_API_KEYS-style variables. */
  const csvVars = [`${prefix}S`, prefix.replace(/_$/, '_KEYS')].filter((v, i, a) => a.indexOf(v) === i);
  const readCsv = (): string[] => {
    for (const keysVar of csvVars) {
      const csvVal = process.env[keysVar];
      if (!csvVal) continue;
      const parsed = csvVal.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
      if (parsed.length > 0) return parsed;
    }
    return [];
  };
  const readNumbered = (skipEmpty: boolean): string[] => {
    const numbered: string[] = [];
    for (let i = 1; i <= 100; i++) {
      const key = process.env[`${prefix}_${i}`];
      if (skipEmpty) {
        // Baca semua PREFIX_1..N; lewati yang kosong, berhenti hanya jika tidak terdefinisi.
        if (key === undefined) break;
        const trimmed = key.trim();
        if (trimmed.length > 0) numbered.push(trimmed);
      } else {
        // Perilaku lama: berhenti pada nilai falsy pertama (undefined atau kosong).
        if (!key) break;
        numbered.push(key.trim());
      }
    }
    return numbered;
  };

  if (numberedFirst) {
    // Prioritas: PREFIX_1..N (vertikal) → PREFIX_KEYS (comma, fallback lama) → PREFIX (single)
    const numbered = readNumbered(true);
    if (numbered.length > 0) return numbered;
    const csv = readCsv();
    if (csv.length > 0) return csv;
  } else {
    // Perilaku lama: PREFIX_KEYS (comma) → PREFIX_1..N → PREFIX (single)
    const csv = readCsv();
    if (csv.length > 0) return csv;
    const numbered = readNumbered(false);
    if (numbered.length > 0) return numbered;
  }

  const singleVal = process.env[prefix];
  if (singleVal) return [singleVal.trim()];
  return [];
}

function loadAgentRouterStaticModels(): Array<{ id: string; protocol?: 'openai' | 'anthropic' }> {
  const read = (json: any): Array<{ id: string; protocol?: 'openai' | 'anthropic' }> => {
    const base = Array.isArray(json) ? json : json?.models;
    if (!Array.isArray(base)) return [];
    const out: Array<{ id: string; protocol?: 'openai' | 'anthropic' }> = [];
    for (const entry of base) {
      if (typeof entry === 'string') {
        out.push({ id: entry });
      } else if (entry && typeof entry.id === 'string') {
        const proto = String(entry.protocol ?? '').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
        out.push({ id: entry.id, protocol: proto });
      }
    }
    return out;
  };

  const jsonPath = process.env.AGENTROUTER_MODELS_PATH;
  if (jsonPath) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content);
      const models = read(parsed);
      if (models.length > 0) return models;
    } catch (e: any) {
      console.warn(`[Config] Failed to load AGENTROUTER_MODELS_PATH (${jsonPath}): ${e.message}`);
    }
  }

  const inlineJson = process.env.AGENTROUTER_MODELS;
  if (inlineJson) {
    try {
      const models = read(JSON.parse(inlineJson));
      if (models.length > 0) return models;
    } catch (e: any) {
      console.warn(`[Config] Failed to parse AGENTROUTER_MODELS: ${e.message}`);
    }
  }

  return [];
}

function loadDatabricksEndpoints(): Array<{ baseUrl: string; apiKey: string }> {
  const result: Array<{ baseUrl: string; apiKey: string }> = [];
  for (let i = 1; i <= 100; i++) {
    const raw = process.env[`DATABRICKS_ENDPOINT_${i}`];
    if (!raw) break;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx === -1) {
      console.warn(`[Config] DATABRICKS_ENDPOINT_${i}: missing '|' separator, skipping`);
      continue;
    }
    const baseUrl = trimmed.substring(0, pipeIdx).trim();
    const apiKey = trimmed.substring(pipeIdx + 1).trim();
    if (!baseUrl || !apiKey) {
      console.warn(`[Config] DATABRICKS_ENDPOINT_${i}: empty baseUrl or apiKey, skipping`);
      continue;
    }
    result.push({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey });
  }
  return result;
}

function loadDatabricksModelAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  const jsonPath = process.env.DATABRICKS_MODEL_MAP_PATH;
  if (jsonPath) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const json = JSON.parse(content);
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'string') {
          map.set(key, value);
        }
      }
    } catch (e: any) {
      console.warn(`[Config] Failed to load DATABRICKS_MODEL_MAP_PATH (${jsonPath}): ${e.message}`);
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DATABRICKS_MODEL_MAP_')) {
      const suffix = key.slice('DATARICKS_MODEL_MAP_'.length);
      if (suffix && value) {
        const originalModel = decodeURIComponent(suffix).replace(/__/g, '/').replace(/_/g, '.');
        map.set(originalModel, value);
      }
    }
  }
  return map;
}

function loadDatabricksVirtualAliases(): Map<string, string> {
  const map = new Map<string, string>();
  const jsonPath = process.env.DATABRICKS_ALIAS_PATH;
  if (jsonPath) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const json = JSON.parse(content);
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'string') {
          map.set(key, value);
        }
      }
    } catch (e: any) {
      console.warn(`[Config] Failed to load DATABRICKS_ALIAS_PATH (${jsonPath}): ${e.message}`);
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DATABRICKS_ALIAS_')) {
      const suffix = key.slice('DATABRICKS_ALIAS_'.length);
      if (suffix && value) {
        const originalModel = decodeURIComponent(suffix).replace(/__/g, '/').replace(/_/g, '.');
        map.set(originalModel, value);
      }
    }
  }
  return map;
}

function loadModelAliases(): Map<string, string> {
  const map = new Map<string, string>();
  const jsonPath = process.env.MODEL_ALIASES_PATH;
  if (jsonPath) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const json = JSON.parse(content);
      if (json && typeof json === 'object') {
        for (const [alias, target] of Object.entries(json)) {
          if (typeof target === 'string') {
            map.set(alias, target);
          }
        }
      }
    } catch (e: any) {
      console.warn(`[Config] Failed to load MODEL_ALIASES_PATH (${jsonPath}): ${e.message}`);
    }
  }
  const inlineJson = process.env.MODEL_ALIASES;
  if (inlineJson) {
    try {
      const json = JSON.parse(inlineJson);
      if (json && typeof json === 'object') {
        for (const [alias, target] of Object.entries(json)) {
          if (typeof target === 'string') {
            map.set(alias, target);
          }
        }
      }
    } catch (e: any) {
      console.warn(`[Config] Failed to parse MODEL_ALIASES: ${e.message}`);
    }
  }
  return map;
}

function loadVirtualRoutes(): any[] {
  // We'll import the type if needed, but for now use any to avoid circular issues.
  // In practice, we could import VirtualRouteConfig from ./lib/virtual-router,
  // but that may cause circular dependencies because provider.ts imports config.
  // Instead, we'll accept any and let the runtime check.
  const jsonPath = process.env.VIRTUAL_ROUTES_PATH;
  if (jsonPath) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const json = JSON.parse(content);
      if (Array.isArray(json)) return json;
      if (json.virtualModels && Array.isArray(json.virtualModels)) return json.virtualModels;
      if (json.routes && Array.isArray(json.routes)) return json.routes;
    } catch (e: any) {
      console.warn(`[Config] Failed to load VIRTUAL_ROUTES_PATH (${jsonPath}): ${e.message}`);
    }
  }
  const inlineJson = process.env.VIRTUAL_ROUTES;
  if (inlineJson) {
    try {
      const json = JSON.parse(inlineJson);
      if (Array.isArray(json)) return json;
      if (json.virtualModels && Array.isArray(json.virtualModels)) return json.virtualModels;
      if (json.routes && Array.isArray(json.routes)) return json.routes;
    } catch (e: any) {
      console.warn(`[Config] Failed to parse VIRTUAL_ROUTES: ${e.message}`);
    }
  }
  return [];
}

function loadDisabledProviders(): string[] {
  const fromDisable = loadCsvKeys('DISABLE_PROVIDERS');
  const fromEnable = loadCsvKeys('ENABLED_PROVIDERS');

  const disabled = new Set(fromDisable);

  if (fromEnable.length > 0) {
    const allKnown = [
      'nvidia', 'openrouter', 'stepfun', 'glm',
      'cloudflare', 'databricks', 'gorouter', 'inferx', 'onehop', 'seekai', 'hcnsec', 'zen', 'opencode-inference', 'logfare', 'agentrouter', 'tokenharbor', 'codecraftapi', 'groq', 'kilo', 'cline', 'tabitoken', 'teamorouter', 'unli', 'llm7', 'bazaarlink', 'orcarouter', 'deepbricks', 'freebuff', 'vyceai', 'huggingface', 'bai', 'tokenrouter', 'gmi', 'xkiro', 'kktoken',         'empero', 'justwoker', 'bitdeer', 'hashneuron', 'flatkey', 'aisurplus', 'kiosapi', 'nusapi', 'experientiallabs', 'codepus', 'dahl', 'kie.ai', 'tokenforge', 'atria', 'hive', 'apmix', 'invibuilder', 'inception', 'jiji',
    ];
    for (const id of allKnown) {
      if (!fromEnable.includes(id)) {
        disabled.add(id);
      }
    }
  }

  return Array.from(disabled);
}

/** Application configuration object initialized from environment variables. */
export const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaApiKeys: loadApiKeys(),
  nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  timeout: parseInt(process.env.TIMEOUT || '120000', 10),
  defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS || '16384', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  debug: process.env.DEBUG === 'true',
  modelAlias: loadModelAlias(),
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  cloudflareApiTokens: loadProviderKeys('CLOUDFLARE_API_TOKEN'),
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterApiKeys: loadProviderKeys('OPENROUTER_API_KEY'),
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openrouterSiteName: process.env.OPENROUTER_SITE_NAME || '',
  stepfunApiKey: (process.env.STEPFUN_API_KEY || '').trim(),
  stepfunApiKeys: loadProviderKeys('STEPFUN_API_KEY'),
  stepfunBaseUrl: (process.env.STEPFUN_BASE_URL || 'https://api.stepfun.ai/step_plan/v1').replace(/\/+$/, ''),
  glmApiKey: process.env.GLM_API_KEY || '',
  glmApiKeys: loadProviderKeys('GLM_API_KEY'),
  glmBaseUrl: (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
  gorouterApiKey: process.env.GOROUTER_API_KEY || '',
  gorouterApiKeys: loadProviderKeys('GOROUTER_API_KEY', true),
  gorouterBaseUrl: (process.env.GOROUTER_BASE_URL || 'https://gorouter.app/v1').replace(/\/+$/, ''),
  inferxApiKey: process.env.INFERX_API_KEY || '',
  inferxApiKeys: loadProviderKeys('INFERX_API_KEY', true),
  inferxBaseUrl: (process.env.INFERX_BASE_URL || 'https://model.inferx.net/endpoints/v1').replace(/\/+$/, ''),
  onehopApiKey: process.env.ONEHOP_API_KEY || '',
  onehopApiKeys: loadProviderKeys('ONEHOP_API_KEY', true),
  onehopBaseUrl: (process.env.ONEHOP_BASE_URL || 'https://api.onehop.ai/v1').replace(/\/+$/, ''),
  orcarouterApiKey: (process.env.ORCAROUTER_API_KEY || '').trim(),
  orcarouterApiKeys: loadProviderKeys('ORCAROUTER_API_KEY', true),
  orcarouterBaseUrl: (process.env.ORCAROUTER_BASE_URL || 'https://api.orcarouter.ai/v1').replace(/\/+$/, ''),
  huggingfaceApiKey: (process.env.HUGGINGFACE_API_KEY || '').trim(),
  huggingfaceApiKeys: loadProviderKeys('HUGGINGFACE_API_KEY', true),
  huggingfaceBaseUrl: (process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/+$/, ''),
  seekaiApiKey: (process.env.SEEKAI_API_KEY || '').trim(),
  seekaiApiKeys: loadProviderKeys('SEEKAI_API_KEY', true),
  seekaiBaseUrl: (process.env.SEEKAI_BASE_URL || 'https://seekai.cc/v1').replace(/\/+$/, ''),
  // SeekAI-specific request timeout (Fix #2). SeekAI generations can run long
  // and must not be cut off at the global 30s timeout. Default 120000ms (120s).
  seekaiTimeout: parseInt(process.env.SEEKAI_TIMEOUT || '120000', 10),
  hcnsecApiKey: (process.env.HCNSEC_API_KEY || '').trim(),
  hcnsecApiKeys: loadProviderKeys('HCNSEC_API_KEY', true),
  hcnsecBaseUrl: (process.env.HCNSEC_BASE_URL || 'https://api.hcnsec.cn/v1').replace(/\/+$/, ''),
  justwokerApiKey: (process.env.JUSTWOKER_API_KEY || '').trim(),
  justwokerApiKeys: loadProviderKeys('JUSTWOKER_API_KEY', true),
  justwokerBaseUrl: (process.env.JUSTWOKER_BASE_URL || 'https://api.justwoker.icu/v1').replace(/\/+$/, ''),
  justwokerTimeout: parseInt(process.env.JUSTWOKER_TIMEOUT || '120000', 10),
  bitdeerApiKey: (process.env.BITDEER_API_KEY || '').trim(),
  bitdeerApiKeys: loadProviderKeys('BITDEER_API_KEY', true),
  bitdeerBaseUrl: (process.env.BITDEER_BASE_URL || 'https://api-inference.bitdeer.ai/v1').replace(/\/+$/, ''),
  bitdeerTimeout: parseInt(process.env.BITDEER_TIMEOUT || '120000', 10),
  hashneuronApiKey: (process.env.HASHNEURON_API_KEY || '').trim(),
  hashneuronApiKeys: loadProviderKeys('HASHNEURON_API_KEY', true),
  hashneuronBaseUrl: (process.env.HASHNEURON_BASE_URL || 'https://hashneuron.space/v1').replace(/\/+$/, ''),
  hashneuronTimeout: parseInt(process.env.HASHNEURON_TIMEOUT || '120000', 10),
  flatkeyApiKey: (process.env.FLATKEY_API_KEY || '').trim(),
  flatkeyApiKeys: loadProviderKeys('FLATKEY_API_KEY', true),
  flatkeyBaseUrl: (process.env.FLATKEY_BASE_URL || 'https://router.flatkey.ai/v1').replace(/\/+$/, ''),
  flatkeyTimeout: parseInt(process.env.FLATKEY_TIMEOUT || '120000', 10),
  aisurplusApiKey: (process.env.AISURPLUS_API_KEY || '').trim(),
  aisurplusApiKeys: loadProviderKeys('AISURPLUS_API_KEY', true),
  aisurplusBaseUrl: (process.env.AISURPLUS_BASE_URL || 'https://aisurplus.io/v1').replace(/\/+$/, ''),
  aisurplusTimeout: parseInt(process.env.AISURPLUS_TIMEOUT || '120000', 10),
  kiosapiApiKey: (process.env.KIOSAPI_API_KEY || '').trim(),
  kiosapiApiKeys: loadProviderKeys('KIOSAPI_API_KEY', true),
  kiosapiBaseUrl: (process.env.KIOSAPI_BASE_URL || 'https://router.kiosapi.com/v1').replace(/\/+$/, ''),
  kiosapiTimeout: parseInt(process.env.KIOSAPI_TIMEOUT || '120000', 10),
  nusapiApiKey: (process.env.NUSAPI_API_KEY || '').trim(),
  nusapiApiKeys: loadProviderKeys('NUSAPI_API_KEY', true),
  nusapiBaseUrl: (process.env.NUSAPI_BASE_URL || 'https://nusapi.xyz/v1').replace(/\/+$/, ''),
  nusapiTimeout: parseInt(process.env.NUSAPI_TIMEOUT || '120000', 10),
  experientiallabsApiKey: (process.env.EXPERIENTIALLABS_API_KEY || '').trim(),
  experientiallabsApiKeys: loadProviderKeys('EXPERIENTIALLABS_API_KEY', true),
  experientiallabsBaseUrl: (process.env.EXPERIENTIALLABS_BASE_URL || 'https://api.experientiallabs.ai/v1').replace(/\/+$/, ''),
  experientiallabsTimeout: parseInt(process.env.EXPERIENTIALLABS_TIMEOUT || '120000', 10),
  codepusApiKey: (process.env.CODEPUS_API_KEY || '').trim(),
  codepusApiKeys: loadProviderKeys('CODEPUS_API_KEY', true),
  codepusBaseUrl: (process.env.CODEPUS_BASE_URL || 'https://api.codepus.ai/v1').replace(/\/+$/, ''),
  codepusTimeout: parseInt(process.env.CODEPUS_TIMEOUT || '120000', 10),
  tokenforgeApiKey: (process.env.TOKENFORGE_API_KEY || '').trim(),
  tokenforgeApiKeys: loadProviderKeys('TOKENFORGE_API_KEY', true),
  tokenforgeBaseUrl: (process.env.TOKENFORGE_BASE_URL || 'https://tokenforge.ai.studio/v1').replace(/\/+$/, ''),
  tokenforgeTimeout: parseInt(process.env.TOKENFORGE_TIMEOUT || '120000', 10),
  atriaApiKey: (process.env.ATRIA_API_KEY || '').trim(),
  atriaApiKeys: loadProviderKeys('ATRIA_API_KEY', true),
  atriaBaseUrl: (process.env.ATRIA_BASE_URL || 'https://api.atria-asi.ai/v1').replace(/\/+$/, ''),
  atriaTimeout: parseInt(process.env.ATRIA_TIMEOUT || '120000', 10),
  hiveApiKey: (process.env.HIVE_API_KEY || '').trim(),
  hiveApiKeys: loadProviderKeys('HIVE_API_KEY', true),
  hiveBaseUrl: (process.env.HIVE_BASE_URL || 'https://api-cdn.thehive.ai/api/v3').replace(/\/+$/, ''),
  hiveTimeout: parseInt(process.env.HIVE_TIMEOUT || '120000', 10),
  apmixApiKey: (process.env.APMIX_API_KEY || '').trim(),
  apmixApiKeys: loadProviderKeys('APMIX_API_KEY', true),
  apmixBaseUrl: (process.env.APMIX_BASE_URL || 'https://api.apmix.ai/v1').replace(/\/+$/, ''),
  apmixTimeout: parseInt(process.env.APMIX_TIMEOUT || '120000', 10),
  invibuilderApiKey: (process.env.INVIBUILDER_API_KEY || '').trim(),
  invibuilderApiKeys: loadProviderKeys('INVIBUILDER_API_KEY', true),
  invibuilderBaseUrl: (process.env.INVIBUILDER_BASE_URL || 'https://api.invibuilder.com/api/v1').replace(/\/+$/, ''),
  invibuilderTimeout: parseInt(process.env.INVIBUILDER_TIMEOUT || '120000', 10),
  inceptionApiKey: (process.env.INCEPTION_API_KEY || '').trim(),
  inceptionApiKeys: loadProviderKeys('INCEPTION_API_KEY', true),
  inceptionBaseUrl: (process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1').replace(/\/+$/, ''),
  inceptionTimeout: parseInt(process.env.INCEPTION_TIMEOUT || '120000', 10),
  jijiApiKey: (process.env.JIJI_API_KEY || '').trim(),
  jijiApiKeys: loadProviderKeys('JIJI_API_KEY', true),
  jijiBaseUrl: (process.env.JIJI_BASE_URL || 'https://www.jiji.cc/v1').replace(/\/+$/, ''),
  jijiTimeout: parseInt(process.env.JIJI_TIMEOUT || '120000', 10),
  /* Kie.ai: single base URL for all routes (gemini/claude/codex paths are
   * route data, not separate providers). Keys follow the standard
   * env-seed → UI-managed migration contract: KIE_API_KEY_1..N seed the
   * rotation until Admin UI records exist, after which the UI store is the
   * only source (resolveRuntimeKeys never merges the two). */
  kieApiKey: (process.env.KIE_API_KEY || '').trim(),
  kieApiKeys: loadProviderKeys('KIE_API_KEY', true),
  kieBaseUrl: (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/+$/, ''),
  kieTimeout: parseInt(process.env.KIE_TIMEOUT || '120000', 10),
  teamorouterApiKey: (process.env.TEAMOROUTER_API_KEY || '').trim(),
  teamorouterApiKeys: loadProviderKeys('TEAMOROUTER_API_KEY', true),
  teamorouterBaseUrl: (process.env.TEAMOROUTER_BASE_URL || 'https://api.teamorouter.com/v1').replace(/\/+$/, ''),
  bazaarlinkApiKey: (process.env.BAZAARLINK_API_KEY || '').trim(),
  bazaarlinkApiKeys: loadProviderKeys('BAZAARLINK_API_KEY', true),
  bazaarlinkBaseUrl: (process.env.BAZAARLINK_BASE_URL || 'https://bazaarlink.ai/api/v1').replace(/\/+$/, ''),
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  groqApiKeys: loadProviderKeys('GROQ_API_KEY', true),
  groqBaseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  kiloApiKey: (process.env.KILO_API_KEY || '').trim(),
  kiloApiKeys: loadProviderKeys('KILO_API_KEY', true),
  kiloBaseUrl: (process.env.KILO_BASE_URL || 'https://api.kilo.ai/api/gateway').replace(/\/+$/, ''),
  zenApiKey: (process.env.ZEN_API_KEY || '').trim(),
  zenApiKeys: loadProviderKeys('ZEN_API_KEY', true),
  zenBaseUrl: (process.env.ZEN_BASE_URL || 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),
  /* OpenCode Inference API — a SEPARATE channel from Zen. Free models are
   * called without an Authorization header, so this provider takes no keys. */
  inferenceBaseUrl: (process.env.INFERENCE_BASE_URL || 'https://opencode.ai/inference/openai/v1').replace(/\/+$/, ''),
  logfareApiKey: (process.env.LOGFARE_API_KEY || '').trim(),
  logfareApiKeys: loadProviderKeys('LOGFARE_API_KEY', true),
  logfareBaseUrl: (process.env.LOGFARE_BASE_URL || 'https://logfare.ai/v1').replace(/\/+$/, ''),
  emperoApiKey: (process.env.EMPERO_API_KEY || '').trim(),
  emperoApiKeys: loadProviderKeys('EMPERO_API_KEY', true),
  emperoBaseUrl: (process.env.EMPERO_BASE_URL || 'https://free.empero.org/v1').replace(/\/+$/, ''),
  agentrouterApiKey: process.env.AGENTROUTER_API_KEY || '',
  agentrouterApiKeys: loadProviderKeys('AGENTROUTER_API_KEY', true),
  agentrouterBaseUrl: (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org/v1').replace(/\/+$/, ''),
  agentrouterStaticModels: loadAgentRouterStaticModels(),
  agentrouterProxyMode: process.env.AGENTROUTER_PROXY_MODE === 'true',
  tokenharborApiKey: process.env.TOKENHARBOR_API_KEY || '',
  tokenharborApiKeys: loadProviderKeys('TOKENHARBOR_API_KEY', true),
  tokenharborBaseUrl: (process.env.TOKENHARBOR_BASE_URL || 'https://tokenharbor.ai').replace(/\/+$/, ''),
  codecraftapiApiKey: (process.env.CODECRAFTAPI_API_KEY || '').trim(),
  codecraftapiApiKeys: loadProviderKeys('CODECRAFTAPI_API_KEY', true),
  codecraftapiBaseUrl: (process.env.CODECRAFTAPI_BASE_URL || 'https://codecraftapi.com/v1').replace(/\/+$/, ''),
  codecraftapiTimeout: parseInt(process.env.CODECRAFTAPI_TIMEOUT || '180000', 10),
  clineApiKey: (process.env.CLINE_API_KEY || '').trim(),
  clineApiKeys: loadProviderKeys('CLINE_API_KEY', true),
  clineBaseUrl: (process.env.CLINE_BASE_URL || 'https://api.cline.bot/api/v1').replace(/\/+$/, ''),
  dahlApiKey: (process.env.DAHL_API_KEY || '').trim(),
  dahlApiKeys: loadProviderKeys('DAHL_API_KEY', true),
  dahlBaseUrl: (process.env.DAHL_BASE_URL || 'https://inference.dahl.global/v1').replace(/\/+$/, ''),
  tabitokenApiKey: (process.env.TABITOKEN_API_KEY || '').trim(),
  tabitokenApiKeys: loadProviderKeys('TABITOKEN_API_KEY', true),
  tabitokenBaseUrl: (process.env.TABITOKEN_BASE_URL || 'https://tabitoken.com/v1').replace(/\/+$/, ''),
  baiApiKey: (process.env.BAI_API_KEY || '').trim(),
  baiApiKeys: loadProviderKeys('BAI_API_KEY', true),
  baiBaseUrl: (process.env.BAI_BASE_URL || 'https://api.b.ai/v1').replace(/\/+$/, ''),
  unliApiKey: (process.env.UNLI_API_KEY || '').trim(),
  unliApiKeys: loadProviderKeys('UNLI_API_KEY', true),
  unliBaseUrl: (process.env.UNLI_BASE_URL || 'https://api.unli.dev/v1').replace(/\/+$/, ''),
  tokenrouterApiKey: (process.env.TOKENROUTER_API_KEY || '').trim(),
  tokenrouterApiKeys: loadProviderKeys('TOKENROUTER_API_KEY', true),
  tokenrouterBaseUrl: (process.env.TOKENROUTER_BASE_URL || 'https://api.tokenrouter.com/v1').replace(/\/+$/, ''),
  llm7ApiKey: (process.env.LLM7_API_KEY || '').trim(),
  llm7ApiKeys: loadProviderKeys('LLM7_API_KEY', true),
  llm7BaseUrl: (process.env.LLM7_BASE_URL || 'https://api.llm7.io/v1').replace(/\/+$/, ''),
  deepbricksApiKey: (process.env.DEEPBRICKS_API_KEY || '').trim(),
  deepbricksApiKeys: loadProviderKeys('DEEPBRICKS_API_KEY', true),
  deepbricksBaseUrl: (process.env.DEEPBRICKS_BASE_URL || 'https://api.deepbricks.ai/v1').replace(/\/+$/, ''),
  gmiApiKey: (process.env.GMI_API_KEY || '').trim(),
  gmiApiKeys: loadProviderKeys('GMI_API_KEY', true),
  gmiBaseUrl: (process.env.GMI_BASE_URL || 'https://api.gmi-serving.com/v1').replace(/\/+$/, ''),
  xkiroApiKey: (process.env.XKIRO_API_KEY || '').trim(),
  xkiroApiKeys: loadProviderKeys('XKIRO_API_KEY', true),
  xkiroBaseUrl: (process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1').replace(/\/+$/, ''),
  kktokenApiKey: (process.env.KKTOKEN_API_KEY || '').trim(),
  kktokenApiKeys: loadProviderKeys('KKTOKEN_API_KEY', true),
  kktokenBaseUrl: (process.env.KKTOKEN_BASE_URL || 'https://kktoken.cc/v1').replace(/\/+$/, ''),
  freebuffApiKey: (process.env.FREEBUFF_API_KEY || '').trim(),
  freebuffApiKeys: loadProviderKeys('FREEBUFF_API_KEY', true),
  freebuffBaseUrl: (process.env.FREEBUFF_BASE_URL || 'http://localhost:8787/v1').replace(/\/+$/, ''),
  vyceaiApiKey: (process.env.VYCEAI_API_KEY || '').trim(),
  vyceaiApiKeys: loadProviderKeys('VYCEAI_API_KEY', true),
  vyceaiBaseUrl: (process.env.VYCEAI_BASE_URL || 'https://vyceai.com/v1').replace(/\/+$/, ''),
  databricksEndpoints: loadDatabricksEndpoints(),
  databricksModelAliasMap: loadDatabricksModelAliasMap(),
  databricksVirtualAliases: loadDatabricksVirtualAliases(),
  modelAliases: loadModelAliases(),
  virtualRoutes: loadVirtualRoutes(),
  disabledProviders: loadDisabledProviders(),
  // Core routing is always provider-locked. Provider selection comes from the
  // model registry; retries rotate only keys within that selected provider.
  // Explicit Virtual Routes and Combos remain the only cross-provider choices.
  providerLockedRouting: true,
};
