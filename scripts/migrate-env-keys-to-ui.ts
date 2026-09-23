/* One-time migration: provider credentials from .env into the Admin-UI-managed
 * store (config/provider-api-keys.json).
 *
 *  - Existing UI records are preserved untouched (order/content/status).
 *  - Exact duplicates are skipped (idempotent — safe to rerun).
 *  - Provider sections end up in canonical project order.
 *  - .env is NEVER modified by this script.
 *  - Output contains counts + env var names + masked keys only (never values).
 *
 * Usage:  npx tsx scripts/migrate-env-keys-to-ui.ts
 * (DATA_DIR defaults to <project>/config; override via DATA_DIR env if needed.)
 */
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { migrateEnvKeys } from '../src/lib/migrate-env-keys';

const envPath = path.resolve(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error(`[migrate] .env not found at ${envPath}`);
  process.exit(1);
}
const env = dotenv.parse(fs.readFileSync(envPath));
const report = migrateEnvKeys(env);
console.log(JSON.stringify(report, null, 2));
console.log(`[migrate] done: env=${report.totalEnv} existingUi=${report.totalExistingUi} ` +
  `added=${report.totalAdded} skippedDuplicate=${report.totalSkipped}`);
