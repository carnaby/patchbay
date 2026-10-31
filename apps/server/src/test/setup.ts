import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';

// Tests that build createDeps must not pick up the repository's real showcase/ (its media, its dashboards): the
// config default is swapped for an empty folder. A test that sets SHOWCASE_DIR itself is not affected, and the
// loader stays real, so budget.test.ts checks the real folder.
const repoShowcase = resolve(import.meta.dirname, '../../../../showcase');
const empty = mkdtempSync(join(tmpdir(), 'pb-no-showcase-'));

vi.mock('../config.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.ts')>();
  return {
    ...real,
    loadConfig: (...args: Parameters<typeof real.loadConfig>) => {
      const config = real.loadConfig(...args);
      return resolve(config.showcaseDir) === repoShowcase ? { ...config, showcaseDir: empty } : config;
    },
  };
});
