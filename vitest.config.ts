import { defineConfig, configDefaults } from 'vitest/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

/* One throwaway state directory per test run, shared by the vitest process
   (direct store imports) and every spawned server child (tests/setup.ts
   inherits it via process.env). Keeps the suite from reading or corrupting
   live production data under <project>/config. */
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-api-test-data-'));

/* TEST POLICY: tests that call the external Gorouter.app service are excluded
   from the automated suite. NVIDIA / TokenHarbor-based verification stays. */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    exclude: [
      ...configDefaults.exclude,
      'tests/gorouter.test.ts',
    ],
    env: {
      DATA_DIR: testDataDir,
    },
  },
});
