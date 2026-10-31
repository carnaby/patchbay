/** The repository's showcase: trusted source URLs under URL_SOURCES=signed-in (more blocks are added below). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCaseDashboardId } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { now } from './db.ts';
import { DashboardService, type Principal } from './services/dashboards.ts';
import { buildTemplate } from './services/templates.ts';
import type { UseCase } from './showcase/load.ts';
import type { StoredMeta } from './store/folder-store.ts';

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

function signedIn(email = 'visitor@example.com', extra: Partial<Principal> = {}): Principal {
  return { user: deps.users.upsert({ email, name: email }), isAdmin: false, viaToken: false, ...extra };
}

/** An agent: a signed-in user acting through a bearer token. */
const withToken = (): Principal => signedIn('agent@example.com', { viaToken: true });

/** A use case built the way loadUseCases would, from a real template so the document is valid. */
function fixtureUseCase(id: string): UseCase {
  return {
    meta: { id, order: 1, title: id, tab: 'Fixture', description: 'Fixture use case' },
    prompt: 'Build a board',
    doc: buildTemplate('blank'),
    dashboardId: useCaseDashboardId(id),
    video: null,
    poster: null,
  } as UseCase;
}

/** Writes a dashboard with a chosen id through the store, as another owner's dashboard would exist. */
async function createWithId(id: string, owner: Principal) {
  const at = now();
  const meta: StoredMeta = {
    id,
    ownerId: owner.user!.id,
    ownerEmail: owner.user!.email,
    visibility: 'public',
    editKeyHash: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    lastViewedAt: at,
    lastActor: { kind: 'user', label: 'test' },
  };
  const doc = buildTemplate('blank');
  await deps.store.create(meta, doc, meta.lastActor!, ['Created']);
  deps.index.upsert(meta, { title: doc.title, widgets: doc.widgets.length });
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

describe('syncShowcase', () => {
  // The tests share one data dir and one dashboard id, so each starts from nothing.
  afterEach(async () => {
    await deps.store.remove('scmorningboard');
    deps.index.remove('scmorningboard');
  });

  it('creates a public read-only dashboard owned by system, then updates it only on change', async () => {
    const svc = makeService();
    const uc = fixtureUseCase('morning-board');
    expect(await svc.syncShowcase([uc])).toEqual({ created: ['scmorningboard'], updated: [], skipped: [] });
    expect(await svc.syncShowcase([uc])).toEqual({ created: [], updated: [], skipped: [] });
    const changed = { ...uc, doc: { ...uc.doc, title: 'New title' } };
    expect((await svc.syncShowcase([changed])).updated).toEqual(['scmorningboard']);

    const env = await svc.get('scmorningboard', anonymous());
    expect(env.meta).toMatchObject({ ownerId: 'system', visibility: 'public', version: 2 });
    expect(env.access.canEdit).toBe(false);
    expect(env.meta.lastActor?.kind).toBe('system');
  });

  it('is read-only for anonymous visitors, signed-in users, tokens and admins', async () => {
    const svc = makeService();
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    for (const p of [
      anonymous(),
      anonymous('pbk_guess'),
      signedIn(),
      signedIn('admin@example.com', { isAdmin: true }),
      withToken(),
    ]) {
      await expect(svc.applyOps('scmorningboard', p, [{ op: 'setMeta', title: 'x' }])).rejects.toThrow();
    }
  });

  it('lets anyone make an editable copy', async () => {
    const svc = makeService();
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    const copy = await svc.duplicate('scmorningboard', anonymous());
    expect(copy.envelope.meta.ownerId).toBeNull();
    expect(copy.editKey).toBeDefined();
    expect(copy.envelope.access.canEdit).toBe(true);
  });

  it('never takes over an id that someone else already owns', async () => {
    const svc = makeService();
    await createWithId('scmorningboard', signedIn());
    const warnings: string[] = [];
    const result = await svc.syncShowcase([fixtureUseCase('morning-board')], (m) => warnings.push(m));
    expect(result.skipped).toEqual(['scmorningboard']);
    expect((await svc.get('scmorningboard', signedIn())).meta.ownerId).not.toBe('system');
    expect(warnings).toHaveLength(1);
  });

  it('is not counted as anonymous storage and not pruned', async () => {
    const svc = makeService({ anonymousStorageBytes: 1 });
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    expect(await svc.prune({ olderThanDays: 0, onlyAnonymous: true })).not.toContain('scmorningboard');
    expect(await svc.pruneUntouched({ olderThanHours: 0 })).not.toContain('scmorningboard');
  });
});
