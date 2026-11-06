import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardDoc, type DatasetResult, inferTable, parseDashboard } from '@patchbay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorService } from './connectors/registry.ts';
import { renderDashboardPng } from './render/snapshot.ts';
import { DataService } from './services/data.ts';
import { FolderStore } from './store/folder-store.ts';

const connectors = new ConnectorService({ offline: true });
const target = { id: 'replay01', ownerId: null };
let dir: string;
let store: FolderStore;
let data: DataService;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-replay-'));
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
  const regions = ['EU', 'US', 'Asia', 'LatAm'];
  const products = ['Mixer', 'Monitor', 'Headphones', 'Cables', 'Interface'];
  const rows = Array.from({ length: 400 }, (_, i) => ({
    region: regions[i % 4]!,
    product: products[(i * 7) % 5]!,
    revenue: 10 + ((i * 37) % 90),
  }));
  await store.saveFile(target.id, {
    id: 'f_sales',
    name: 'sales.csv',
    rows: rows.length,
    columns: 3,
    size: 1,
    uploadedAt: new Date().toISOString(),
    table: inferTable(rows),
  });
  data = new DataService(connectors, store);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const widgets = (specs: { id: string; datasetId: string; type: string; config: unknown }[]) => ({
  widgets: specs,
  layout: specs.map((w, i) => ({ i: w.id, x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 })),
});

async function resolveAll(doc: DashboardDoc) {
  const scope = data.scope(target, doc);
  const results = new Map<string, DatasetResult>();
  for (const d of doc.datasets) results.set(d.id, await scope.resolve(d));
  return results;
}

async function expectSameDashboard(copied: DashboardDoc, derived: DashboardDoc) {
  const [a, b] = [await resolveAll(copied), await resolveAll(derived)];
  for (const w of copied.widgets) {
    if (!('datasetId' in w)) continue;
    const left = a.get(w.datasetId)!;
    const right = b.get(w.datasetId)!;
    expect(right.error).toBeUndefined();
    expect(right.table).toEqual(left.table);
    expect(right.hash).toBe(left.hash);
  }
  const options = { attributions: connectors.attributions() };
  expect(renderDashboardPng(derived, b, options).equals(renderDashboardPng(copied, a, options))).toBe(true);
}

describe('field-test replay: derived datasets show what the hand-made copies showed', () => {
  it('weather: one source, four views', async () => {
    const source = { kind: 'connector', connector: 'weather.forecast', params: { city: 'Bratislava' } };
    const fahrenheit = { type: 'derive', as: 'temp_f', expr: 'round(temperature_2m * 1.8 + 32, 1)' };
    const views = {
      daily: [
        { type: 'timeBucket', field: 'time', unit: 'day' },
        { type: 'aggregate', groupBy: ['time'], metrics: [{ op: 'avg', field: 'temp_f', as: 'temp_f' }] },
      ],
      windy: [{ type: 'filter', expr: 'wind_speed_10m > 10' }],
      latest: [{ type: 'limit', n: 24, from: 'end' }],
    };
    const layout = widgets([
      { id: 'now', type: 'kpi', datasetId: 'w', config: { field: 'temp_f', agg: 'last' } },
      { id: 'days', type: 'chart', datasetId: 'daily', config: { kind: 'line', x: 'time', y: ['temp_f'] } },
      {
        id: 'wind',
        type: 'chart',
        datasetId: 'windy',
        config: { kind: 'scatter', x: 'time', y: ['wind_speed_10m'] },
      },
      { id: 'table', type: 'table', datasetId: 'latest', config: {} },
    ]);
    const copied = parseDashboard({
      schemaVersion: 1,
      title: 'Weather',
      datasets: [
        { id: 'w', name: 'Weather', source, transforms: [fahrenheit] },
        ...Object.entries(views).map(([id, steps]) => ({
          id,
          name: id,
          source,
          transforms: [fahrenheit, ...steps],
        })),
      ],
      ...layout,
    });
    const derived = parseDashboard({
      schemaVersion: 1,
      title: 'Weather',
      datasets: [
        { id: 'w', name: 'Weather', source, transforms: [fahrenheit] },
        ...Object.entries(views).map(([id, steps]) => ({
          id,
          name: id,
          source: { kind: 'dataset', id: 'w' },
          transforms: steps,
        })),
      ],
      ...layout,
    });
    await expectSameDashboard(copied, derived);
  });

  it('upload: one file, four views', async () => {
    const source = { kind: 'upload', fileId: 'f_sales' };
    const views = {
      byregion: [
        { type: 'aggregate', groupBy: ['region'], metrics: [{ op: 'sum', field: 'revenue', as: 'revenue' }] },
        { type: 'sort', by: [{ field: 'revenue', dir: 'desc' }] },
      ],
      byproduct: [
        {
          type: 'aggregate',
          groupBy: ['product'],
          metrics: [{ op: 'sum', field: 'revenue', as: 'revenue' }],
        },
      ],
      top: [
        { type: 'sort', by: [{ field: 'revenue', dir: 'desc' }] },
        { type: 'limit', n: 10 },
      ],
    };
    const layout = widgets([
      { id: 'total', type: 'kpi', datasetId: 'sales', config: { field: 'revenue', agg: 'sum' } },
      {
        id: 'regions',
        type: 'chart',
        datasetId: 'byregion',
        config: { kind: 'bar', x: 'region', y: ['revenue'] },
      },
      {
        id: 'products',
        type: 'chart',
        datasetId: 'byproduct',
        config: { kind: 'donut', x: 'product', y: ['revenue'] },
      },
      { id: 'top', type: 'table', datasetId: 'top', config: {} },
    ]);
    const make = (derive: boolean) =>
      parseDashboard({
        schemaVersion: 1,
        title: 'Sales',
        datasets: [
          { id: 'sales', name: 'Sales', source },
          ...Object.entries(views).map(([id, steps]) => ({
            id,
            name: id,
            source: derive ? { kind: 'dataset', id: 'sales' } : source,
            transforms: steps,
          })),
        ],
        ...layout,
      });
    await expectSameDashboard(make(false), make(true));
  });
});
