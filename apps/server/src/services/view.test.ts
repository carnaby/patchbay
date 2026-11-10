import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardDoc, DatasetSchema, emptyDashboard, parseDashboard } from '@patchbay/core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string, options?: unknown) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  safeFetchJson: (url: string, options?: unknown) => fetchMock(url, options),
}));

const { DataService } = await import('./data.ts');
const { InlineRunner } = await import('./pipeline-pool.ts');
const { loadDataOptions, rawFromQuery, viewValues } = await import('./view.ts');

const dir = mkdtempSync(join(tmpdir(), 'patchbay-view-test-'));
const store = new FolderStore(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fetchMock.mockReset());

const connectors = new ConnectorService({ offline: true });
const target = { id: 'dash01', ownerId: null };
const region = {
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu' }, { value: 'us' }],
  all: 'All',
  default: null,
};
const city = {
  id: 'city',
  label: 'City',
  type: 'select',
  options: [{ value: 'bratislava' }, { value: '..' }],
  default: 'bratislava',
};
const docOf = (datasets: unknown[]): DashboardDoc =>
  parseDashboard({ ...emptyDashboard('t'), parameters: [region, city], datasets });
const sales = {
  id: 'sales',
  name: 'Sales',
  source: { kind: 'http', url: 'https://api.example.com/v1/sales?region=$param.region' },
};
const plain = { id: 'plain', name: 'Plain', source: { kind: 'http', url: 'https://api.example.com/v1/all' } };
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected an error');
};

describe('reading a view', () => {
  it('reads p.<id> query parameters, the first of each, without prototype surprises', () => {
    const raw = rawFromQuery(
      'https://x.example/api/dashboards/d/data/s?rows=arrays&p.region=eu&p.region=us&p.__proto__=x&p.constructor=y&region=no',
    );
    expect(Object.entries(raw)).toEqual([
      ['region', 'eu'],
      ['__proto__', 'x'],
      ['constructor', 'y'],
    ]);
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
  });

  it('takes defaults, ignores filters it does not know, and answers 400 with what to choose', () => {
    const doc = docOf([]);
    expect(viewValues(doc, { region: 'eu', gone: 'x', constructor: 'y' }).region).toBe('eu');
    expect(viewValues(doc, undefined).region).toBeNull();
    const error = failure(() => viewValues(doc, { region: 'xx' }));
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Filter "region" has no value "xx"; choose one of eu, us, or * for all');
  });
});

