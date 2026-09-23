import * as path from 'path';

/* Root directory for ALL persistent state (usage records, provider API keys,
   model pricing, provider state, backups). Defaults to <project>/config so
   existing deployments are untouched. Tests override DATA_DIR to point at a
   throwaway directory so the suite can never read or corrupt live data. */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'config');
