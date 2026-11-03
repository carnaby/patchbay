import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DashboardDoc,
  DashboardDocSchema,
  DatasetSchema,
  type DataTable,
  inferTable,
  type PipelineInputs,
  type Transform,
} from '@patchbay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HEAVY_PIPELINE_CELLS, heavyWork } from '../util/heavy.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  safeFetchJson: (url: string) => fetchMock(url),
}));

const { DataService } = await import('./data.ts');
const { InlineRunner } = await import('./pipeline-pool.ts');
const { SCOPE_TIMEOUT_MESSAGE } = await import('./scope.ts');

class CountingRunner extends InlineRunner {
  runs: string[] = [];
  reads: string[][] = [];
  override async run(table: DataTable, transforms: Transform[], inputs?: PipelineInputs) {
    this.runs.push(transforms.map((t) => t.type).join(','));
    this.reads.push(Object.keys(inputs?.tables ?? {}));
    return super.run(table, transforms, inputs);
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
    expect(child.error).toBe('Source dataset "p" has more than 100,000 rows; only its last 100,000 are used');
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
    expect((await data.scope(target, d).resolve(byId(d, 'mix'))).error).toBe('SA is stale; SB is stale');
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
    expect((await data.scope(target, d).resolve(byId(d, 'c'))).error).toBe(
      'Showing the first 5 rows of the inline rows',
    );
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
    expect((await slow.resolve(byId(d, 'c'))).error).toBe(SCOPE_TIMEOUT_MESSAGE);
    const draft = { ...byId(d, 'c'), id: 'draft' };
    expect((await data.scope(target, d, { deadlineMs: 0 }).resolve(draft)).error).toBe(SCOPE_TIMEOUT_MESSAGE);
    // Any orphaned rejection surfaces on a later turn of the event loop and fails this file.
    await new Promise((r) => setTimeout(r, 20));
  });

  it('names a cycle that slipped past validation instead of overflowing the stack', async () => {
    const data = new DataService(connectors, store);
    const valid = doc(inline('a', cities), from('b', 'a'));
    const cyclic = { ...valid, datasets: [DatasetSchema.parse(from('a', 'b')), byId(valid, 'b')] };
    expect((await data.scope(target, cyclic).resolve(byId(cyclic, 'a'))).error).toBe(
      'Datasets "a" → "b" → "a" form a cycle',
    );
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
    const preview = { ...target, preview: true };
    const one = await data.scope(preview, d).resolve(c);
    expect(await data.scope(preview, d).resolve(c)).not.toBe(one);
    const seeded = () => data.scope(target, d, { seed: () => undefined });
    const tick = await seeded().resolve(c);
    expect(await seeded().resolve(c)).not.toBe(tick);
    expect(await data.scope(target, d).resolve(c)).not.toBe(tick);
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
});
