/* ============================================================================
 * nvidia-api · Environment → UI-managed API key migration
 * ----------------------------------------------------------------------------
 * One-time migration of provider credentials from process.env / .env into the
 * Admin-UI-managed store (config/provider-api-keys.json, see api-key-store).
 *
 * CONTRACT (provider-locked, append-only, idempotent):
 *  - Every env var maps to EXACTLY ONE provider (ENV_PROVIDER_MAP). A key is
 *    never moved across providers and never used as a cross-provider fallback.
 *  - Existing UI records are never modified, deleted, reordered or reset:
 *    env-derived keys are APPENDED after them via addApiKey().
 *  - Exact duplicates (same trimmed credential already stored for that
 *    provider) are skipped — reruns are safe no-ops.
 *  - After all inserts, provider sections are reordered to the canonical
 *    project provider order (PROVIDER_ORDER); records inside each provider
 *    keep their relative order. Unknown sections are preserved untouched.
 *  - Labels carry provenance as ENV VAR NAMES ONLY (never values).
 *  - Reports contain counts, var names and masked keys at most — never raw
 *    credentials.
 * ========================================================================== */
import {
  addApiKey,
  hasRawKey,
  loadApiKeysForProvider,
  reorderProviders,
  ApiKeyDuplicateError,
} from './api-key-store';

export interface EnvKeySource {
  /** Trimmed credential value (handled in-memory only, never logged). */
  value: string;
  /** Origin env var, e.g. "GOROUTER_API_KEY_7" (safe to display). */
  source: string;
}

export interface EnvProviderMapping {
  providerId: string;
  envPrefix: string;
  numberedFirst: boolean;
}

/* Canonical env mapping — mirrors src/config.ts loader wiring
 * (loadApiKeys for nvidia, loadProviderKeys(prefix, numberedFirst) else).
 * ONE prefix maps to ONE provider; there is no cross-provider sharing. */
