import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DashboardDoc,
  DashboardDocSchema,
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
