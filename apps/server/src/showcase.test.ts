/** The repository's showcase: trusted source URLs under URL_SOURCES=signed-in (more blocks are added below). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type UseCaseInfo, useCaseDashboardId } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps, syncShowcaseUseCases } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { now } from './db.ts';
import { DashboardService, type Principal } from './services/dashboards.ts';
import { buildTemplate } from './services/templates.ts';
import type { UseCase } from './showcase/load.ts';
import { type SourceRequest, sourceTrustKey } from './showcase/trust.ts';
import type { StoredMeta } from './store/folder-store.ts';

// Counts the requests an http source would send upstream; feeds use another function and stay real.
const upstreamJson = vi.hoisted(() => vi.fn(async () => [{ a: 1 }]));
vi.mock('./util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('./util/safe-fetch.ts')>()),
  safeFetchJson: upstreamJson,
}));

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
    meta: { id, order: 1, title: id, tab: 'Fixture', description: 'Fixture use case', featured: true },
    prompt: 'Build a board',
    doc: buildTemplate('blank'),
    dashboardId: useCaseDashboardId(id),
    video: null,
    videoSquare: null,
    poster: null,
    attachment: null,
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
const trusted = (...requests: SourceRequest[]) => new Set(requests.map(sourceTrustKey));
const GQL = 'https://gitlab.example/api/graphql';
const QUERY = { query: '{ project(fullPath: "a/b") { name } }' };
const postDataset = (body: unknown) => ({
  id: 'gql',
  name: 'GraphQL',
  refreshSec: 300,
  transforms: [],
  source: { kind: 'http', url: GQL, method: 'POST', body },
});
const setPostBody = (body: unknown) => ({
  op: 'updateDataset',
  id: 'gql',
  set: { source: { kind: 'http', url: GQL, method: 'POST', body } },
});

describe('trusted showcase URLs', () => {
  it('lets an anonymous dashboard add exactly a trusted URL and nothing else', async () => {
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: FEED, method: 'GET' }),
    });
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
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: FEED, method: 'GET' }),
    });
    const target = { id: 'abcdef123456', ownerId: null };
    expect(() => svc.assertMayFetchUrl(target, FEED)).not.toThrow();
    expect(() => svc.assertMayFetchUrl(target, `${FEED}?x=1`)).toThrow();
  });

  it('trusts a showcase URL for GET only: a POST to it is refused when saved and when fetched', async () => {
    const API_URL = 'https://api.example.com/v1/trusted';
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: API_URL, method: 'GET' }),
    });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    const p = anonymous(editKey);
    const id = envelope.meta.id;
    const dataset = {
      id: 'api',
      name: 'API',
      refreshSec: 0,
      transforms: [],
      source: { kind: 'http', url: API_URL },
    };
    await expect(svc.applyOps(id, p, [{ op: 'addDataset', dataset }])).resolves.toBeDefined();
    await expect(
      svc.applyOps(id, p, [
        {
          op: 'updateDataset',
          id: 'api',
          set: { source: { kind: 'http', url: API_URL, method: 'POST', body: { q: 1 } } },
        },
      ]),
    ).rejects.toThrow(/sign/i);
    const target = { id: 'abcdef123456', ownerId: null };
    expect(() => svc.assertMayFetchUrl(target, API_URL)).not.toThrow();
    expect(() => svc.assertMayFetchUrl(target, API_URL, 'POST')).toThrow(/sign/i);
  });

  it('trusts the exact showcase POST: same address and body, when saved and when fetched', async () => {
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: GQL, method: 'POST', body: QUERY }),
    });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    await expect(
      svc.applyOps(envelope.meta.id, anonymous(editKey), [{ op: 'addDataset', dataset: postDataset(QUERY) }]),
    ).resolves.toBeDefined();
    const target = { id: 'abcdef123456', ownerId: null };
    expect(() => svc.assertMayFetchUrl(target, GQL, 'POST', QUERY)).not.toThrow();
    expect(() => svc.assertMayFetchUrl(target, GQL, 'POST', JSON.parse(JSON.stringify(QUERY)))).not.toThrow();
  });

  it('refuses a POST whose body differs in any way, and the trusted address with another method', async () => {
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: GQL, method: 'POST', body: { a: 1, b: 2 } }),
    });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    const id = envelope.meta.id;
    const p = anonymous(editKey);
    await svc.applyOps(id, p, [{ op: 'addDataset', dataset: postDataset({ a: 1, b: 2 }) }]);
    const target = { id: 'abcdef123456', ownerId: null };
    for (const body of [{ b: 2, a: 1 }, { a: 1, b: 2, c: 3 }, { a: 1, b: '2' }, { a: 1 }]) {
      await expect(svc.applyOps(id, p, [setPostBody(body)])).rejects.toThrow(/sign/i);
      expect(() => svc.assertMayFetchUrl(target, GQL, 'POST', body)).toThrow(/sign/i);
    }
    expect(() => svc.assertMayFetchUrl(target, GQL, 'POST')).toThrow(/sign/i);
    expect(() => svc.assertMayFetchUrl(target, GQL)).toThrow(/sign/i);
    expect(() => svc.assertMayFetchUrl(target, `${GQL}?x=1`, 'POST', { a: 1, b: 2 })).toThrow(/sign/i);
  });

  it('refuses a body with a filter reference even when it would bind to the trusted text', async () => {
    // A short query, so the filter's option value is valid and the only refusal left is the URL_SOURCES one.
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: GQL, method: 'POST', body: { query: '{ a }' } }),
    });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    const p = anonymous(editKey);
    await expect(
      svc.applyOps(envelope.meta.id, p, [
        {
          op: 'addParameter',
          parameter: {
            id: 'q',
            label: 'Query',
            type: 'select',
            options: [{ value: '{ a }' }],
            default: '{ a }',
          },
        },
        { op: 'addDataset', dataset: postDataset({ query: '$param.q' }) },
      ]),
    ).rejects.toThrow(/sign/i);
  });

  it('refuses a copy that changes only the path of a trusted GET source, at save and at fetch', async () => {
    const svc = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: FEED, method: 'GET', path: 'data.items' }),
    });
    const { envelope, editKey } = await svc.create(anonymous(), {});
    const id = envelope.meta.id;
    const p = anonymous(editKey);
    const source = (path?: string) => ({
      kind: 'http',
      url: FEED,
      ...(path !== undefined ? { path } : {}),
    });
    const dataset = (path?: string) => ({ id: 'rows', name: 'Rows', transforms: [], source: source(path) });
    await expect(
      svc.applyOps(id, p, [{ op: 'addDataset', dataset: dataset('data.items') }]),
    ).resolves.toBeDefined();
    for (const path of [undefined, 'data.other', 'data.items ', '']) {
      await expect(
        svc.applyOps(id, p, [{ op: 'updateDataset', id: 'rows', set: { source: source(path) } }]),
      ).rejects.toThrow(/sign/i);
    }
    const target = { id: 'abcdef123456', ownerId: null };
    expect(() => svc.assertMayFetchUrl(target, FEED, 'GET', undefined, 'data.items')).not.toThrow();
    for (const path of [undefined, 'data.other', '']) {
      expect(() => svc.assertMayFetchUrl(target, FEED, 'GET', undefined, path)).toThrow(/sign/i);
    }
  });

  it('leaves signed-in owners and URL_SOURCES=everyone unaffected', async () => {
    const strict = makeService({
      urlSources: 'signed-in',
      trustedSources: trusted({ url: FEED, method: 'GET' }),
    });
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
  const CSV = 'day,units\n1,2\n2,3\n';
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
      const attachment = id === 'with-video' ? { attachment: 'sales.csv' } : {};
      writeFileSync(
        join(base, 'meta.json'),
        JSON.stringify({
          id,
          order,
          title: id,
          tab: 'Fixture',
          description: 'Fixture use case',
          ...attachment,
        }),
      );
      writeFileSync(join(base, 'prompt.md'), 'Build a board');
      writeFileSync(join(base, 'dashboard.json'), JSON.stringify(buildTemplate('blank')));
    }
    // Out of the tab row, still a working use case: its link, dashboard and media stay.
    const aside = join(showcaseDir, 'aside-case');
    mkdirSync(aside, { recursive: true });
    writeFileSync(
      join(aside, 'meta.json'),
      JSON.stringify({
        id: 'aside-case',
        order: 0,
        title: 'Aside',
        tab: 'Aside',
        description: 'Not in the tab row',
        featured: false,
      }),
    );
    writeFileSync(join(aside, 'prompt.md'), 'Build a board');
    writeFileSync(join(aside, 'dashboard.json'), JSON.stringify(buildTemplate('blank')));
    writeFileSync(join(aside, 'video.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(showcaseDir, 'with-video', 'video.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(showcaseDir, 'with-video', 'poster.jpg'), Buffer.from('jpegdata'));
    writeFileSync(join(showcaseDir, 'with-video', 'video-square.mp4'), Buffer.from('abcdefgh'));
    writeFileSync(join(showcaseDir, 'with-video', 'sales.csv'), CSV);
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

  it('keeps an unfeatured use case out of the list, and its dashboard, link and media working', async () => {
    const list = (await (await app.request('/api/use-cases')).json()) as UseCaseInfo[];
    expect(list.map((u) => u.id)).not.toContain('aside-case');
    expect(routeDeps.useCases.map((u) => u.meta.id)).toContain('aside-case');
    const link = await app.request('/showcase/aside-case');
    expect(link.status).toBe(302);
    expect(link.headers.get('location')).toBe('/d/scasidecase');
    const video = await app.request('/showcase/aside-case/video.mp4', { headers: { range: 'bytes=0-1' } });
    expect(video.status).toBe(206);
    const dash = await app.request('/api/dashboards/scasidecase');
    expect(dash.status).toBe(200);
  });

  it('lists use cases with media URLs carrying cache keys', async () => {
    const res = await app.request('/api/use-cases');
    expect(res.status).toBe(200);
    const list = (await res.json()) as UseCaseInfo[];
    expect(list.map((u) => u.id)).toEqual(['with-video', 'no-video']);
    expect(list[0]!.video).toMatch(/^\/showcase\/with-video\/video\.mp4\?v=[a-f0-9]{16}$/);
    expect(list[0]!.videoSquare).toMatch(/^\/showcase\/with-video\/video-square\.mp4\?v=[a-f0-9]{16}$/);
    expect(list[0]!.attachment).toMatchObject({ name: 'sales.csv', rows: 2, bytes: CSV.length });
    expect(list[0]!.attachment!.url).toMatch(/^\/showcase\/with-video\/sales\.csv\?v=[a-f0-9]{16}$/);
    expect(list[1]).toMatchObject({
      video: null,
      videoSquare: null,
      poster: null,
      attachment: null,
      dashboardId: 'scnovideo',
    });
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
      '/showcase/no-video/video-square.mp4',
      '/showcase/no-video/sales.csv',
      // Only the declared attachment is served, never the folder's other files.
      '/showcase/with-video/other.csv',
      '/showcase/with-video/meta.json',
      '/showcase/with-video/prompt.md',
      '/showcase/with-video/dashboard.json',
      '/showcase/with-video/sales.csv/extra',
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

  it('serves the square video with ranges', async () => {
    const res = await app.request('/showcase/with-video/video-square.mp4', {
      headers: { range: 'bytes=2-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('cde');
  });

  it('serves the attachment as a CSV download', async () => {
    const res = await app.request('/showcase/with-video/sales.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="sales.csv"');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    // A browser must never sniff it into something it would render.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(CSV);
  });

  it('answers HEAD on the attachment without a body', async () => {
    const res = await app.request('/showcase/with-video/sales.csv', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(CSV.length));
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="sales.csv"');
    expect(await res.text()).toBe('');
  });

  it('matches the attachment name exactly, never as a path or case-insensitively', async () => {
    for (const p of [
      '/showcase/with-video/..%2Fmeta.json',
      '/showcase/with-video/..%2Fwith-video%2Fsales.csv',
      '/showcase/with-video/SALES.csv',
      '/showcase/with-video/sales.CSV',
    ])
      expect((await app.request(p)).status, p).toBe(404);
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

  it('refuses an anonymous POST preview to a trusted URL, while a GET to it still loads', async () => {
    // The use-time check is the only guard for a preview, and it works only if app.ts hands over the method.
    const copy = await wireDeps.dashboards.duplicate('scnews', anonymous());
    const preview = (dataset: object) =>
      app.request(`/api/dashboards/${copy.envelope.meta.id}/preview`, {
        method: 'POST',
        headers: { 'x-edit-key': copy.editKey!, 'content-type': 'application/json' },
        body: JSON.stringify({ dataset }),
      });
    upstreamJson.mockClear();

    const post = await preview({ source: { kind: 'http', url: FEED, method: 'POST', body: { q: 1 } } });
    expect(JSON.stringify(await post.json())).toMatch(/Sign in/);
    expect(upstreamJson).not.toHaveBeenCalled();

    const get = await preview({ source: { kind: 'http', url: FEED } });
    expect(get.status).toBe(200);
    // The preview answers { result, profile, suggestions }: a refusal would be result.error.
    const { result } = (await get.json()) as { result: { error?: string; table: { rows: unknown[] } } };
    expect(result.error).toBeUndefined();
    expect(result.table.rows.length).toBeGreaterThan(0);
    expect(upstreamJson).toHaveBeenCalledTimes(1);
  });
});

describe('a trusted showcase POST through the whole app', () => {
  let postDir: string;
  let postDeps: Deps;
  let postApp: ReturnType<typeof createApp>;

  beforeAll(async () => {
    postDir = mkdtempSync(join(tmpdir(), 'patchbay-showcase-post-'));
    const base = join(postDir, 'showcase', 'graph-demo');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, 'meta.json'),
      JSON.stringify({ id: 'graph-demo', order: 1, title: 'Graph', tab: 'Graph', description: 'GraphQL.' }),
    );
    writeFileSync(join(base, 'prompt.md'), 'Build a GraphQL board');
    writeFileSync(
      join(base, 'dashboard.json'),
      JSON.stringify({ ...buildTemplate('blank'), datasets: [postDataset(QUERY)] }),
    );
    // A second use case whose POST also has a `path`: that part of the request must be trusted as well.
    const pathed = join(postDir, 'showcase', 'graph-path');
    mkdirSync(pathed, { recursive: true });
    writeFileSync(
      join(pathed, 'meta.json'),
      JSON.stringify({ id: 'graph-path', order: 2, title: 'Pathed', tab: 'Pathed', description: 'GraphQL.' }),
    );
    writeFileSync(join(pathed, 'prompt.md'), 'Build a pathed GraphQL board');
    writeFileSync(
      join(pathed, 'dashboard.json'),
      JSON.stringify({
        ...buildTemplate('blank'),
        datasets: [{ ...postDataset(QUERY), source: { ...postDataset(QUERY).source, path: 'data.items' } }],
      }),
    );
    postDeps = await createDeps(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: join(postDir, 'data'),
        OFFLINE: '1',
        URL_SOURCES: 'signed-in',
        PUBLIC_URL: 'http://localhost:8787',
        SHOWCASE_DIR: join(postDir, 'showcase'),
        PIPELINE_WORKERS: '0',
      }),
    );
    await syncShowcaseUseCases(postDeps);
    postApp = createApp(postDeps);
  });

  afterAll(async () => {
    postDeps.hub.close();
    await postDeps.pipeline.close();
    postDeps.db.close();
    rmSync(postDir, { recursive: true, force: true });
  });

  it('lets an anonymous copy load the showcase POST and refuses a copy that changes its body', async () => {
    const copy = await postDeps.dashboards.duplicate('scgraphdemo', anonymous());
    const id = copy.envelope.meta.id;
    const key = { 'x-edit-key': copy.editKey! };
    upstreamJson.mockClear();
    const ok = await postApp.request(`/api/dashboards/${id}/data/gql`, { headers: key });
    const body = (await ok.json()) as { error?: string; table: { rows: unknown[] } };
    expect(body.error).toBeUndefined();
    expect(body.table.rows.length).toBeGreaterThan(0);
    expect(upstreamJson).toHaveBeenCalledWith(GQL, expect.objectContaining({ method: 'POST', body: QUERY }));

    const changed = await postApp.request(`/api/dashboards/${id}/ops`, {
      method: 'POST',
      headers: { ...key, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [setPostBody({ query: '{ currentUser { username } }' })] }),
    });
    expect(changed.status).toBe(400);
  });

  it('previews the exact showcase POST for an anonymous copy and refuses any other body unsent', async () => {
    const copy = await postDeps.dashboards.duplicate('scgraphdemo', anonymous());
    const preview = (dataset: object) =>
      postApp.request(`/api/dashboards/${copy.envelope.meta.id}/preview`, {
        method: 'POST',
        headers: { 'x-edit-key': copy.editKey!, 'content-type': 'application/json' },
        body: JSON.stringify({ dataset }),
      });
    upstreamJson.mockClear();
    const other = await preview({
      source: { kind: 'http', url: GQL, method: 'POST', body: { query: '{ x }' } },
    });
    expect(JSON.stringify(await other.json())).toMatch(/Sign in/);
    expect(upstreamJson).not.toHaveBeenCalled();
    const same = await preview({ source: { kind: 'http', url: GQL, method: 'POST', body: QUERY } });
    expect(same.status).toBe(200);
    // The preview answers { result, profile, suggestions }: a refusal would be result.error.
    const { result } = (await same.json()) as { result: { error?: string; table: { rows: unknown[] } } };
    expect(result.error).toBeUndefined();
    expect(result.table.rows.length).toBeGreaterThan(0);
  });

  // `path` is read from the response and never sent, but it is part of the cache key: a copy that varied it would
  // send the trusted request again for every value, so it is part of what a copy may not change.
  const previewWith = (copy: { envelope: { meta: { id: string } }; editKey?: string }, path: string) =>
    postApp.request(`/api/dashboards/${copy.envelope.meta.id}/preview`, {
      method: 'POST',
      headers: { 'x-edit-key': copy.editKey!, 'content-type': 'application/json' },
      body: JSON.stringify({
        dataset: { source: { kind: 'http', url: GQL, method: 'POST', body: QUERY, path } },
      }),
    });

  it('refuses anonymous previews of the trusted POST that add a path, one after the other, unsent', async () => {
    const copy = await postDeps.dashboards.duplicate('scgraphdemo', anonymous());
    upstreamJson.mockClear();
    for (const path of ['x.one', 'x.two', 'x.three']) {
      const res = await previewWith(copy, path);
      expect(JSON.stringify(await res.json())).toMatch(/Sign in/);
    }
    expect(upstreamJson).not.toHaveBeenCalled();
  });

  it('refuses a saved dataset that changes only the path of the trusted POST, and does not fetch one', async () => {
    const copy = await postDeps.dashboards.duplicate('scgraphdemo', anonymous());
    const id = copy.envelope.meta.id;
    const key = { 'x-edit-key': copy.editKey!, 'content-type': 'application/json' };
    upstreamJson.mockClear();
    const save = await postApp.request(`/api/dashboards/${id}/ops`, {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        ops: [
          {
            op: 'updateDataset',
            id: 'gql',
            set: { source: { kind: 'http', url: GQL, method: 'POST', body: QUERY, path: 'y.1' } },
          },
        ],
      }),
    });
    expect(save.status).toBe(400);
    // The same dataset reaching the fetch some other way (an imported document) is refused there too.
    const target = { id, ownerId: null };
    expect(() => postDeps.dashboards.assertMayFetchUrl(target, GQL, 'POST', QUERY, 'y.1')).toThrow(/sign/i);
    expect(() => postDeps.dashboards.assertMayFetchUrl(target, GQL, 'POST', QUERY)).not.toThrow();
    expect(upstreamJson).not.toHaveBeenCalled();
  });

  it('lets an anonymous copy load a trusted POST that has a path, with one upstream call', async () => {
    const copy = await postDeps.dashboards.duplicate('scgraphpath', anonymous());
    upstreamJson.mockClear();
    upstreamJson.mockResolvedValueOnce({ data: { items: [{ a: 1 }, { a: 2 }] } } as never);
    const res = await postApp.request(`/api/dashboards/${copy.envelope.meta.id}/data/gql`, {
      headers: { 'x-edit-key': copy.editKey! },
    });
    const body = (await res.json()) as { error?: string; table: { rows: unknown[] } };
    expect(body.error).toBeUndefined();
    expect(body.table.rows).toHaveLength(2);
    expect(upstreamJson).toHaveBeenCalledTimes(1);
  });

  // A signed-in owner may save any POST. An anonymous duplicate skips the write rule (create does not run
  // checkUrlSources), so the check at fetch time is the only guard: pin it.
  describe('an anonymous copy of an owner-made POST dashboard', () => {
    const ownerDashboard = async (id: string, body: unknown) => {
      const owner = postDeps.users.upsert({ email: `${id}@example.com`, name: 'Owner' });
      const at = now();
      const meta: StoredMeta = {
        id,
        ownerId: owner.id,
        ownerEmail: owner.email,
        visibility: 'public',
        editKeyHash: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
        lastViewedAt: at,
        lastActor: { kind: 'user', label: 'test' },
      };
      const parameters = [
        { id: 'q', label: 'Query', type: 'select', options: [{ value: '{ a }' }], default: '{ a }' },
      ];
      const doc = { ...buildTemplate('blank'), parameters, datasets: [postDataset(body)] };
      await postDeps.store.create(meta, doc as never, meta.lastActor!, ['Created']);
      postDeps.index.upsert(meta, { title: doc.title, widgets: 0 });
    };

    it.each([
      ['a body that is not a showcase', 'ownermadeone', { query: '{ x }' }],
      ['a $param. in the body', 'ownermadetwo', { query: '$param.q' }],
    ])('refuses to send %s, unsent', async (_name, id, body) => {
      await ownerDashboard(id, body);
      const copy = await postDeps.dashboards.duplicate(id, anonymous());
      upstreamJson.mockClear();
      const res = await postApp.request(`/api/dashboards/${copy.envelope.meta.id}/data/gql`, {
        headers: { 'x-edit-key': copy.editKey! },
      });
      expect(JSON.stringify(await res.json())).toMatch(/Sign in/);
      expect(upstreamJson).not.toHaveBeenCalled();
    });
  });
});
