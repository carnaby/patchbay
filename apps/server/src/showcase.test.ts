/** The repository's showcase: trusted source URLs under URL_SOURCES=signed-in (more blocks are added below). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { DashboardService, type Principal } from './services/dashboards.ts';

let dir: string;
let deps: Deps;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-showcase-'));
  deps = await createDeps(
    loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, OFFLINE: '1', PUBLIC_URL: 'http://localhost:8787' }),
  );
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A service over the shared stores, so only the options under test differ from the app's own. */
function makeService(options: ConstructorParameters<typeof DashboardService>[5] = {}) {
  return new DashboardService(
    deps.store,
    deps.index,
    deps.hub,
    deps.connectors,
    { store: deps.secrets, mode: deps.config.secrets.mode, users: deps.users },
    options,
  );
}

const anonymous = (editKey?: string): Principal => ({ user: null, isAdmin: false, viaToken: false, editKey });

function signedIn(email: string): Principal {
  return { user: deps.users.upsert({ email, name: email }), isAdmin: false, viaToken: false };
}

const FEED = 'https://example.org/rss';
const feedDataset = (url: string) => ({
  id: 'news',
  name: 'News',
  refreshSec: 900,
  transforms: [],
  source: { kind: 'feed', url, limit: 30 },
});
const setSource = (url: string) => ({
  op: 'updateDataset',
  id: 'news',
  set: { source: { kind: 'feed', url, limit: 30 } },
});

describe('trusted showcase URLs', () => {
  it('lets an anonymous dashboard add exactly a trusted URL and nothing else', async () => {
    const svc = makeService({ urlSources: 'signed-in', trustedUrls: new Set([FEED]) });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    const p = anonymous(editKey);
    const id = envelope.meta.id;
    await expect(
      svc.applyOps(id, p, [{ op: 'addDataset', dataset: feedDataset(FEED) }]),
    ).resolves.toBeDefined();
    for (const url of [`${FEED}?x=1`, `${FEED}/`, 'https://example.org/rss2']) {
      await expect(svc.applyOps(id, p, [setSource(url)])).rejects.toThrow(/sign/i);
    }
  });

  it('allows fetching a trusted URL for an anonymous target and refuses any other', () => {
    const svc = makeService({ urlSources: 'signed-in', trustedUrls: new Set([FEED]) });
    const target = { id: 'abcdef123456', ownerId: null };
    expect(() => svc.assertMayFetchUrl(target, FEED)).not.toThrow();
    expect(() => svc.assertMayFetchUrl(target, `${FEED}?x=1`)).toThrow();
  });

  it('leaves signed-in owners and URL_SOURCES=everyone unaffected', async () => {
    const strict = makeService({ urlSources: 'signed-in', trustedUrls: new Set([FEED]) });
    const owner = signedIn('owner@example.com');
    const { envelope } = await strict.create(owner, {});
    await expect(
      strict.applyOps(envelope.meta.id, owner, [
        { op: 'addDataset', dataset: feedDataset('https://other.example/feed') },
      ]),
    ).resolves.toBeDefined();
    expect(() =>
      strict.assertMayFetchUrl({ id: 'abcdef123456', ownerId: owner.user!.id }, 'https://x.example/'),
    ).not.toThrow();

    const open = makeService({ urlSources: 'everyone' });
    expect(() =>
      open.assertMayFetchUrl({ id: 'abcdef123456', ownerId: null }, 'https://x.example/'),
    ).not.toThrow();
  });
});
