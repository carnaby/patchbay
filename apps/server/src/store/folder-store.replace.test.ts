/**
 * Reads during a replace, on file systems where rename over an existing file is not atomic (Windows, and the Windows
 * folders Docker Desktop mounts into containers): there the file is briefly missing to a reader, or locked to the
 * writer. Simulated here, so the test means the same on every platform.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor, emptyDashboard } from '@patchbay/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replacing = vi.hoisted(() => ({ missing: 0, locked: 0, path: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    ...fs,
    stat: (async (path: string, ...rest: unknown[]) => {
      if (replacing.missing > 0 && String(path).endsWith(replacing.path)) {
        replacing.missing--;
        throw fail('ENOENT');
      }
      return (fs.stat as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.stat,
    readFile: (async (path: string, ...rest: unknown[]) => {
      if (replacing.missing > 0 && String(path).endsWith(replacing.path)) {
        replacing.missing--;
        throw fail('ENOENT');
      }
      return (fs.readFile as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFile,
    rename: (async (from: string, to: string) => {
      if (replacing.locked > 0 && String(to).endsWith(replacing.path)) {
        replacing.locked--;
        throw fail('EPERM');
      }
      return fs.rename(from, to);
    }) as typeof fs.rename,
  };
});

const { FolderStore } = await import('./folder-store.ts');

const actor: Actor = { kind: 'anonymous', label: 'Anonymous' };
let dir: string;
let store: InstanceType<typeof FolderStore>;

const meta = (id: string, version = 1) => {
  const at = new Date(Date.UTC(2026, 0, 1, 0, version)).toISOString();
  return {
    id,
    ownerId: null,
    ownerEmail: null,
    visibility: 'public' as const,
    editKeyHash: null,
    version,
    createdAt: at,
    updatedAt: at,
    lastViewedAt: at,
  };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-replace-'));
  store = new FolderStore(dir);
  await store.init();
  replacing.missing = 0;
  replacing.locked = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a file being replaced', () => {
  it('is still found by readers, document and meta alike', async () => {
    await store.create(meta('abcdefgh'), emptyDashboard('Sales'), actor, ['create']);
    replacing.path = 'dashboard.json';
    replacing.missing = 2;
    expect((await store.readDoc('abcdefgh'))?.title).toBe('Sales');
    replacing.path = 'meta.json';
    replacing.missing = 2;
    expect((await store.readMeta('abcdefgh'))?.version).toBe(1);
  });

  it('is written once the readers that lock it let go', async () => {
    await store.create(meta('abcdefgh'), emptyDashboard('Sales'), actor, ['create']);
    replacing.path = 'dashboard.json';
    replacing.locked = 3;
    await store.writeDoc(meta('abcdefgh', 2), emptyDashboard('Renamed'), actor, ['rename']);
    expect((await store.readDoc('abcdefgh'))?.title).toBe('Renamed');
  });

  it('does not keep a deleted dashboard waiting', async () => {
    replacing.path = 'meta.json';
    replacing.missing = 100;
    const started = Date.now();
    expect(await store.readMeta('missing0')).toBeNull();
    // 100 failing attempts would take seconds; a missing file must answer at once, not after retrying.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
