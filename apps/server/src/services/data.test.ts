import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Dataset, DatasetSchema, inferTable, type PipelineResult } from '@patchbay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';
import { BusyError, Gate } from '../util/gate.ts';
import { OutboundLimiter } from '../util/outbound.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  safeFetchJson: (url: string) => fetchMock(url),
}));

const { DataService } = await import('./data.ts');
const { InlineRunner } = await import('./pipeline-pool.ts');

let dir: string;
let store: FolderStore;
const connectors = new ConnectorService({ offline: true });
const target = { id: 'dash01', ownerId: null };

const dataset = (source: unknown, extra: Record<string, unknown> = {}): Dataset =>
  DatasetSchema.parse({ id: 'd', name: 'D', source, ...extra });

async function saveUpload(fileId: string, rows: number) {
  const table = inferTable(Array.from({ length: rows }, (_, i) => ({ a: i, b: `v${i}` })));
  await store.saveFile(target.id, {
    id: fileId,
    name: 'f.csv',
    rows,
    columns: 2,
    size: 1,
    uploadedAt: new Date().toISOString(),
    table,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-data-test-'));
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

describe('uploaded files', () => {
  it('parses a stored file once for concurrent and repeated reads, and again when it changes', async () => {
    await saveUpload('f_once', 3000);
    const data = new DataService(connectors, store);
    const read = vi.spyOn(store, 'readFileTable');
    const ds = dataset({ kind: 'upload', fileId: 'f_once' });
    const results = await Promise.all(Array.from({ length: 16 }, () => data.resolve(target, ds)));
    expect(results.every((r) => r.table.rows.length === 3000 && !r.error)).toBe(true);
    await data.resolve(target, ds);
    expect(read).toHaveBeenCalledTimes(1);
    // A rewritten file (here: same id, new content) is noticed by its stamp.
    await new Promise((r) => setTimeout(r, 20));
    await saveUpload('f_once', 10);
    expect((await data.resolve(target, ds)).table.rows).toHaveLength(10);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  });

  it('keeps the fetch time of a file stable, so reading it is not a new reading for accumulate', async () => {
    await saveUpload('f_acc', 5);
    const data = new DataService(connectors, store);
    const ds = dataset({ kind: 'upload', fileId: 'f_acc' }, { accumulate: 100 });
    const first = await data.resolve(target, ds);
    const second = await data.resolve(target, ds);
    const third = await data.resolve(target, ds);
    expect(first.table.rows).toHaveLength(5);
    expect(third.table.rows).toHaveLength(5);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it('parses a file shared by a copy (hard link) once, and keeps serving the copy after the original is gone', async () => {
    await saveUpload('f_shared', 200);
    const copy = { id: 'dash02', ownerId: null };
    await store.create(
      {
        id: copy.id,
        ownerId: null,
        ownerEmail: null,
        visibility: 'public',
        editKeyHash: null,
        version: 1,
        createdAt: '',
        updatedAt: '',
        lastViewedAt: '',
      },
      { title: 'c', datasets: [], widgets: [] } as never,
      { kind: 'anonymous', label: 'Anonymous' },
      ['Created'],
    );
    await store.linkFile(target.id, copy.id, 'f_shared');
    const data = new DataService(connectors, store);
    const read = vi.spyOn(store, 'readFileTable');
    const ds = dataset({ kind: 'upload', fileId: 'f_shared' });
    const [a, b] = await Promise.all([data.resolve(target, ds), data.resolve(copy, ds)]);
    expect(a.table.rows).toHaveLength(200);
    expect(b.table.rows).toHaveLength(200);
    expect(b.fetchedAt).toBe(a.fetchedAt);
    expect(read).toHaveBeenCalledTimes(1);
    await store.deleteFile(target.id, 'f_shared');
    await expect(data.resolve(target, ds)).resolves.toMatchObject({ error: expect.any(String) });
    expect((await data.resolve(copy, ds)).table.rows).toHaveLength(200);
    read.mockRestore();
  });

  it('does the same for inline rows', async () => {
    const data = new DataService(connectors, store);
    const ds = dataset({ kind: 'inline', rows: [{ a: 1 }, { a: 2 }] }, { accumulate: 50 });
    await data.resolve(target, ds);
    expect((await data.resolve(target, ds)).table.rows).toHaveLength(2);
  });

  it('answers busy instead of queueing without limit, and does not fold that into the result', async () => {
    await saveUpload('f_busy', 10);
    const heavy = new Gate({ concurrency: 1, maxQueue: 0 });
    const data = new DataService(connectors, store, new InlineRunner(), { heavy });
    let release!: () => void;
    const held = heavy.run('other', () => new Promise<void>((r) => (release = r)));
    await expect(data.resolve(target, dataset({ kind: 'upload', fileId: 'f_busy' }))).rejects.toBeInstanceOf(
      BusyError,
    );
    release();
    await held;
    expect(
      (await data.resolve(target, dataset({ kind: 'upload', fileId: 'f_busy' }))).table.rows,
    ).toHaveLength(10);
  });
});

describe('results', () => {
  it('computes a pipeline once for concurrent identical requests', async () => {
    await saveUpload('f_pipe', 100);
    const runner = new InlineRunner();
    const run = vi.spyOn(runner, 'run');
    const data = new DataService(connectors, store, runner);
    const ds = dataset({ kind: 'upload', fileId: 'f_pipe' }, { transforms: [{ type: 'limit', n: 5 }] });
    const results = await Promise.all(Array.from({ length: 10 }, () => data.resolve(target, ds)));
    expect(results.every((r) => r.table.rows.length === 5)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    // Other steps are another result.
    const other = dataset({ kind: 'upload', fileId: 'f_pipe' }, { transforms: [{ type: 'limit', n: 7 }] });
    expect((await data.resolve(target, other)).table.rows).toHaveLength(7);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not share results across input tables', async () => {
    const runner = { run: vi.fn(async (t): Promise<PipelineResult> => ({ table: t, trace: [] })) };
    const data = new DataService(connectors, store, { ...runner, parseUpload: vi.fn(), close: vi.fn() });
    const a = await data.resolve(target, dataset({ kind: 'inline', rows: [{ a: 1 }] }));
    const b = await data.resolve(target, dataset({ kind: 'inline', rows: [{ a: 2 }] }));
    expect(a.table.rows).toEqual([{ a: 1 }]);
    expect(b.table.rows).toEqual([{ a: 2 }]);
  });
});

describe('http sources', () => {
  const http = (url: string) => dataset({ kind: 'http', url });

  it('remembers a failing address instead of asking it again on every read', async () => {
    // A response without records fails in the service itself, like any upstream error would.
    fetchMock.mockResolvedValue(5);
    const data = new DataService(connectors, store);
    for (let i = 0; i < 5; i++) {
      expect((await data.resolve(target, http('https://fails.example/x'))).error).toBe(
        'The response does not contain a list of records',
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps at most maxSourceCells cells of a response and says so', async () => {
    const wide = Array.from({ length: 1000 }, (_, i) =>
      Object.fromEntries(Array.from({ length: 10 }, (_, c) => [`c${c}`, i])),
    );
    fetchMock.mockResolvedValue(wide);
    const data = new DataService(connectors, store, new InlineRunner(), { maxSourceCells: 2500 });
    const r = await data.resolve(target, http('https://wide.example/x'));
    expect(r.table.rows).toHaveLength(250);
    expect(r.error).toMatch(/first 250 rows/);
  });

  it('applies the URL policy before fetching, for http and feed sources', async () => {
    const policy = vi.fn(() => {
      throw new HttpError(403, 'No URLs here');
    });
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy, offline: true });
    expect((await data.resolve(target, http('https://a.example/x'))).error).toBe('No URLs here');
    expect((await data.resolve(target, dataset({ kind: 'feed', url: 'https://a.example/f' }))).error).toBe(
      'No URLs here',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('limits requests per host, without remembering its own refusal as a failure', async () => {
    let finish!: (v: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((r) => (finish = r)));
    const outbound = new OutboundLimiter({ perHostConcurrency: 1 });
    const data = new DataService(connectors, store, new InlineRunner(), { outbound });
    const slow = data.resolve(target, http('https://host.example/a'));
    const refused = await data.resolve(target, http('https://host.example/b'));
    expect(refused.error).toMatch(/already loading a lot from host\.example/);
    // Another host is not affected.
    fetchMock.mockResolvedValueOnce([{ x: 1 }]);
    expect((await data.resolve(target, http('https://other.example/a'))).table.rows).toEqual([{ x: 1 }]);
    finish([{ y: 1 }]);
    await slow;
    fetchMock.mockResolvedValue([{ z: 1 }]);
    expect((await data.resolve(target, http('https://host.example/b'))).table.rows).toEqual([{ z: 1 }]);
  });
});

describe('refresh intervals', () => {
  const data = new DataService(connectors, store);
  it('never refreshes static sources and keeps the cache floors', () => {
    expect(data.refreshIntervalSec(dataset({ kind: 'upload', fileId: 'f' }, { refreshSec: 1 }))).toBeNull();
    expect(data.refreshIntervalSec(dataset({ kind: 'inline', rows: [] }, { refreshSec: 1 }))).toBeNull();
    expect(
      data.refreshIntervalSec(dataset({ kind: 'http', url: 'https://a.example' }, { refreshSec: 1 })),
    ).toBe(30);
    expect(
      data.refreshIntervalSec(dataset({ kind: 'http', url: 'https://a.example' }, { refreshSec: 90 })),
    ).toBe(90);
    expect(
      data.refreshIntervalSec(dataset({ kind: 'feed', url: 'https://a.example' }, { refreshSec: 1 })),
    ).toBe(300);
    expect(data.refreshIntervalSec(dataset({ kind: 'http', url: 'https://a.example' }))).toBeNull();
  });
});