export const ENV_PROVIDER_MAP: EnvProviderMapping[] = [
  { providerId: 'openrouter', envPrefix: 'OPENROUTER_API_KEY', numberedFirst: false },
  { providerId: 'stepfun', envPrefix: 'STEPFUN_API_KEY', numberedFirst: false },
  { providerId: 'glm', envPrefix: 'GLM_API_KEY', numberedFirst: false },
  { providerId: 'gorouter', envPrefix: 'GOROUTER_API_KEY', numberedFirst: true },
  { providerId: 'inferx', envPrefix: 'INFERX_API_KEY', numberedFirst: true },
  { providerId: 'onehop', envPrefix: 'ONEHOP_API_KEY', numberedFirst: true },
  { providerId: 'orcarouter', envPrefix: 'ORCAROUTER_API_KEY', numberedFirst: true },
  { providerId: 'huggingface', envPrefix: 'HUGGINGFACE_API_KEY', numberedFirst: true },
  { providerId: 'seekai', envPrefix: 'SEEKAI_API_KEY', numberedFirst: true },
  { providerId: 'hcnsec', envPrefix: 'HCNSEC_API_KEY', numberedFirst: true },
  { providerId: 'justwoker', envPrefix: 'JUSTWOKER_API_KEY', numberedFirst: true },
  { providerId: 'bitdeer', envPrefix: 'BITDEER_API_KEY', numberedFirst: true },
  { providerId: 'hashneuron', envPrefix: 'HASHNEURON_API_KEY', numberedFirst: true },
  { providerId: 'flatkey', envPrefix: 'FLATKEY_API_KEY', numberedFirst: true },
  { providerId: 'aisurplus', envPrefix: 'AISURPLUS_API_KEY', numberedFirst: true },
  { providerId: 'kiosapi', envPrefix: 'KIOSAPI_API_KEY', numberedFirst: true },
  { providerId: 'nusapi', envPrefix: 'NUSAPI_API_KEY', numberedFirst: true },
  { providerId: 'experientiallabs', envPrefix: 'EXPERIENTIALLABS_API_KEY', numberedFirst: true },
  { providerId: 'codepus', envPrefix: 'CODEPUS_API_KEY', numberedFirst: true },
  { providerId: 'teamorouter', envPrefix: 'TEAMOROUTER_API_KEY', numberedFirst: true },
  { providerId: 'bazaarlink', envPrefix: 'BAZAARLINK_API_KEY', numberedFirst: true },
  { providerId: 'groq', envPrefix: 'GROQ_API_KEY', numberedFirst: true },
  { providerId: 'kilo', envPrefix: 'KILO_API_KEY', numberedFirst: true },
  { providerId: 'zen', envPrefix: 'ZEN_API_KEY', numberedFirst: true },
  { providerId: 'logfare', envPrefix: 'LOGFARE_API_KEY', numberedFirst: true },
  { providerId: 'empero', envPrefix: 'EMPERO_API_KEY', numberedFirst: true },
  { providerId: 'agentrouter', envPrefix: 'AGENTROUTER_API_KEY', numberedFirst: true },
  { providerId: 'tokenharbor', envPrefix: 'TOKENHARBOR_API_KEY', numberedFirst: true },
  { providerId: 'codecraftapi', envPrefix: 'CODECRAFTAPI_API_KEY', numberedFirst: true },
  { providerId: 'cline', envPrefix: 'CLINE_API_KEY', numberedFirst: true },
  { providerId: 'dahl', envPrefix: 'DAHL_API_KEY', numberedFirst: true },
  { providerId: 'tabitoken', envPrefix: 'TABITOKEN_API_KEY', numberedFirst: true },
  { providerId: 'bai', envPrefix: 'BAI_API_KEY', numberedFirst: true },
  { providerId: 'unli', envPrefix: 'UNLI_API_KEY', numberedFirst: true },
  { providerId: 'tokenrouter', envPrefix: 'TOKENROUTER_API_KEY', numberedFirst: true },
  { providerId: 'llm7', envPrefix: 'LLM7_API_KEY', numberedFirst: true },
  { providerId: 'deepbricks', envPrefix: 'DEEPBRICKS_API_KEY', numberedFirst: true },
  { providerId: 'gmi', envPrefix: 'GMI_API_KEY', numberedFirst: true },
  { providerId: 'xkiro', envPrefix: 'XKIRO_API_KEY', numberedFirst: true },
  { providerId: 'kktoken', envPrefix: 'KKTOKEN_API_KEY', numberedFirst: true },
  { providerId: 'freebuff', envPrefix: 'FREEBUFF_API_KEY', numberedFirst: true },
  { providerId: 'vyceai', envPrefix: 'VYCEAI_API_KEY', numberedFirst: true },
  { providerId: 'tokenforge', envPrefix: 'TOKENFORGE_API_KEY', numberedFirst: true },
  { providerId: 'atria', envPrefix: 'ATRIA_API_KEY', numberedFirst: true },
  { providerId: 'hive', envPrefix: 'HIVE_API_KEY', numberedFirst: true },
  { providerId: 'apmix', envPrefix: 'APMIX_API_KEY', numberedFirst: true },
  { providerId: 'invibuilder', envPrefix: 'INVIBUILDER_API_KEY', numberedFirst: true },
  { providerId: 'inception', envPrefix: 'INCEPTION_API_KEY', numberedFirst: true },
  { providerId: 'jiji', envPrefix: 'JIJI_API_KEY', numberedFirst: true },
];

/* Canonical provider order = init sequence in src/services/provider.ts.
 * Databricks/Cloudflare keep their positions but are never migrated
 * (endpoint-embedded / token architecture, no UI-store sync support). */
export const PROVIDER_ORDER: string[] = [
  'cloudflare', 'stepfun', 'glm', 'openrouter', 'nvidia', 'databricks',
  'gorouter', 'inferx', 'onehop', 'orcarouter', 'seekai', 'justwoker',
  'bitdeer', 'hashneuron', 'hcnsec', 'teamorouter', 'groq', 'kilo', 'zen', 'logfare',
  'empero', 'agentrouter', 'tokenharbor', 'codecraftapi', 'cline', 'dahl',
  'tabitoken', 'bai', 'unli', 'llm7', 'bazaarlink', 'freebuff', 'deepbricks',
  'vyceai', 'tokenrouter', 'huggingface', 'gmi', 'xkiro', 'kktoken', 'flatkey',
  'aisurplus', 'kiosapi', 'nusapi',   'experientiallabs', 'codepus', 'tokenforge', 'atria', 'hive', 'apmix', 'invibuilder', 'inception', 'jiji',
];

type EnvMap = Record<string, string | undefined>;

