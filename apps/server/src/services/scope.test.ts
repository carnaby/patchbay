import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DashboardDoc,
  DashboardDocSchema,
  DatasetSchema,
  type DataTable,
  inferTable,
} from '@patchbay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import type { Connector } from '../connectors/types.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HttpError, lastingError, RetryLaterError } from '../util/errors.ts';
import { HEAVY_PIPELINE_CELLS, heavyWork } from '../util/heavy.ts';
import { MemoryPressureError, memoryGuard } from '../util/memory-pressure.ts';
import type { PipelineRunner } from './pipeline-pool.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  safeFetchJson: (url: string) => fetchMock(url),
}));

const { DataService } = await import('./data.ts');
const { InlineRunner } = await import('./pipeline-pool.ts');
const { SCOPE_TIMEOUT_MESSAGE, STILL_LOADING_OWN, ScopeTimeoutError, errorResult, stillLoadingMessage } =
  await import('./scope.ts');

type RunArgs = Parameters<PipelineRunner['run']>;

// Runners here forward every argument: dropping the lineage's `open` would quietly change what a run checks.
class CountingRunner extends InlineRunner {
  runs: string[] = [];
  reads: string[][] = [];
  override async run(...args: RunArgs) {
    const [, transforms, inputs] = args;
    this.runs.push(transforms.map((t) => t.type).join(','));
    this.reads.push(Object.keys(inputs?.tables ?? {}));
    return super.run(...args);
  }
}

let dir: string;
let store: FolderStore;
const connectors = new ConnectorService({ offline: true });
const target = { id: 'scope01', ownerId: null };

const inline = (id: string, rows: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  source: { kind: 'inline', rows },
  ...extra,
});
const from = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  source: { kind: 'dataset', id: parent },
  ...extra,
});
const doc = (...datasets: unknown[]): DashboardDoc =>
  DashboardDocSchema.parse({ schemaVersion: 1, title: 't', datasets });
