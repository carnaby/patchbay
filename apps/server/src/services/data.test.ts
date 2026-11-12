import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHED_DATA_WARNING,
  type Dataset,
  DatasetSchema,
  inferTable,
  type PipelineResult,
} from '@patchbay/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HttpError, lastingError } from '../util/errors.ts';
import { BusyError, Gate } from '../util/gate.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import { parsePrivateHosts } from '../util/private-hosts.ts';
import { URL_MESSAGES } from '../util/safe-fetch.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string, options?: unknown) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  safeFetchJson: (url: string, options?: unknown) => fetchMock(url, options),
}));

const { DataService, httpCacheKey, recordsFrom } = await import('./data.ts');
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

  it('refuses stored inline rows wider than the column limit, once, with a message instead of the table', async () => {
    // What a document saved before the write limit, or written by hand, can hold: 94 million cells if built.
    const rows = [
      Object.fromEntries(Array.from({ length: 47_000 }, (_, i) => [`k${i}`, 1])),
      ...Array.from({ length: 1999 }, () => ({})),
    ];
    const data = new DataService(connectors, store);
    const ds = dataset({ kind: 'inline', rows });
    const startedAt = Date.now();
    const first = await data.resolve(target, ds);
    expect(first.error).toMatch(/more than 500 columns/);
    expect(first.table.rows).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    // Inline rows are part of the document: only an edit changes the answer, also when it comes from the cache.
    expect(first.lasting).toBe(true);
    const again = await data.resolve(target, ds);
    expect(again.error).toBe(first.error);
    expect(again.lasting).toBe(true);
    // Narrower stored rows still load, cut to the source cell limit with a warning.
    const narrow = dataset({
      kind: 'inline',
      rows: [Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])), ...rows.slice(1)],
    });
    const capped = await new DataService(connectors, store, new InlineRunner(), {
      maxSourceCells: 30_000,
    }).resolve(target, narrow);
    expect(capped.table.columns).toHaveLength(300);
    expect(capped.table.rows).toHaveLength(100);
    expect(capped.warning).toMatch(/first 100 rows of the inline rows/);
    expect(capped.error).toBeUndefined();
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

  it('marks a cached connector copy with the text the widget badge reads as stale', async () => {
    const service = new ConnectorService({ offline: true });
    vi.spyOn(service, 'load').mockResolvedValue({
      table: inferTable([{ a: 1 }]),
      fetchedAt: 1_000,
      stale: 'upstream is down',
    });
    const r = await new DataService(service, store).resolve(
      target,
      dataset({ kind: 'connector', connector: 'weather.current', params: {} }),
    );
    expect(r.error).toBeUndefined();
    expect(r.warning).toBe(`${CACHED_DATA_WARNING}: upstream is down`);
  });
});