function nonEmpty(val: string | undefined): string | null {
  if (val === undefined) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Mirrors loadApiKeys() (NVIDIA): CSV → numbered 1..100 → single. */
export function readNvidiaKeys(env: EnvMap): EnvKeySource[] {
  const csv = nonEmpty(env['NVIDIA_API_KEYS']);
  if (csv) {
    return csv.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
      .map((value, idx) => ({ value, source: `NVIDIA_API_KEYS[${idx}]` }));
  }
  const numbered: EnvKeySource[] = [];
  for (let i = 1; i <= 100; i++) {
    const val = env[`NVIDIA_API_KEY_${i}`];
    if (val === undefined) break;
    const trimmed = nonEmpty(val);
    if (trimmed) numbered.push({ value: trimmed, source: `NVIDIA_API_KEY_${i}` });
  }
  if (numbered.length > 0) return numbered;
  const single = nonEmpty(env['NVIDIA_API_KEY']);
  if (single) return [{ value: single, source: 'NVIDIA_API_KEY' }];
  return [];
}

/** Mirrors loadProviderKeys(prefix, numberedFirst) incl. CSV-alias + gap rules. */
export function readProviderKeys(env: EnvMap, mapping: EnvProviderMapping): EnvKeySource[] {
  const { envPrefix: prefix, numberedFirst } = mapping;
  const readCsv = (): EnvKeySource[] => {
    const vars = [`${prefix}S`, prefix.replace(/_$/, '_KEYS')].filter((v, i, a) => a.indexOf(v) === i);
    for (const keysVar of vars) {
      const parsed = (nonEmpty(env[keysVar]) ?? '').split(',')
        .map((k) => k.trim()).filter((k) => k.length > 0);
      if (parsed.length > 0) return parsed.map((value, idx) => ({ value, source: `${keysVar}[${idx}]` }));
    }
    return [];
  };
  const readNumbered = (skipEmpty: boolean): EnvKeySource[] => {
    const out: EnvKeySource[] = [];
    for (let i = 1; i <= 100; i++) {
      const val = env[`${prefix}_${i}`];
      if (skipEmpty) {
        if (val === undefined) break;
        const trimmed = nonEmpty(val);
        if (trimmed) out.push({ value: trimmed, source: `${prefix}_${i}` });
      } else {
        if (!val) break;
        out.push({ value: val.trim(), source: `${prefix}_${i}` });
      }
    }
    return out;
  };
  if (numberedFirst) {
    const numbered = readNumbered(true);
    if (numbered.length > 0) return numbered;
    const csv = readCsv();
    if (csv.length > 0) return csv;
  } else {
    const csv = readCsv();
    if (csv.length > 0) return csv;
    const numbered = readNumbered(false);
    if (numbered.length > 0) return numbered;
  }
  const single = nonEmpty(env[prefix]);
  if (single) return [{ value: single, source: prefix }];
  return [];
}

export interface MigrateProviderReport {
  providerId: string;
  envCount: number;
  existingUi: number;
  added: number;
  skippedDuplicate: number;
  /** Origin env var names only — never credential values. */
  sources: string[];
}

export interface MigrateReport {
  providers: MigrateProviderReport[];
  totalEnv: number;
  totalExistingUi: number;
  totalAdded: number;
  totalSkipped: number;
}

/**
 * Migrates every env-provided credential into the UI-managed store.
 * Existing records are preserved untouched; exact duplicates are skipped;
 * provider sections end up in canonical order. Safe to rerun (idempotent).
 */
export function migrateEnvKeys(env: EnvMap): MigrateReport {
  const report: MigrateReport = {
    providers: [],
    totalEnv: 0,
    totalExistingUi: 0,
    totalAdded: 0,
    totalSkipped: 0,
  };
  const migrateProvider = (providerId: string, envKeys: EnvKeySource[]) => {
    const existingUi = loadApiKeysForProvider(providerId).length;
    let added = 0;
    let skippedDuplicate = 0;
    const sources: string[] = [];
    for (const { value, source } of envKeys) {
      if (hasRawKey(providerId, value)) {
        skippedDuplicate++;
        continue;
      }
      try {
        addApiKey(providerId, value, `migrated from ${source}`);
        added++;
        sources.push(source);
      } catch (e) {
        if (e instanceof ApiKeyDuplicateError) {
          skippedDuplicate++;
        } else {
          throw e;
        }
      }
    }
    report.providers.push({ providerId, envCount: envKeys.length, existingUi, added, skippedDuplicate, sources });
    report.totalEnv += envKeys.length;
    report.totalExistingUi += existingUi;
    report.totalAdded += added;
    report.totalSkipped += skippedDuplicate;
  };

  migrateProvider('nvidia', readNvidiaKeys(env));
  for (const mapping of ENV_PROVIDER_MAP) {
    migrateProvider(mapping.providerId, readProviderKeys(env, mapping));
  }
  reorderProviders(PROVIDER_ORDER);
  return report;
}
