import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';

// Tests that build createDeps must not pick up the repository's real showcase/ (its media, its dashboards): the
// default folder is swapped for an empty one. A test that sets SHOWCASE_DIR itself is not affected.
const repoShowcase = resolve(import.meta.dirname, '../../../../showcase');
const empty = mkdtempSync(join(tmpdir(), 'pb-no-showcase-'));

vi.mock('../showcase/load.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../showcase/load.ts')>();
  return {
    ...real,
    loadUseCases: (dir: string, warn?: (m: string) => void) =>
      real.loadUseCases(resolve(dir) === repoShowcase ? empty : dir, warn),
  };
});