describe('resolving a view', () => {
  const resolver = () => new DataService(connectors, store);
  const resolveIn = (
    data: InstanceType<typeof DataService>,
    doc: DashboardDoc,
    raw: Record<string, string> | undefined,
    id: string,
  ) =>
    data
      .scope(target, doc, { parameters: viewValues(doc, raw) })
      .resolve(doc.datasets.find((d) => d.id === id)!);

  it('fetches each value once, and a dataset without filters once for every view', async () => {
    fetchMock.mockImplementation(async (url) => [{ url }]);
    const data = resolver();
    const doc = docOf([sales, plain]);
    expect((await resolveIn(data, doc, { region: 'eu' }, 'sales')).table.rows).toEqual([
      { url: 'https://api.example.com/v1/sales?region=eu' },
    ]);
    expect((await resolveIn(data, doc, { region: 'us' }, 'sales')).table.rows).toEqual([
      { url: 'https://api.example.com/v1/sales?region=us' },
    ]);
    expect((await resolveIn(data, doc, undefined, 'sales')).table.rows).toEqual([
      { url: 'https://api.example.com/v1/sales' },
    ]);
    await resolveIn(data, doc, { region: 'eu' }, 'sales');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.example.com/v1/sales?region=eu',
      'https://api.example.com/v1/sales?region=us',
      'https://api.example.com/v1/sales',
    ]);
    for (const raw of [{ region: 'eu' }, { region: 'us' }, undefined])
      await resolveIn(data, doc, raw, 'plain');
    expect(fetchMock.mock.calls.filter((c) => c[0] === 'https://api.example.com/v1/all')).toHaveLength(1);
  });

  it('gives each view of a derived dataset its own final result', async () => {
    const data = resolver();
    const doc = docOf([
      { id: 'root', name: 'Root', source: { kind: 'inline', rows: [{ r: 'eu' }, { r: 'us' }] } },
      {
        id: 'kid',
        name: 'Kid',
        source: { kind: 'dataset', id: 'root' },
        transforms: [{ type: 'filter', expr: '$param.region == null || r == $param.region' }],
      },
    ]);
    const rowsFor = async (raw?: Record<string, string>) =>
      (await resolveIn(data, doc, raw, 'kid')).table.rows.map((row) => row.r);
    expect(await rowsFor({ region: 'eu' })).toEqual(['eu']);
    expect(await rowsFor({ region: 'us' })).toEqual(['us']);
    expect(await rowsFor()).toEqual(['eu', 'us']);
    // Within the finals' few seconds, each view is answered from its own entry, never another view's.
    expect(await rowsFor({ region: 'eu' })).toEqual(['eu']);
  });

  it('names a value that cannot fill a path segment, fetches nothing, and binds drafts with the same values', async () => {
    const data = resolver();
    const doc = docOf([
      { id: 'path', name: 'Path', source: { kind: 'http', url: 'https://api.example.com/v1/$param.city/x' } },
    ]);
    const result = await resolveIn(data, doc, { city: '..' }, 'path');
    expect(result.error).toBe('Filter "city" cannot be used as a path segment with the value ".."');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async (url) => [{ url }]);
    const draft = DatasetSchema.parse({
      id: 'draft',
      name: 'Draft',
      source: { kind: 'http', url: 'https://api.example.com/v2/$param.city' },
    });
    const bound = await data
      .scope(target, doc, { parameters: viewValues(doc, { city: 'bratislava' }) })
      .resolve(draft);
    expect(bound.table.rows).toEqual([{ url: 'https://api.example.com/v2/bratislava' }]);
  });

  it('never loads the template of a root that failed to bind, however its readers are resolved', async () => {
    const policy = vi.fn((_target: unknown, _url: string) => null);
    fetchMock.mockImplementation(async (url) => [{ url }]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    const doc = docOf([
      { id: 'root', name: 'Root', source: { kind: 'http', url: 'https://api.example.com/v1/$param.city/x' } },
      { id: 'kid', name: 'Kid', source: { kind: 'dataset', id: 'root' } },
      plain,
    ]);
    const scope = data.scope(target, doc, { parameters: viewValues(doc, { city: '..' }) });
    const [kid, sibling] = await Promise.all(
      ['kid', 'plain'].map((id) => scope.resolve(doc.datasets.find((d) => d.id === id)!)),
    );
    expect(kid!.error).toBe(
      'Source dataset "root" failed: Filter "city" cannot be used as a path segment with the value ".."',
    );
    expect(sibling!.table.rows).toEqual([{ url: 'https://api.example.com/v1/all' }]);
    const seen = [...policy.mock.calls.map((c) => c[1]), ...fetchMock.mock.calls.map((c) => c[0])];
    expect(seen.filter((url) => url.includes('$param.'))).toEqual([]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://api.example.com/v1/all']);
  });

  it('refuses to load a source that still holds a reference, whoever asks', async () => {
    const policy = vi.fn((_target: unknown, _url: string) => null);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    const [path] = docOf([
      { id: 'path', name: 'Path', source: { kind: 'http', url: 'https://api.example.com/v1/$param.city/x' } },
    ]).datasets;
    await expect(data.loadInput(target, path!)).rejects.toThrow(
      'Dataset "path" uses filters; resolve it through its dashboard.',
    );
    expect(policy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a dataset with filters resolved without its dashboard', async () => {
    const result = await resolver().resolve(target, docOf([sales]).datasets[0]!);
    expect(result.error).toBe('Dataset "sales" uses filters; resolve it through its dashboard.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the URL policy about the bound address', async () => {
    const policy = vi.fn((_target: unknown, _url: string) => null);
    fetchMock.mockResolvedValue([{ x: 1 }]);
    const data = new DataService(connectors, store, new InlineRunner(), { urlPolicy: policy });
    const doc = docOf([sales]);
    await resolveIn(data, doc, { region: 'us' }, 'sales');
    expect(policy.mock.calls.map((c) => c[1])).toEqual(['https://api.example.com/v1/sales?region=us']);
  });
});

describe('choices from data', () => {
  const country = {
    id: 'country',
    label: 'Country',
    type: 'select',
    optionsFrom: { dataset: 'countries', field: 'code' },
    all: 'All',
    default: null,
  };
  const docWith = (countries: unknown) =>
    parseDashboard({ ...emptyDashboard('t'), parameters: [country], datasets: [countries] });

  it('reads a value against the dataset’s distinct values, loaded through a scope', async () => {
    const doc = docWith({
      id: 'countries',
      name: 'Countries',
      source: { kind: 'inline', rows: [{ code: 'SK' }, { code: 'AT' }, { code: 'SK' }] },
    });
    const data = new DataService(connectors, store);
    const read = async (raw: Record<string, string>) =>
      viewValues(doc, raw, Date.now(), await loadDataOptions(data, target, doc, raw));
    expect((await read({ country: 'AT' })).country).toBe('AT');
    expect((await read({ country: '*' })).country).toBeNull();
    const error = await read({ country: 'DE' }).catch((e: HttpError) => e);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toBe(
      'Filter "country" has no value "DE"; choose one of AT, SK, or * for all',
    );
  });

  it('refuses every value when the choices cannot be read, and loads nothing without a value', async () => {
    fetchMock.mockRejectedValueOnce(new HttpError(502, 'Upstream responded 500'));
    const doc = docWith({
      id: 'countries',
      name: 'Countries',
      source: { kind: 'http', url: 'https://api.example.com/c' },
    });
    const data = new DataService(connectors, store);
    expect([...(await loadDataOptions(data, target, doc, undefined))]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    const raw = { country: 'AT' };
    const options = await loadDataOptions(data, target, doc, raw);
    expect(() => viewValues(doc, raw, Date.now(), options)).toThrow(
      'Filter "country" takes its choices from dataset "countries", which could not be read',
    );
  });
});
