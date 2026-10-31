/** The repository's showcase: trusted source URLs under URL_SOURCES=signed-in (more blocks are added below). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type UseCaseInfo, useCaseDashboardId } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps, syncShowcaseUseCases } from './app.ts';
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
    const theirs = await svc.get('scmorningboard', signedIn());
    expect(theirs.meta.ownerId).not.toBe('system');
    expect(theirs.meta.version).toBe(1);
    expect(theirs.doc.title).toBe(buildTemplate('blank').title);
    expect(warnings).toHaveLength(1);
  });

  it('rewrites a stored showcase document that no longer parses', async () => {
    const svc = makeService();
    const uc = fixtureUseCase('morning-board');
    await svc.syncShowcase([uc]);
    writeFileSync(join(deps.store.dir('scmorningboard'), 'dashboard.json'), '{ not json');
    const warnings: string[] = [];
    const result = await svc.syncShowcase([uc], (m) => warnings.push(m));
    expect(result.updated).toEqual(['scmorningboard']);
    expect(warnings).toHaveLength(1);
    const env = await svc.get('scmorningboard', anonymous());
    expect(env.meta.version).toBe(2);
    expect(env.doc.title).toBe(uc.doc.title);
  });

  it('skips with a warning, and does not throw, when the stored meta is corrupt', async () => {
    const svc = makeService();
    const both = [fixtureUseCase('morning-board'), fixtureUseCase('second-board')];
    await svc.syncShowcase(both);
    writeFileSync(join(deps.store.dir('scmorningboard'), 'meta.json'), '{ nope');
    const warnings: string[] = [];
    const result = await svc.syncShowcase(both, (m) => warnings.push(m));
    expect(result.skipped).toEqual(['scmorningboard']);
    expect(warnings).toHaveLength(1);
    await deps.store.remove('scsecondboard');
    deps.index.remove('scsecondboard');
  });

  it('keeps a skipped use case out of deps.useCases', async () => {
    await createWithId('scmorningboard', signedIn());
    const fake = {
      useCases: [fixtureUseCase('morning-board')],
      dashboards: makeService(),
    } as unknown as Deps;
    const warnings: string[] = [];
    await syncShowcaseUseCases(fake, (m) => warnings.push(m));
    expect(fake.useCases).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('survives a sync that throws as a whole', async () => {
    const fake = {
      useCases: [fixtureUseCase('morning-board')],
      dashboards: {
        syncShowcase: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Deps;
    const warnings: string[] = [];
    await expect(syncShowcaseUseCases(fake, (m) => warnings.push(m))).resolves.toBeDefined();
    expect(fake.useCases).toEqual([]);
    expect(warnings.join()).toMatch(/boom/);
  });

  it('is never removed by an admin prune of all dashboards', async () => {
    const svc = makeService();
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    const cutoff = new Date(Date.now() + 86_400_000).toISOString();
    expect(deps.index.idsViewedBefore(cutoff, false)).not.toContain('scmorningboard');
    expect(await svc.prune({ olderThanDays: 0, onlyAnonymous: false })).not.toContain('scmorningboard');
  });

  it('refuses every write path that bypasses applyOps', async () => {
    const svc = makeService();
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    const id = 'scmorningboard';
    const before = await svc.get(id, anonymous());
    const admin = signedIn('admin2@example.com', { isAdmin: true });
    const user = signedIn('someone@example.com');
    const file = { name: 'a.csv', content: 'a\n1' };
    await expect(svc.setVisibility(id, user, 'private')).rejects.toThrow();
    await expect(svc.setVisibility(id, admin, 'private')).rejects.toThrow();
    await expect(svc.claim(id, user)).rejects.toThrow();
    await expect(svc.claim(id, anonymous())).rejects.toThrow();
    await expect(svc.restore(id, user, 1)).rejects.toThrow();
    await expect(svc.restore(id, admin, 1)).rejects.toThrow();
    await expect(svc.uploadFile(id, user, file)).rejects.toThrow();
    await expect(svc.uploadFile(id, admin, file)).rejects.toThrow();
    await expect(svc.delete(id, user)).rejects.toThrow();
    await expect(svc.delete(id, anonymous())).rejects.toThrow();
    const after = await svc.get(id, anonymous());
    expect(after.meta).toMatchObject({
      ownerId: 'system',
      visibility: 'public',
      version: before.meta.version,
    });
    expect(after.doc).toEqual(before.doc);
  });

  it('is not counted as anonymous storage and not pruned', async () => {
    const svc = makeService({ anonymousStorageBytes: 1 });
    await svc.syncShowcase([fixtureUseCase('morning-board')]);
    expect(await svc.prune({ olderThanDays: 0, onlyAnonymous: true })).not.toContain('scmorningboard');
    expect(await svc.pruneUntouched({ olderThanHours: 0 })).not.toContain('scmorningboard');
  });
});

describe('showcase routes', () => {
  let routeDir: string;
  let routeDeps: Deps;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    routeDir = mkdtempSync(join(tmpdir(), 'patchbay-showcase-routes-'));
    const showcaseDir = join(routeDir, 'showcase');
    for (const [order, id] of [
      [1, 'with-video'],
      [2, 'no-video'],
    ] as const) {
      const base = join(showcaseDir, id);
      mkdirSync(base, { recursive: true });
      writeFileSync(
        join(base, 'meta.json'),
        JSON.stringify({ id, order, title: id, tab: 'Fixture', description: 'Fixture use case' }),
      );
      writeFileSync(join(base, 'prompt.md'), 'Build a board');
      writeFileSync(join(base, 'dashboard.json'), JSON.stringify(buildTemplate('blank')));
    }
    writeFileSync(join(showcaseDir, 'with-video', 'video.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(showcaseDir, 'with-video', 'poster.jpg'), Buffer.from('jpegdata'));
    routeDeps = await createDeps(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: join(routeDir, 'data'),
        OFFLINE: '1',
        PUBLIC_URL: 'http://localhost:8787',
        SHOWCASE_DIR: showcaseDir,
      }),
    );
    await syncShowcaseUseCases(routeDeps);
    app = createApp(routeDeps);
  });

  afterAll(async () => {
    routeDeps.hub.close();
    await routeDeps.pipeline.close();
    routeDeps.db.close();
    rmSync(routeDir, { recursive: true, force: true });
  });

  it('lists use cases with media URLs carrying cache keys', async () => {
    const res = await app.request('/api/use-cases');
    expect(res.status).toBe(200);
    const list = (await res.json()) as UseCaseInfo[];
    expect(list.map((u) => u.id)).toEqual(['with-video', 'no-video']);
    expect(list[0]!.video).toMatch(/^\/showcase\/with-video\/video\.mp4\?v=[a-f0-9]{16}$/);
    expect(list[1]).toMatchObject({ video: null, poster: null, dashboardId: 'scnovideo' });
  });

  it('redirects a slug to its dashboard and 404s unknown or odd slugs', async () => {
    const res = await app.request('/showcase/with-video');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/d/scwithvideo');
    for (const p of [
      '/showcase/nope',
      '/showcase/..%2F..%2Fetc',
      '/showcase/no-video/video.mp4',
      '/showcase/with-video/video.mp4/extra',
      '/showcase/no-video/poster.jpg',
    ])
      expect((await app.request(p)).status).toBe(404);
  });

  it('serves video with ranges and keeps its own caching headers', async () => {
    const res = await app.request('/showcase/with-video/video.mp4', { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await res.text()).toBe('0123');
  });

  it('serves the poster', async () => {
    const res = await app.request('/showcase/with-video/poster.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('jpegdata');
  });

  it('answers 304 when the etag matches', async () => {
    const first = await app.request('/showcase/with-video/video.mp4');
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const res = await app.request('/showcase/with-video/video.mp4', { headers: { 'if-none-match': etag } });
    expect(res.status).toBe(304);
  });

  it('answers HEAD without a body', async () => {
    const res = await app.request('/showcase/with-video/video.mp4', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
  });
});

describe('trusted URLs through the whole app', () => {
  let wireDir: string;
  let wireDeps: Deps;
  let app: ReturnType<typeof createApp>;
  const OTHER = 'https://example.org/other.xml';

  beforeAll(async () => {
    wireDir = mkdtempSync(join(tmpdir(), 'patchbay-showcase-wire-'));
    const base = join(wireDir, 'showcase', 'news');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, 'meta.json'),
      JSON.stringify({ id: 'news', order: 1, title: 'News', tab: 'News', description: 'Feed.' }),
    );
    writeFileSync(join(base, 'prompt.md'), 'Build a news board');
    writeFileSync(
      join(base, 'dashboard.json'),
      JSON.stringify({ ...buildTemplate('blank'), datasets: [feedDataset(FEED)] }),
    );
    wireDeps = await createDeps(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: join(wireDir, 'data'),
        OFFLINE: '1',
        URL_SOURCES: 'signed-in',
        PUBLIC_URL: 'http://localhost:8787',
        SHOWCASE_DIR: join(wireDir, 'showcase'),
        PIPELINE_WORKERS: '0',
      }),
    );
    await syncShowcaseUseCases(wireDeps);
    app = createApp(wireDeps);
  });

  afterAll(async () => {
    wireDeps.hub.close();
    await wireDeps.pipeline.close();
    wireDeps.db.close();
    rmSync(wireDir, { recursive: true, force: true });
  });

  it('lets an anonymous copy load the trusted feed but not take another URL', async () => {
    expect(wireDeps.useCases.map((u) => u.meta.id)).toEqual(['news']);
    const copy = await wireDeps.dashboards.duplicate('scnews', anonymous());
    const id = copy.envelope.meta.id;
    const key = { 'x-edit-key': copy.editKey! };

    const ok = await app.request(`/api/dashboards/${id}/data/news`, { headers: key });
    expect(ok.status).toBe(200);
    // A refused source does not fail the request: DataService.resolve reports it in the result's error.
    const body = (await ok.json()) as { error?: string; table: { rows: unknown[] } };
    expect(body.error).toBeUndefined();
    expect(body.table.rows.length).toBeGreaterThan(0);

    const retarget = await app.request(`/api/dashboards/${id}/ops`, {
      method: 'POST',
      headers: { ...key, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [setSource(OTHER)] }),
    });
    expect(retarget.status).toBe(400);
  });

  it('refuses an anonymous dashboard that reads a different URL', async () => {
    const at = now();
    const meta: StoredMeta = {
      id: 'anonother1',
      ownerId: null,
      ownerEmail: null,
      visibility: 'public',
      editKeyHash: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      lastViewedAt: at,
      lastActor: { kind: 'user', label: 'test' },
    };
    const doc = { ...buildTemplate('blank'), datasets: [feedDataset(OTHER)] };
    await wireDeps.store.create(meta, doc as never, meta.lastActor!, ['Created']);
    wireDeps.index.upsert(meta, { title: doc.title, widgets: 0 });
    const res = await app.request('/api/dashboards/anonother1/data/news');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/signed-in|sign/i);
  });
});