describe('http sources', () => {
  const http = (url: string) => dataset({ kind: 'http', url });
  const post = (url: string, body?: unknown) =>
    dataset({ kind: 'http', url, method: 'POST', ...(body === undefined ? {} : { body }) });

  /** A metrics API answer in columns: an ISO time, a number with a gap, a status. */
  const METRICS = {
    timestamps: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', '2026-11-01T02:00:00Z'],
    values: [12.5, null, 14],
    status: ['ok', 'warn', 'ok'],
  };

  it('turns a column-shaped response into one row per position with every column', async () => {
    fetchMock.mockResolvedValue(METRICS);
    const data = new DataService(connectors, store);
    const r = await data.resolve(target, http('https://metrics.example/series'));
    expect(r.error).toBeUndefined();
    expect(r.table.columns).toEqual([
      { name: 'timestamps', type: 'time' },
      { name: 'values', type: 'number' },
      { name: 'status', type: 'string' },
    ]);
    expect(r.table.rows).toEqual([
      { timestamps: Date.parse('2026-11-01T00:00:00Z'), values: 12.5, status: 'ok' },
      { timestamps: Date.parse('2026-11-01T01:00:00Z'), values: null, status: 'warn' },
      { timestamps: Date.parse('2026-11-01T02:00:00Z'), values: 14, status: 'ok' },
    ]);
  });

  it('reads record-shaped, single-list and loose objects exactly as before', async () => {
    const bodies: Record<string, unknown> = {
      'https://shapes.example/envelope': { count: 2, results: [{ a: 1 }, { a: 2 }] },
      'https://shapes.example/single': { values: [1, 2, 3] },
      'https://shapes.example/unequal': { timestamps: [1, 2, 3], values: [5, 6] },
      'https://shapes.example/nested': { timestamps: [1, 2], values: [{ v: 5 }, { v: 6 }] },
    };
    fetchMock.mockImplementation(async (url) => bodies[url]);
    const data = new DataService(connectors, store);
    const rows = async (name: string) =>
      (await data.resolve(target, http(`https://shapes.example/${name}`))).table.rows;
    expect(await rows('envelope')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await rows('single')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(await rows('unequal')).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(await rows('nested')).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('converts column-shaped data at a path, and names a missing path as before', async () => {
    fetchMock.mockResolvedValue({ data: METRICS });
    const data = new DataService(connectors, store);
    const at = (path: string) =>
      data.resolve(target, dataset({ kind: 'http', url: 'https://paths.example/x', path }));
    expect((await at('data')).table.rows).toHaveLength(3);
    expect((await at('data.items')).error).toBe(
      'Path "data.items" not found in the response (stopped at "items")',
    );
  });

  it('builds no more rows from a long column-shaped response than the cell limit keeps, and says so', async () => {
    const n = 100_000;
    fetchMock.mockResolvedValue({
      t: Array.from({ length: n }, (_, i) => i),
      v: Array.from({ length: n }, () => 1),
    });
    const data = new DataService(connectors, store, new InlineRunner(), { maxSourceCells: 500 });
    const r = await data.resolve(target, http('https://dense.example/x'));
    expect(r.table.rows).toHaveLength(250);
    expect(r.warning).toMatch(/first 250 rows/);
    expect(r.error).toBeUndefined();
  });

  it('bounds the rows recordsFrom builds by the cell limit it is given', () => {
    const long = { t: Array.from({ length: 1000 }, (_, i) => i), v: Array.from({ length: 1000 }, () => 1) };
    expect(recordsFrom(long, undefined, 500)).toHaveLength(251);
  });

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

  it('remembers whether a failing address can pass without an edit', async () => {
    // Once each: the second read of an address comes from the error cache.
    fetchMock.mockRejectedValueOnce(lastingError(400, URL_MESSAGES.privateOff));
    const data = new DataService(connectors, store);
    const ds = http('https://refused.example/x');
    for (let i = 0; i < 2; i++) {
      const r = await data.resolve(target, ds);
      expect(r.error).toBe(URL_MESSAGES.privateOff);
      expect(r.lasting).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // An upstream 4xx is the upstream's answer of the moment: transient, from the cache too.
    fetchMock.mockRejectedValueOnce(new HttpError(502, 'Upstream responded 404'));
    const gone = http('https://gone.example/x');
    for (let i = 0; i < 2; i++) {
      const r = await data.resolve(target, gone);
      expect(r.error).toBe('Upstream responded 404');
      expect(r).not.toHaveProperty('lasting');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks invalid connector params, an unknown connector and a missing upload as lasting', async () => {
    const data = new DataService(connectors, store);
    for (const source of [
      { kind: 'connector', connector: 'earthquakes', params: { period: 'century' } },
      { kind: 'connector', connector: 'no-such-connector', params: {} },
      { kind: 'upload', fileId: 'f_missing' },
    ]) {
      const r = await data.resolve(target, dataset(source));
      expect(r.error, source.kind).toBeTruthy();
      expect(r.lasting, JSON.stringify(source)).toBe(true);
    }
  });

  it('does not serve the cached error of one POST body to another body on the same URL', async () => {
    const url = 'https://api.example/q';
    fetchMock.mockImplementation(async (_url, options) => {
      if ((options as { body?: { q: string } } | undefined)?.body?.q === 'a')
        throw new HttpError(502, 'Upstream is down');
      return [{ ok: 1 }];
    });
    const data = new DataService(connectors, store);
    for (let i = 0; i < 2; i++)
      expect((await data.resolve(target, post(url, { q: 'a' }))).error).toBe('Upstream is down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const b = await data.resolve(target, post(url, { q: 'b' }));
    expect(fetchMock.mock.calls.map((c) => (c[1] as { body: unknown }).body)).toEqual([
      { q: 'a' },
      { q: 'b' },
    ]);
    expect(b.error).toBeUndefined();
    expect(b.table.rows).toEqual([{ ok: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And the other way round: the cached success of body b does not hide that body a fails.
    expect((await data.resolve(target, post(url, { q: 'a' }))).error).toBe('Upstream is down');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the private hosts the policy grants, and never serves those responses to other dashboards', async () => {
    const lan = parsePrivateHosts('192.168.1.0/24')!;
    const policy = vi.fn((t: { ownerId: string | null }) => (t.ownerId === 'admin' ? lan : null));
    fetchMock.mockResolvedValueOnce([{ who: 'lan' }]).mockResolvedValueOnce([{ who: 'public' }]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    const url = 'https://nas.example/api';
    expect((await data.resolve({ id: target.id, ownerId: 'admin' }, http(url))).table.rows).toEqual([
      { who: 'lan' },
    ]);
    expect((await data.resolve(target, http(url))).table.rows).toEqual([{ who: 'public' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ privateHosts: lan });
    expect(fetchMock.mock.calls[1]![1]).not.toHaveProperty('privateHosts');
  });

  it('hands the policy the method and body of a POST, and no body for a GET', async () => {
    const policy = vi.fn(() => null);
    fetchMock.mockResolvedValue([{ ok: 1 }]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    await data.resolve(target, post('https://api.example/q', { q: 'a' }));
    await data.resolve(target, http('https://api.example/g'));
    expect(policy.mock.calls.map((c) => c.slice(1))).toEqual([
      ['https://api.example/q', 'POST', { q: 'a' }],
      ['https://api.example/g', 'GET', undefined],
    ]);
  });

  it('does not share a concurrent fetch between a dashboard with the private hosts and one without', async () => {
    const lan = parsePrivateHosts('192.168.1.0/24')!;
    const policy = (t: { ownerId: string | null }) => (t.ownerId === 'admin' ? lan : null);
    fetchMock.mockImplementation(async (_url, options) => [
      { who: (options as { privateHosts?: unknown } | undefined)?.privateHosts ? 'lan' : 'public' },
    ]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    const url = 'https://nas.example/slow';
    const [a, b] = await Promise.all([
      data.resolve({ id: target.id, ownerId: 'admin' }, http(url)),
      data.resolve(target, http(url)),
    ]);
    expect(a.table.rows).toEqual([{ who: 'lan' }]);
    expect(b.table.rows).toEqual([{ who: 'public' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps at most maxSourceCells cells of a response and says so', async () => {
    const wide = Array.from({ length: 1000 }, (_, i) =>
      Object.fromEntries(Array.from({ length: 10 }, (_, c) => [`c${c}`, i])),
    );
    fetchMock.mockResolvedValue(wide);
    const data = new DataService(connectors, store, new InlineRunner(), { maxSourceCells: 2500 });
    const r = await data.resolve(target, http('https://wide.example/x'));
    expect(r.table.rows).toHaveLength(250);
    expect(r.warning).toMatch(/first 250 rows/);
    expect(r.error).toBeUndefined();
  });

  it('never builds more than maxSourceCells cells when a wide record follows narrow ones', async () => {
    // Judging the width from the first 200 records let this build 400 columns for every one of 100,000 rows.
    const wideRecord = Object.fromEntries(Array.from({ length: 400 }, (_, c) => [`c${c}`, c]));
    fetchMock.mockResolvedValue([
      ...Array.from({ length: 200 }, () => ({})),
      wideRecord,
      ...Array.from({ length: 99_799 }, () => ({})),
    ]);
    const data = new DataService(connectors, store, new InlineRunner(), { maxSourceCells: 500_000 });
    const r = await data.resolve(target, http('https://late-wide.example/x'));
    expect(r.table.columns).toHaveLength(400);
    expect(r.table.rows.length * r.table.columns.length).toBeLessThanOrEqual(500_000);
    expect(r.warning).toMatch(/first 1,250 rows/);
    fetchMock.mockResolvedValue([
      {},
      Object.fromEntries(Array.from({ length: 47_000 }, (_, c) => [`k${c}`, 1])),
    ]);
    expect((await data.resolve(target, http('https://very-wide.example/x'))).error).toMatch(
      /more than 500 columns/,
    );
  });

  it('applies the URL policy before fetching, for http and feed sources', async () => {
    const policy = vi.fn(() => {
      throw lastingError(403, 'No URLs here');
    });
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy, offline: true });
    const refused = await data.resolve(target, http('https://a.example/x'));
    expect(refused.error).toBe('No URLs here');
    expect(refused.lasting).toBe(true);
    expect((await data.resolve(target, dataset({ kind: 'feed', url: 'https://a.example/f' }))).error).toBe(
      'No URLs here',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('queues requests to a busy host, refuses beyond the queue, and does not remember that refusal', async () => {
    const finish: ((v: unknown) => void)[] = [];
    fetchMock.mockImplementation((url) =>
      url.startsWith('https://other.example/')
        ? Promise.resolve([{ x: 1 }])
        : new Promise((r) => finish.push(r)),
    );
    const outbound = new OutboundLimiter({ perHostConcurrency: 1, maxQueuedPerClient: 1 });
    const data = new DataService(connectors, store, new InlineRunner(), { outbound });
    const first = data.resolve(target, http('https://host.example/a'));
    const second = data.resolve(target, http('https://host.example/b'));
    const refused = await data.resolve(target, http('https://host.example/c'));
    expect(refused.error).toMatch(/already loading a lot from host\.example/);
    expect(refused.retryAfterSec).toBe(10);
    // Another host is not affected: it neither waits behind host.example nor counts against its queue.
    expect((await data.resolve(target, http('https://other.example/a'))).table.rows).toEqual([{ x: 1 }]);
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    finish[0]!([{ y: 1 }]);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[1]!([{ y: 2 }]);
    expect((await first).table.rows).toEqual([{ y: 1 }]);
    expect((await second).table.rows).toEqual([{ y: 2 }]);
    fetchMock.mockResolvedValue([{ z: 1 }]);
    expect((await data.resolve(target, http('https://host.example/c'))).table.rows).toEqual([{ z: 1 }]);
  });

  it('keeps the cache key of a GET exactly as it was, and gives every POST body its own', () => {
    const get = { kind: 'http' as const, url: 'https://a.example/x', path: 'items' };
    // The formula of v0.2.1, byte for byte: a deploy must not empty the cache.
    expect(httpCacheKey(get, '', false)).toBe('http:|https://a.example/x#items');
    expect(httpCacheKey({ ...get, method: 'GET' }, 'u1/sec_A@2', true)).toBe(
      'http:lan|u1/sec_A@2|https://a.example/x#items',
    );
    const one = httpCacheKey({ ...get, method: 'POST', body: { q: 1 } }, '', false);
    expect(one).toMatch(/^http:\|POST:[A-Za-z0-9_-]{43}\|https:\/\/a\.example\/x#items$/);
    const keys = [
      one,
      httpCacheKey({ ...get, method: 'POST', body: { q: 2 } }, '', false),
      httpCacheKey({ ...get, method: 'POST' }, '', false),
      httpCacheKey({ ...get, method: 'POST', body: null }, '', false),
      httpCacheKey({ ...get, method: 'POST', body: 'text' }, '', false),
      httpCacheKey({ ...get, method: 'POST', body: { q: 1 } }, 'u1/sec_A@2', false),
      httpCacheKey({ ...get, method: 'POST', body: { q: 1 } }, '', true),
      httpCacheKey(get, '', false),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sends a POST with its body, caches it per body and never answers a GET with it', async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      const o = (options ?? {}) as { method?: string; body?: unknown };
      return [{ method: o.method ?? 'GET', got: JSON.stringify(o.body ?? null) }];
    });
    const data = new DataService(connectors, store);
    const url = 'https://post.example/graphql';
    const one = await data.resolve(target, post(url, { q: 1 }));
    const two = await data.resolve(target, post(url, { q: 2 }));
    const get = await data.resolve(target, http(url));
    expect(one.table.rows).toEqual([{ method: 'POST', got: '{"q":1}' }]);
    expect(two.table.rows).toEqual([{ method: 'POST', got: '{"q":2}' }]);
    expect(get.table.rows).toEqual([{ method: 'GET', got: 'null' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Within the TTL each is answered from its own entry.
    expect((await data.resolve(target, post(url, { q: 1 }))).table.rows).toEqual(one.table.rows);
    expect((await data.resolve(target, post(url, { q: 2 }))).table.rows).toEqual(two.table.rows);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: { q: 1 } });
    // A GET's options are what they were before POST existed.
    expect(fetchMock.mock.calls[2]![1]).not.toHaveProperty('method');
    expect(fetchMock.mock.calls[2]![1]).not.toHaveProperty('body');
  });

  it('sends a POST without a body as a POST without one', async () => {
    fetchMock.mockResolvedValue([{ ok: 1 }]);
    const data = new DataService(connectors, store);
    await data.resolve(target, post('https://post.example/empty'));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('body');
  });

  it('shares one in-flight POST between identical requests only', async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      await new Promise((r) => setTimeout(r, 20));
      return [{ got: JSON.stringify((options as { body?: unknown } | undefined)?.body) }];
    });
    const data = new DataService(connectors, store);
    const url = 'https://post.example/flight';
    const results = await Promise.all([
      data.resolve(target, post(url, { q: 'same' })),
      data.resolve(target, post(url, { q: 'same' })),
      data.resolve(target, post(url, { q: 'other' })),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.table.rows[0]!.got)).toEqual([
      '{"q":"same"}',
      '{"q":"same"}',
      '{"q":"other"}',
    ]);
  });

  it('asks the URL policy with the method of an http source', async () => {
    const policy = vi.fn((_t: unknown, _url: string, _method?: string) => null);
    fetchMock.mockResolvedValue([{ x: 1 }]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    await data.resolve(target, post('https://policy.example/q', { q: 1 }));
    await data.resolve(target, http('https://policy.example/g'));
    expect(policy.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['https://policy.example/q', 'POST'],
      ['https://policy.example/g', 'GET'],
    ]);
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