const byId = (d: DashboardDoc, id: string) => d.datasets.find((x) => x.id === id)!;
const cities = [
  { city: 'A', temp: 1 },
  { city: 'B', temp: 3 },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-scope-test-'));
  store = new FolderStore(dir);
  await store.init();
  await store.create(
    {
      id: target.id,
      ownerId: null,
      ownerEmail: null,
      visibility: 'public',
      editKeyHash: null,
      version: 1,
      createdAt: '',
      updatedAt: '',
      lastViewedAt: '',
    },
    { title: 't', datasets: [], widgets: [] } as never,
    { kind: 'anonymous', label: 'Anonymous' },
    ['Created'],
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fetchMock.mockReset());

async function saveUpload(fileId: string, rows: number) {
  const table = inferTable(Array.from({ length: rows }, (_, i) => ({ a: i })));
  await store.saveFile(target.id, {
    id: fileId,
    name: 'f.csv',
    rows,
    columns: 1,
    size: 1,
    uploadedAt: new Date().toISOString(),
    table,
  });
}

describe('resolution scopes', () => {
  it('loads and processes a shared parent once for all its children', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    const load = vi.spyOn(data, 'loadSource');
    const d = doc(
      inline('w', cities, { transforms: [{ type: 'derive', as: 'f', expr: 'temp * 1.8 + 32' }] }),
      from('a', 'w', { transforms: [{ type: 'filter', expr: 'f > 34' }] }),
      from('b', 'w', {
        transforms: [{ type: 'aggregate', metrics: [{ op: 'avg', field: 'f', as: 'avg' }] }],
      }),
    );
    const scope = data.scope(target, d);
    const [w, a, b] = await Promise.all(['w', 'a', 'b'].map((id) => scope.resolve(byId(d, id))));
    expect(w!.table.rows).toHaveLength(2);
    expect(a!.table.rows).toEqual([{ city: 'B', temp: 3, f: 37.4 }]);
    expect(b!.table.rows).toEqual([{ avg: 35.6 }]);
    expect(load).toHaveBeenCalledTimes(1);
    // One run per dataset: the parent's derive is not repeated for each child.
    expect([...runner.runs].sort()).toEqual(['aggregate', 'derive', 'filter']);
  });

  it('keeps datasets without lineage on the old path', async () => {
    const data = new DataService(connectors, store);
    const legacy = vi.spyOn(data, 'resolve');
    const d = doc(inline('alone', cities));
    expect((await data.scope(target, d).resolve(byId(d, 'alone'))).table.rows).toHaveLength(2);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('gives children the parent table beyond the 10,000 rows widgets receive', async () => {
    await saveUpload('f_big', 12_000);
    const data = new DataService(connectors, store);
    const d = doc(
      { id: 'p', name: 'P', source: { kind: 'upload', fileId: 'f_big' } },
      from('c', 'p', { transforms: [{ type: 'aggregate', metrics: [{ op: 'count', as: 'n' }] }] }),
    );
    const scope = data.scope(target, d);
    const parent = await scope.resolve(byId(d, 'p'));
    expect(parent.truncated).toBe(true);
    expect(parent.table.rows).toHaveLength(10_000);
    expect((await scope.resolve(byId(d, 'c'))).table.rows).toEqual([{ n: 12_000 }]);
  });

  it('hands children at most the last 100,000 rows of a parent, and says so', async () => {
    await saveUpload('f_huge', 100_005);
    const data = new DataService(connectors, store);
    const d = doc(
      { id: 'p', name: 'P', source: { kind: 'upload', fileId: 'f_huge' } },
      from('c', 'p', {
        transforms: [
          {
            type: 'aggregate',
            metrics: [
              { op: 'min', field: 'a', as: 'first' },
              { op: 'count', as: 'n' },
            ],
          },
        ],
      }),
    );
    const child = await data.scope(target, d).resolve(byId(d, 'c'));
    expect(child.table.rows).toEqual([{ first: 5, n: 100_000 }]);
    expect(child.error).toBeUndefined();
    expect(child.warning).toBe(
      'Source dataset "p" has more than 100,000 rows; only its last 100,000 are used',
    );
  });

  it('gives every scope the same capped table of a large result, so its serialisation is shared', async () => {
    await saveUpload('f_wide', 12_000);
    await saveUpload('f_over', 100_005);
    const data = new DataService(connectors, store);
    const d = doc(
      { id: 'p', name: 'P', source: { kind: 'upload', fileId: 'f_wide' } },
      from('c', 'p', { transforms: [{ type: 'filter', expr: 'a >= 1' }] }),
      // Read by a child, so it goes through the scope and its table is cut to PIPELINE_LIMITS.maxRows first.
      { id: 'huge', name: 'Huge', source: { kind: 'upload', fileId: 'f_over' } },
      from('h', 'huge'),
    );
    for (const id of ['p', 'c', 'huge']) {
      const first = await data.scope(target, d).resolve(byId(d, id));
      const second = await data.scope(target, d).resolve(byId(d, id));
      expect(first.truncated, id).toBe(true);
      expect(second.table, id).toBe(first.table);
      expect(second.hash, id).toBe(first.hash);
    }
  });

  it('names the upstream dataset that failed, also inside a union, and shows no partial rows', async () => {
    fetchMock.mockResolvedValue(5);
    const data = new DataService(connectors, store);
    const d = doc(
      { id: 'brno', name: 'Brno', source: { kind: 'http', url: 'https://down.example/brno' } },
      from('child', 'brno'),
      from('grandchild', 'child'),
      inline('both', cities, { transforms: [{ type: 'union', with: ['brno'], origin: 'source' }] }),
    );
    const scope = data.scope(target, d);
    const message = 'Source dataset "brno" failed: The response does not contain a list of records';
    for (const id of ['child', 'grandchild', 'both']) {
      const r = await scope.resolve(byId(d, id));
      expect(r.error).toBe(message);
      expect(r.table.rows).toEqual([]);
    }
  });

  it('loads three http sources on one host at once, and the union reading them, with the default limits', async () => {
    // url is optional: the file's beforeEach(() => fetchMock.mockReset()) returns the mock, which vitest then calls
    // as a cleanup with no arguments.
    fetchMock.mockImplementation(async (url?: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return [{ check: url?.split('/').pop(), state: 'ok' }];
    });
    const data = new DataService(connectors, store);
    const http = (id: string, path: string) => ({
      id,
      name: id,
      source: { kind: 'http', url: `https://status.example/api/${path}` },
    });
    const d = doc(
      http('components', 'components'),
      http('incidents', 'incidents'),
      http('history', 'history'),
      from('all', 'components', { transforms: [{ type: 'union', with: ['incidents', 'history'] }] }),
    );
    const scope = data.scope(target, d);
    const results = await Promise.all(d.datasets.map((x) => scope.resolve(x)));
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(results[3]!.table.rows).toHaveLength(3);
  });

  it('loads five datasets that read aliases of one GraphQL query, and their union, with one request', async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { data: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`w${i}`, { nodes: [{ iid: i }] }])) };
    });
    const data = new DataService(connectors, store);
    const body = {
      query:
        '{ w0: x { nodes { iid } } w1: x { nodes { iid } } w2: x { nodes { iid } } w3: x { nodes { iid } } w4: x { nodes { iid } } }',
    };
    const window = (i: number) => ({
      id: `w${i}`,
      name: `W${i}`,
      source: {
        kind: 'http',
        url: 'https://gitlab.example/api/graphql',
        method: 'POST',
        body,
        path: `data.w${i}.nodes`,
      },
    });
    const d = doc(
      ...[0, 1, 2, 3, 4].map(window),
      from('day', 'w0', { transforms: [{ type: 'union', with: ['w1', 'w2', 'w3', 'w4'] }] }),
    );
    const scope = data.scope(target, d);
    const results = await Promise.all(d.datasets.map((x) => scope.resolve(x)));
    expect(results.map((r) => r.error)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(results[5]!.table.rows.map((r) => r.iid).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks columns in a dataset that reads one a filter emptied, and not in one that reads an empty source', async () => {
    const data = new DataService(connectors, store);
    const d = doc(
      inline('warm', cities, { transforms: [{ type: 'filter', expr: 'temp > 100' }] }),
      from('typo', 'warm', { transforms: [{ type: 'derive', as: 'c', expr: 'ctiy' }] }),
      inline('open', []),
      from('wall', 'open', { transforms: [{ type: 'derive', as: 'detail', expr: 'name' }] }),
    );
    const scope = data.scope(target, d);
    expect((await scope.resolve(byId(d, 'typo'))).error).toMatch(/Unknown column "ctiy"/);
    const wall = await scope.resolve(byId(d, 'wall'));
    expect(wall.error).toBeUndefined();
    expect(wall.trace?.[0]?.unchecked).toEqual(['name']);
  });

  it('does not check a join with an empty source, and checks one with a dataset a filter emptied', async () => {
    const data = new DataService(connectors, store);
    const d = doc(
      inline('none', []),
      inline('regions', [{ code: 'SK', region: 'Central' }], {
        transforms: [{ type: 'filter', expr: 'code == "XX"' }],
      }),
      inline('open', [{ code: 'SK' }], {
        transforms: [{ type: 'join', with: 'none', on: ['code'], fields: ['name'] }],
      }),
      inline('typo', [{ code: 'SK' }], {
        transforms: [{ type: 'join', with: 'regions', on: ['code'], fields: ['regoin'] }],
      }),
    );
    const scope = data.scope(target, d);
    const open = await scope.resolve(byId(d, 'open'));
    expect(open.error).toBeUndefined();
    expect(open.table.rows).toEqual([{ code: 'SK', name: null }]);
    expect(open.trace?.[0]?.unchecked).toEqual(['none.code', 'none.name']);
    expect((await scope.resolve(byId(d, 'typo'))).error).toMatch(/Unknown column "regoin" in "regions"/);
  });

  it('shares a pipeline result only between runs with the same openness', async () => {
    const data = new DataService(connectors, store);
    const empty = inferTable([]);
    const d = doc(inline('x', [], { transforms: [{ type: 'derive', as: 'detail', expr: 'name' }] }));
    const read = byId(d, 'x').transforms;
    // The same empty table object and steps: only the key's openness keeps the second run from reusing the first.
    const open = await data.processShared(empty, read, undefined, false, true);
    expect(open.trace[0]?.unchecked).toEqual(['name']);
    await expect(data.processShared(empty, read, undefined, false, false)).rejects.toThrow(
      /Unknown column "name"/,
    );
  });

  it('marks a failure that is our own limit with the time after which to ask again', () => {
    expect(errorResult('d', new RetryLaterError(429, 'busy', 10)).retryAfterSec).toBe(10);
    expect(errorResult('d', new HttpError(400, 'x')).retryAfterSec).toBeUndefined();
    expect(errorResult('d', new Error('x'))).not.toHaveProperty('retryAfterSec');
  });

  it('marks a failure only an edit or a setting can fix as lasting, without a retry hint', () => {
    const lasting = errorResult('d', lastingError(403, 'x'));
    expect(lasting.lasting).toBe(true);
    expect(lasting.retryAfterSec).toBeUndefined();
    expect(errorResult('d', new HttpError(502, 'x')).lasting).toBeUndefined();
    const busy = errorResult('d', new RetryLaterError(429, 'busy', 10));
    expect(busy.retryAfterSec).toBe(10);
    expect(busy).not.toHaveProperty('lasting');
    const loading = errorResult(
      'd',
      new ScopeTimeoutError(stillLoadingMessage('w'), { retryAfterSec: 10, source: 'w' }),
    );
    expect(loading.retryAfterSec).toBe(10);
    expect(loading).not.toHaveProperty('lasting');
  });

  it('passes a lasting failure on to the datasets that read it, and only a lasting one', async () => {
    const wide = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, i]));
    const refused = doc(inline('parent', [wide]), from('child', 'parent'));
    const child = await new DataService(connectors, store)
      .scope(target, refused)
      .resolve(byId(refused, 'child'));
    expect(child.error).toMatch(/^Source dataset "parent" failed: /);
    expect(child.lasting).toBe(true);

    const unknown = doc(inline('a', cities));
    const draft = DatasetSchema.parse(from('draft', 'nope'));
    const missing = await new DataService(connectors, store).scope(target, unknown).resolve(draft);
    expect(missing.error).toBe('Source dataset "nope" failed: Unknown dataset "nope"');
    expect(missing.lasting).toBe(true);

    const fetched = doc(
      { id: 'parent', name: 'Parent', source: { kind: 'http', url: 'https://up.example/x' } },
      from('child', 'parent'),
    );
    fetchMock.mockRejectedValueOnce(new HttpError(502, 'Upstream responded 503'));
    const down = await new DataService(connectors, store)
      .scope(target, fetched)
      .resolve(byId(fetched, 'child'));
    expect(down.error).toBe('Source dataset "parent" failed: Upstream responded 503');
    expect(down).not.toHaveProperty('lasting');
    fetchMock.mockRejectedValueOnce(new RetryLaterError(429, 'busy', 10));
    const busy = await new DataService(connectors, store)
      .scope(target, fetched)
      .resolve(byId(fetched, 'child'));
    expect(busy).toMatchObject({ error: 'Source dataset "parent" failed: busy', retryAfterSec: 10 });
    expect(busy).not.toHaveProperty('lasting');
  });

  it('passes the retry hint of a refused connector load on to the datasets that read it', async () => {
    class Refusing extends ConnectorService {
      override async load(): Promise<never> {
        throw new RetryLaterError(429, 'busy', 10);
      }
    }
    const data = new DataService(new Refusing({ offline: true }), store);
    const d = doc(
      {
        id: 'parent',
        name: 'Parent',
        source: { kind: 'connector', connector: 'earthquakes', params: { period: 'day' } },
      },
      from('child', 'parent'),
      from('grandchild', 'child'),
    );
    const scope = data.scope(target, d);
    expect(await scope.resolve(byId(d, 'parent'))).toMatchObject({ error: 'busy', retryAfterSec: 10 });
    for (const id of ['child', 'grandchild']) {
      const r = await scope.resolve(byId(d, id));
      expect(r.error).toBe('Source dataset "parent" failed: busy');
      expect(r.retryAfterSec).toBe(10);
    }
  });

  it('reports failures and warnings of inputs in declared order, however they are timed', async () => {
    const data = new DataService(connectors, store);
    // The later input fails first: a wall screen must not flip between the two messages from tick to tick.
    const load = data.loadSource.bind(data);
    vi.spyOn(data, 'loadSource').mockImplementation(async (t, dataset) => {
      if (dataset.id === 'a' || dataset.id === 'sa') await new Promise((r) => setTimeout(r, 30));
      if (dataset.id === 'a' || dataset.id === 'b') throw new Error(`${dataset.name} is down`);
      const loaded = await load(t, dataset);
      return dataset.id.startsWith('s') ? { ...loaded, warning: `${dataset.name} is stale` } : loaded;
    });
    const d = doc(
      inline('a', cities),
      inline('b', cities),
      inline('both', cities, { transforms: [{ type: 'union', with: ['a', 'b'] }] }),
      from('derived', 'a', { transforms: [{ type: 'union', with: ['b'] }] }),
      inline('sa', cities),
      inline('sb', cities),
      inline('mix', cities, { transforms: [{ type: 'union', with: ['sa', 'sb'] }] }),
    );
    for (const id of ['both', 'derived']) {
      const r = await data.scope(target, d).resolve(byId(d, id));
      expect(r.error, id).toBe('Source dataset "a" failed: A is down');
    }
    const mix = await data.scope(target, d).resolve(byId(d, 'mix'));
    expect(mix.warning).toBe('SA is stale; SB is stale');
    expect(mix.error).toBeUndefined();
  });

  it('passes upstream warnings on and dates a result by its oldest input', async () => {
    const data = new DataService(connectors, store, new InlineRunner(), { maxSourceCells: 5 });
    const d = doc(
      inline(
        'p',
        Array.from({ length: 10 }, (_, i) => ({ i })),
      ),
      from('c', 'p'),
      inline('x', [{ i: 1 }]),
      inline('y', [{ i: 2 }]),
      from('u', 'x', { transforms: [{ type: 'union', with: ['y'] }] }),
    );
    const c = await data.scope(target, d).resolve(byId(d, 'c'));
    expect(c.warning).toBe('Showing the first 5 rows of the inline rows');
    expect(c.error).toBeUndefined();
    // A filter that keeps nothing is an empty result with a warning, not a failure.
    const none = doc(...d.datasets, from('none', 'p', { transforms: [{ type: 'filter', expr: 'i > 100' }] }));
    const empty = await data.scope(target, none).resolve(byId(none, 'none'));
    expect(empty.table.rows).toEqual([]);
    expect(empty.error).toBeUndefined();
    expect(empty.warning).toBe('Showing the first 5 rows of the inline rows');
    const seeded = data.scope(target, d, {
      seed: (id) =>
        id === 'x' || id === 'y'
          ? { table: inferTable([{ i: id }]), trace: [], fetchedAt: id === 'x' ? 5_000 : 1_000, cut: 0 }
          : undefined,
    });
    const u = await seeded.resolve(byId(d, 'u'));
    expect(u.fetchedAt).toBe(new Date(1_000).toISOString());
    expect(u.table.rows).toEqual([{ i: 'x' }, { i: 'y' }]);
  });

  it("shows a preview the history of an accumulating root and never adds the preview's reading to it", async () => {
    const data = new DataService(connectors, store);
    // Every load is a new reading (a new fetch time), as a fetch outside the owner's cache would be.
    let at = 1_000;
    vi.spyOn(data, 'loadSource').mockImplementation(async () => ({
      table: inferTable(cities),
      fetchedAt: at,
      credentialKey: '',
    }));
    const d = doc(inline('hist', cities, { accumulate: 10 }), from('kid', 'hist'));
    expect((await data.scope(target, d).resolve(byId(d, 'kid'))).table.rows).toHaveLength(2);
    at = 2_000;
    const preview = { ...target, preview: true };
    const draft = DatasetSchema.parse(from('draft', 'hist'));
    const shown = await data.scope(preview, { ...d, datasets: [...d.datasets, draft] }).resolve(draft);
    // The stored reading plus the preview's own one, which is shown but not kept.
    expect(shown.table.rows).toHaveLength(4);
    expect((await data.scope(preview, d).resolve(byId(d, 'hist'))).table.rows).toHaveLength(4);
    // The same reading as the stored one is not new: the buffer still holds exactly one reading.
    at = 1_000;
    expect((await data.scope(target, d).resolve(byId(d, 'kid'))).table.rows).toHaveLength(2);
  });

  it('resolves a draft that is not in the document against the document', async () => {
    const data = new DataService(connectors, store);
    const d = doc(inline('w', cities));
    const draft = DashboardDocSchema.parse({
      schemaVersion: 1,
      title: 't',
      datasets: [from('draft', 'w', { transforms: [{ type: 'filter', expr: 'temp > 2' }] })],
    }).datasets[0]!;
    expect((await data.scope(target, d).resolve(draft)).table.rows).toEqual([{ city: 'B', temp: 3 }]);
  });

  it('ends a scope that runs out of time with a clear error', async () => {
    const data = new DataService(connectors, store);
    const d = doc(inline('w', cities), from('c', 'w'));
    const r = await data.scope(target, d, { deadlineMs: 0 }).resolve(byId(d, 'c'));
    expect(r.error).toBe(SCOPE_TIMEOUT_MESSAGE);
    // Nothing was started, so nothing is still loading that asking again could join.
    expect(r.retryAfterSec).toBeUndefined();
  });

  it('starts no work once the deadline has passed, so a late failure is never left unhandled', async () => {
    const data = new DataService(connectors, store);
    const d = doc(
      inline('p', cities),
      from('c', 'p', { transforms: [{ type: 'filter', expr: 'nope > 1' }] }),
    );
    const slow = data.scope(target, d, {
      deadlineMs: 10,
      seed: (id) => {
        if (id !== 'p') return undefined;
        // A slow upstream: the deadline passes before the child's own step would start.
        const until = Date.now() + 30;
        while (Date.now() < until);
        return { table: inferTable(cities), trace: [], fetchedAt: 0, cut: 0 };
      },
    });
    const late = await slow.resolve(byId(d, 'c'));
    expect(late.error).toBe(SCOPE_TIMEOUT_MESSAGE);
    expect(late.retryAfterSec).toBeUndefined();
    const draft = { ...byId(d, 'c'), id: 'draft' };
    expect((await data.scope(target, d, { deadlineMs: 0 }).resolve(draft)).error).toBe(SCOPE_TIMEOUT_MESSAGE);
    // Any orphaned rejection surfaces on a later turn of the event loop and fails this file.
    await new Promise((r) => setTimeout(r, 20));
  });

  describe('a source still loading at the deadline', () => {
    const gate = () => {
      let open!: () => void;
      let close!: (e: Error) => void;
      const p = new Promise<void>((resolve, reject) => {
        open = resolve;
        close = reject;
      });
      p.catch(() => {}); // rejected on purpose in one case; the connector's own await sees it
      return { p, open, close };
    };
    const slowConnector = (calls: { n: number }, wait: Promise<void>): Connector => ({
      info: {
        id: 'test.slow',
        name: 'Slow',
        category: 'Test',
        description: '',
        params: [],
        minRefreshSec: 60,
        docsUrl: 'https://example.com',
        attribution: '',
      },
      async fetch() {
        calls.n++;
        await wait;
        return { columns: [{ name: 'v', type: 'number' }], rows: [{ v: 1 }] };
      },
      sample: () => ({ columns: [], rows: [] }),
    });
    const slowDoc = () =>
      doc(
        { id: 'w', name: 'W', source: { kind: 'connector', connector: 'test.slow', params: {} } },
        from('c', 'w'),
      );

    it('names a source that is still loading at the deadline, and lets the page ask again', async () => {
      const calls = { n: 0 };
      const { p, open } = gate();
      const data = new DataService(
        new ConnectorService({ offline: false, connectors: [slowConnector(calls, p)] }),
        store,
      );
      const d = slowDoc();
      const timedOut = await data.scope(target, d, { deadlineMs: 50 }).resolve(byId(d, 'c'));
      expect(timedOut.error).toBe(
        'Source dataset "w" is still loading (its source is slow or busy); it is asked again shortly',
      );
      expect(timedOut.retryAfterSec).toBe(10);
      expect(timedOut.lasting).toBeUndefined();
      // The next scope joins the load still in flight instead of starting another.
      const next = data.scope(target, d).resolve(byId(d, 'c'));
      open();
      expect((await next).table.rows).toEqual([{ v: 1 }]);
      expect(calls.n).toBe(1);
    });

    it('says the dataset itself is still loading when its own source is the slow one', async () => {
      const calls = { n: 0 };
      const { p, open } = gate();
      const data = new DataService(
        new ConnectorService({ offline: false, connectors: [slowConnector(calls, p)] }),
        store,
      );
      const d = slowDoc();
      const own = await data.scope(target, d, { deadlineMs: 50 }).resolve(byId(d, 'w'));
      expect(own.error).toBe(STILL_LOADING_OWN);
      expect(own.retryAfterSec).toBe(10);
      expect(own.lasting).toBeUndefined();
      open();
      expect((await data.scope(target, d).resolve(byId(d, 'w'))).table.rows).toEqual([{ v: 1 }]);
      expect(calls.n).toBe(1);
    });

    it('lets a load that fails after the deadline end quietly, and reports its own error next time', async () => {
      const calls = { n: 0 };
      const { p, close } = gate();
      const data = new DataService(
        new ConnectorService({ offline: false, connectors: [slowConnector(calls, p)] }),
        store,
      );
      const d = slowDoc();
      const scope = data.scope(target, d, { deadlineMs: 50 });
      const timedOut = await scope.resolve(byId(d, 'c'));
      expect(timedOut.error).toBe(stillLoadingMessage('w'));
      close(new Error('down'));
      // An unhandled rejection from the load this scope tracked would surface on a later turn and fail this file.
      await new Promise((r) => setTimeout(r, 20));
      // The failed load is no longer pending in the scope that started it.
      const after = await scope.resolve(byId(d, 'c'));
      expect(after.error).toBe(SCOPE_TIMEOUT_MESSAGE);
      expect(after.retryAfterSec).toBeUndefined();
      const next = await data.scope(target, d).resolve(byId(d, 'c'));
      expect(next.error).toMatch(/^Source dataset "w" failed: .*down/);
    });

    it('names a pending source of the widget’s own lineage, never another chain’s', async () => {
      const calls = { n: 0 };
      const w = gate();
      const v = gate();
      const second = slowConnector(calls, v.p);
      const data = new DataService(
        new ConnectorService({
          offline: false,
          connectors: [slowConnector(calls, w.p), { ...second, info: { ...second.info, id: 'test.slow2' } }],
        }),
        store,
      );
      const d = doc(
        { id: 'w', name: 'W', source: { kind: 'connector', connector: 'test.slow', params: {} } },
        from('c', 'w'),
        { id: 'v', name: 'V', source: { kind: 'connector', connector: 'test.slow2', params: {} } },
        from('e', 'v'),
      );
      const scope = data.scope(target, d, { deadlineMs: 50 });
      const [c, e] = await Promise.all([scope.resolve(byId(d, 'c')), scope.resolve(byId(d, 'e'))]);
      expect(c.error).toBe(stillLoadingMessage('w'));
      expect(e.error).toBe(stillLoadingMessage('v'));
      expect(e.retryAfterSec).toBe(10);
      w.open();
      v.open();
    });

    it('gives a widget whose own chain is just slow the shorten-the-chain text and no retry hint', async () => {
      const calls = { n: 0 };
      const w = gate();
      const step = gate();
      const data = new DataService(
        new ConnectorService({ offline: false, connectors: [slowConnector(calls, w.p)] }),
        store,
      );
      const run = data.processShared.bind(data);
      // The derived dataset's step outlasts the deadline while another chain's source is still loading.
      vi.spyOn(data, 'processShared').mockImplementation(async (...args: Parameters<typeof run>) => {
        if (args[1].some((t) => t.type === 'filter')) await step.p;
        return run(...args);
      });
      const d = doc(
        { id: 'w', name: 'W', source: { kind: 'connector', connector: 'test.slow', params: {} } },
        from('c', 'w'),
        inline('x', cities),
        from('y', 'x', { transforms: [{ type: 'filter', expr: 'temp > 2' }] }),
      );
      const scope = data.scope(target, d, { deadlineMs: 50 });
      const [c, y] = await Promise.all([scope.resolve(byId(d, 'c')), scope.resolve(byId(d, 'y'))]);
      expect(y.error).toBe(SCOPE_TIMEOUT_MESSAGE);
      expect(y.retryAfterSec).toBeUndefined();
      expect(c.error).toBe(stillLoadingMessage('w'));
      expect(c.retryAfterSec).toBe(10);
      step.open();
      w.open();
    });
  });

  it('names a cycle that slipped past validation instead of overflowing the stack', async () => {
    const data = new DataService(connectors, store);
    const valid = doc(inline('a', cities), from('b', 'a'));
    const cyclic = { ...valid, datasets: [DatasetSchema.parse(from('a', 'b')), byId(valid, 'b')] };
    const failed = await data.scope(target, cyclic).resolve(byId(cyclic, 'a'));
    expect(failed.error).toBe('Datasets "a" → "b" → "a" form a cycle');
    expect(failed.lasting).toBe(true);
    const self = DatasetSchema.parse(inline('s', cities, { transforms: [{ type: 'union', with: ['s'] }] }));
    const own = { ...valid, datasets: [self] };
    expect((await data.scope(target, own).resolve(self)).error).toBe('Dataset "s" reads itself');
  });

  it('fails every dataset on a cycle at once, also when both ends are resolved together', async () => {
    const data = new DataService(connectors, store);
    const valid = doc(inline('a', cities), from('b', 'a'), from('r', 'b'));
    const cyclic = {
      ...valid,
      datasets: [DatasetSchema.parse(from('a', 'b')), byId(valid, 'b'), byId(valid, 'r')],
    };
    const scope = data.scope(target, cyclic, { deadlineMs: 1_000 });
    const started = Date.now();
    const results = await Promise.all(cyclic.datasets.map((x) => scope.resolve(x)));
    expect(results.map((r) => r.error)).toEqual(Array(3).fill('Datasets "a" → "b" → "a" form a cycle'));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('turns a seed that throws into the dataset error and leaves no deadline armed', async () => {
    const data = new DataService(connectors, store);
    const d = doc(inline('w', cities), from('c', 'w'));
    const scope = data.scope(target, d, {
      deadlineMs: 30,
      seed: (id) => {
        if (id === 'c') throw new Error('seed broke');
        return undefined;
      },
    });
    expect((await scope.resolve(byId(d, 'c'))).error).toBe('seed broke');
    // A deadline timer left armed would reject here with nobody listening and fail this file.
    await new Promise((r) => setTimeout(r, 60));
  });

  it('refuses a dataset that reads others when resolved without its document', async () => {
    const data = new DataService(connectors, store);
    const d = doc(inline('w', cities), from('c', 'w'));
    expect((await data.resolve(target, byId(d, 'c'))).error).toBe(
      'Dataset "c" reads other datasets and can only be loaded with its dashboard',
    );
  });

  it('hands a pipeline only the tables its steps read', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    const d = doc(
      inline('w', cities),
      inline('v', [{ city: 'C', temp: 5 }]),
      inline('z', [{ other: 1 }]),
      from('a', 'w', { transforms: [{ type: 'union', with: ['v'] }] }),
      from('b', 'z'),
    );
    const a = await data.scope(target, d).resolve(byId(d, 'a'));
    expect(a.table.rows.map((r) => r.city)).toEqual(['A', 'B', 'C']);
    expect(runner.reads.filter((r) => r.length)).toEqual([['v']]);
  });
});

describe('final results across scopes', () => {
  /** A root whose reading the test controls: the same table object until `next` makes a new one. */
  function controlled(data: InstanceType<typeof DataService>, credentialKey = () => '') {
    let table = inferTable(cities);
    vi.spyOn(data, 'loadSource').mockImplementation(async () => ({
      table,
      fetchedAt: 1_000,
      credentialKey: credentialKey(),
    }));
    return {
      next: () => {
        table = inferTable(cities);
      },
    };
  }
  const chain = () =>
    doc(
      inline('w', cities, { transforms: [{ type: 'derive', as: 'f', expr: 'temp * 2' }] }),
      from('c', 'w', { transforms: [{ type: 'filter', expr: 'f > 3' }] }),
    );

  it('answers a request whose inputs are warm without running any pipeline, with the same result object', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    controlled(data);
    const d = chain();
    const first = await data.scope(target, d).resolve(byId(d, 'c'));
    const parent = await data.scope(target, d).resolve(byId(d, 'w'));
    const runs = runner.runs.length;
    const processed = vi.spyOn(data, 'processShared');
    const second = await data.scope(target, d).resolve(byId(d, 'c'));
    expect(second).toBe(first);
    expect(second.table).toBe(first.table);
    expect(await data.scope(target, d).resolve(byId(d, 'w'))).toBe(parent);
    expect(processed).not.toHaveBeenCalled();
    expect(runner.runs).toHaveLength(runs);
  });

  it('shares one computation between concurrent scopes', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    controlled(data);
    const d = chain();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => data.scope(target, d).resolve(byId(d, 'c'))),
    );
    for (const r of results) expect(r).toBe(results[0]);
    expect([...runner.runs].sort()).toEqual(['derive', 'filter']);
  });

  it('computes again when a root has a new reading', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    const root = controlled(data);
    const d = chain();
    const first = await data.scope(target, d).resolve(byId(d, 'c'));
    root.next();
    const second = await data.scope(target, d).resolve(byId(d, 'c'));
    expect(second).not.toBe(first);
    expect(second.hash).toBe(first.hash);
    expect([...runner.runs].sort()).toEqual(['derive', 'derive', 'filter', 'filter']);
  });

  it('never shares a result between owners, read-only previews or credentials', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    let credential = '';
    controlled(data, () => credential);
    const d = chain();
    const c = byId(d, 'c');
    const first = await data.scope({ id: target.id, ownerId: 'u1' }, d).resolve(c);
    expect(await data.scope({ id: target.id, ownerId: 'u2' }, d).resolve(c)).not.toBe(first);
    expect(await data.scope({ id: target.id, ownerId: 'u1', publicOnly: true }, d).resolve(c)).not.toBe(
      first,
    );
    credential = 'u1/s1@2';
    expect(await data.scope({ id: target.id, ownerId: 'u1' }, d).resolve(c)).not.toBe(first);
    credential = '';
    expect(await data.scope({ id: target.id, ownerId: 'u1' }, d).resolve(c)).toBe(first);
  });

  it('neither serves nor keeps the result of a preview or of a seeded scope (the live hub)', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    controlled(data);
    const d = chain();
    const c = byId(d, 'c');
    const filled = await data.scope(target, d).resolve(c);
    const preview = { ...target, preview: true };
    expect(await data.scope(preview, d).resolve(c)).not.toBe(filled);
    expect(await data.scope(target, d, { seed: () => undefined }).resolve(c)).not.toBe(filled);
    data.dropCaches();
    const one = await data.scope(preview, d).resolve(c);
    expect(await data.scope(preview, d).resolve(c)).not.toBe(one);
    const seeded = () => data.scope(target, d, { seed: () => undefined });
    const tick = await seeded().resolve(c);
    expect(await seeded().resolve(c)).not.toBe(tick);
    expect(await data.scope(target, d).resolve(c)).not.toBe(tick);
  });

  it('computes a child again when a dataset it reads is edited, and only then', async () => {
    const runner = new CountingRunner();
    const data = new DataService(connectors, store, runner);
    const edited = (expr: string, ...more: unknown[]) =>
      doc(
        inline('w', cities, { transforms: [{ type: 'derive', as: 'f', expr }] }),
        from('c', 'w', { transforms: [{ type: 'filter', expr: 'f > 3' }] }),
        ...more,
      );
    const a = edited('temp * 2');
    const first = await data.scope(target, a).resolve(byId(a, 'c'));
    const b = edited('temp * 10');
    const changed = await data.scope(target, b).resolve(byId(b, 'c'));
    expect(changed).not.toBe(first);
    expect(changed.hash).not.toBe(first.hash);
    // A new document object with the same lineage, even with an unrelated dataset added, is the same result.
    const same = edited('temp * 2', inline('other', [{ x: 1 }]));
    expect(await data.scope(target, same).resolve(byId(same, 'c'))).toBe(first);
  });

  it('never shares a result between dashboards or row caps', async () => {
    const data = new DataService(connectors, store, new CountingRunner());
    controlled(data);
    const d = chain();
    const c = byId(d, 'c');
    const first = await data.scope(target, d).resolve(c);
    expect(await data.scope({ id: 'other01', ownerId: null }, d).resolve(c)).not.toBe(first);
    expect(await data.scope(target, d).resolve(c, { maxRows: 1 })).not.toBe(first);
    expect(await data.scope(target, d).resolve(c)).toBe(first);
  });

  it('does not keep a failed run', async () => {
    class Flaky extends InlineRunner {
      fail = 1;
      override async run(...args: RunArgs) {
        if (this.fail-- > 0) throw new Error('Processing crashed');
        return super.run(...args);
      }
    }
    const data = new DataService(connectors, store, new Flaky());
    controlled(data);
    const d = chain();
    expect((await data.scope(target, d).resolve(byId(d, 'c'))).error).toBeTruthy();
    const good = await data.scope(target, d).resolve(byId(d, 'c'));
    expect(good.error).toBeUndefined();
    expect(good.table.rows).toHaveLength(1);
  });

  it("lets a scope that joins another's computation keep its own deadline", async () => {
    class Slow extends InlineRunner {
      override async run(...args: RunArgs) {
        await new Promise((r) => setTimeout(r, 150));
        return super.run(...args);
      }
    }
    const data = new DataService(connectors, store, new Slow());
    controlled(data);
    const d = chain();
    const hurried = data.scope(target, d, { deadlineMs: 60 }).resolve(byId(d, 'c'));
    await new Promise((r) => setTimeout(r, 10));
    const patient = data.scope(target, d).resolve(byId(d, 'c'));
    const [h, p] = await Promise.all([hurried, patient]);
    expect(h.error).toBe(SCOPE_TIMEOUT_MESSAGE);
    expect(h.retryAfterSec).toBeUndefined();
    expect(p.error).toBeUndefined();
    expect(p.table.rows).toHaveLength(1);
  });

  it('finishes a large chain admitted before memory rose, and refuses one that starts under pressure', async () => {
    const limit = 384 * 1024 * 1024;
    let fraction = 0.3;
    memoryGuard.configure({
      reader: () => ({ usedBytes: fraction * limit, limitBytes: limit, source: 'cgroup v2' }),
      sampleMs: 0,
      collect: () => {},
      log: () => {},
    });
    try {
      // The parent's run fills memory past the soft line, as a cold burst does before its children get their turn.
      class Filling extends InlineRunner {
        override async run(...args: RunArgs) {
          const r = await super.run(...args);
          fraction = 0.75;
          return r;
        }
      }
      const data = new DataService(connectors, store, new Filling());
      const big = inferTable(
        Array.from({ length: HEAVY_PIPELINE_CELLS / 2 }, (_, i) => ({ a: i, b: i % 7 })),
      );
      vi.spyOn(data, 'loadSource').mockImplementation(async () => ({
        table: big,
        fetchedAt: 1,
        credentialKey: '',
      }));
      const d = doc(
        inline('w', cities, { transforms: [{ type: 'derive', as: 'c2', expr: 'b * 2' }] }),
        from('c', 'w', {
          transforms: [{ type: 'aggregate', groupBy: ['b'], metrics: [{ op: 'count', as: 'n' }] }],
        }),
        from('e', 'w', { transforms: [{ type: 'filter', expr: 'b > 3' }] }),
      );
      const child = await data.scope(target, d).resolve(byId(d, 'c'));
      expect(child.error).toBeUndefined();
      expect(child.table.rows).toHaveLength(7);
      await expect(data.scope(target, d).resolve(byId(d, 'e'))).rejects.toBeInstanceOf(MemoryPressureError);
      expect(memoryGuard.heavyRunning()).toBe(0);
    } finally {
      memoryGuard.configure({ reader: null });
    }
  });

  it('lets only a chain admitted below the line continue when cold chains on other tables pile up', async () => {
    const limit = 512 * 1024 * 1024;
    let fraction = 0.3;
    memoryGuard.configure({
      reader: () => ({ usedBytes: fraction * limit, limitBytes: limit, source: 'cgroup v2' }),
      sampleMs: 0,
      collect: () => {},
      log: () => {},
    });
    try {
      const runs: string[] = [];
      class Filling extends InlineRunner {
        override async run(...args: RunArgs) {
          runs.push(args[1].map((t) => t.type).join(','));
          await new Promise((r) => setTimeout(r, 10));
          // Past the hard line once the first run is done, as wall screens reconnecting after a restart can do.
          fraction = 0.97;
          return super.run(...args);
        }
      }
      const data = new DataService(connectors, store, new Filling());
      const tables = new Map<string, DataTable>();
      vi.spyOn(data, 'loadSource').mockImplementation(async (t) => {
        if (!tables.has(t.id))
          tables.set(
            t.id,
            inferTable(Array.from({ length: HEAVY_PIPELINE_CELLS / 2 }, (_, i) => ({ a: i, b: i % 7 }))),
          );
        return { table: tables.get(t.id)!, fetchedAt: 1, credentialKey: '' };
      });
      const d = doc(
        inline('w', cities, { transforms: [{ type: 'derive', as: 'c2', expr: 'b * 2' }] }),
        from('c', 'w', { transforms: [{ type: 'filter', expr: 'b > 3' }] }),
      );
      const settled = await Promise.allSettled(
        [0, 1, 2, 3].map((i) => data.scope({ id: `dash${i}`, ownerId: null }, d).resolve(byId(d, 'c'))),
      );
      expect(settled[0]!.status).toBe('fulfilled');
      for (const s of settled.slice(1))
        expect((s as PromiseRejectedResult).reason).toBeInstanceOf(MemoryPressureError);
      expect(runs).toEqual(['derive', 'filter']);
      expect(memoryGuard.heavyRunning()).toBe(0);
    } finally {
      memoryGuard.configure({ reader: null });
    }
  });

  it('forgets final results when the memory guard drops the caches', async () => {
    const data = new DataService(connectors, store, new CountingRunner());
    controlled(data);
    const d = chain();
    const first = await data.scope(target, d).resolve(byId(d, 'c'));
    data.dropCaches();
    expect(await data.scope(target, d).resolve(byId(d, 'c'))).not.toBe(first);
  });

  it('never keeps the result of a chain over an accumulating root', async () => {
    const data = new DataService(connectors, store, new CountingRunner());
    controlled(data);
    const d = doc(inline('hist', cities, { accumulate: 10 }), from('kid', 'hist'));
    const first = await data.scope(target, d).resolve(byId(d, 'kid'));
    expect(await data.scope(target, d).resolve(byId(d, 'kid'))).not.toBe(first);
  });
});

describe('processShared', () => {
  const unionDoc = () =>
    doc(
      inline('x', [{ i: 1 }], { transforms: [{ type: 'union', with: ['big'] }] }),
      inline('big', [{ i: 2 }]),
    );
  const self = { id: 'x', name: 'X' };
  const rowsOf = (n: number, from = 0) =>
    inferTable(Array.from({ length: n }, (_, k) => ({ i: from + k, j: k })));

  it('never shares a result between runs that read different tables', async () => {
    const data = new DataService(connectors, store);
    const steps = byId(unionDoc(), 'x').transforms;
    const main = inferTable([{ i: 1, j: 0 }]);
    const [one, two] = await Promise.all([
      data.processShared(main, steps, { tables: { big: { name: 'Big', table: rowsOf(1, 10) } }, self }),
      data.processShared(main, steps, { tables: { big: { name: 'Big', table: rowsOf(1, 20) } }, self }),
    ]);
    expect(one.table.rows.map((r) => r.i)).toEqual([1, 10]);
    expect(two.table.rows.map((r) => r.i)).toEqual([1, 20]);
  });

  it('counts the tables a step reads when deciding on a heavy turn', async () => {
    const data = new DataService(connectors, store);
    const heavy = vi.spyOn(heavyWork, 'run');
    try {
      const steps = byId(unionDoc(), 'x').transforms;
      const main = inferTable([{ i: 1, j: 0 }]);
      await data.processShared(main, steps, { tables: { big: { name: 'Big', table: rowsOf(3) } }, self });
      expect(heavy).not.toHaveBeenCalled();
      const big = rowsOf(HEAVY_PIPELINE_CELLS / 2);
      const r = await data.processShared(main, steps, { tables: { big: { name: 'Big', table: big } }, self });
      expect(r.table.rows).toHaveLength(HEAVY_PIPELINE_CELLS / 2 + 1);
      expect(heavy).toHaveBeenCalledTimes(1);
    } finally {
      heavy.mockRestore();
    }
  });

  it('counts a table a union repeats once per reference for the heavy turn', async () => {
    const data = new DataService(connectors, store);
    const heavy = vi.spyOn(heavyWork, 'run');
    try {
      // A quarter of the heavy threshold, read four times: as much work as one table at the threshold.
      const repeated = doc(
        inline('x', [{ i: 1 }], { transforms: [{ type: 'union', with: ['big', 'big', 'big', 'big'] }] }),
        inline('big', [{ i: 2 }]),
      );
      const steps = byId(repeated, 'x').transforms;
      const main = inferTable([{ i: 1, j: 0 }]);
      const big = rowsOf(HEAVY_PIPELINE_CELLS / 8);
      const r = await data.processShared(main, steps, { tables: { big: { name: 'Big', table: big } }, self });
      expect(r.table.rows).toHaveLength(1 + 4 * (HEAVY_PIPELINE_CELLS / 8));
      expect(heavy).toHaveBeenCalledTimes(1);
    } finally {
      heavy.mockRestore();
    }
  });
});
