import { describe, expect, it } from 'vitest';
import {
  computeKpi,
  inferTable,
  KpiConfigSchema,
  profileTable,
  runPipeline,
  type Suggestion,
  suggestionDataset,
  suggestWidgets,
  summaryOf,
  type TransformInput,
  TransformSchema,
  WidgetSchema,
} from './index.ts';
import type { ColumnProfile } from './profile.ts';
import { INFRA_NOW, infraTable } from './status.fixture.ts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** Runs what an agent would save: the dataset's steps, then the suggestion's. */
function run(rows: Record<string, unknown>[], existing: TransformInput[], s: Suggestion) {
  const table = inferTable(rows as never, { types: { time: 'time' } });
  const steps = [...existing, ...s.transforms].map((t) => TransformSchema.parse(t));
  return runPipeline(table, steps).table;
}

function suggest(rows: Record<string, unknown>[], existing: TransformInput[] = [], now = NOW) {
  const table = inferTable(rows as never, { types: { time: 'time' } });
  const shaped = runPipeline(
    table,
    existing.map((t) => TransformSchema.parse(t)),
  ).table;
  return suggestWidgets(profileTable(shaped), { transforms: existing, now, max: 20 });
}

const sorts = (steps: TransformInput[]) => steps.filter((t) => t.type === 'sort');
const kpiOf = (list: Suggestion[]) => list.find((s) => s.widget.type === 'kpi')!;
const barOf = (list: Suggestion[]) =>
  list.find((s) => s.widget.type === 'chart' && (s.widget.config as { kind: string }).kind === 'bar')!;

describe('suggestions respect the existing row order', () => {
  // Hourly readings over the last two days, all in the past.
  const readings = Array.from({ length: 48 }, (_, i) => ({
    time: NOW - (47 - i) * HOUR,
    temperature: 10 + i,
  }));

  it('does not append a sort that reverses a newest-first sort', () => {
    const existing: TransformInput[] = [{ type: 'sort', by: [{ field: 'time', dir: 'desc' }] }];
    const list = suggest(readings, existing);
    for (const s of list) expect(sorts(s.transforms)).toEqual([]);
    const kpi = kpiOf(list);
    expect(kpi.widget.config).toMatchObject({ field: 'temperature', agg: 'first' });
    expect(kpi.rationale).toMatch(/newest first/);
    // The KPI still shows the newest reading.
    const result = computeKpi(KpiConfigSchema.parse(kpi.widget.config), run(readings, existing, kpi));
    expect(result.value).toBe(57);
  });

  it('does not repeat a sort the pipeline already has', () => {
    const existing: TransformInput[] = [
      { type: 'sort', by: [{ field: 'time', dir: 'asc' }] },
      { type: 'filter', expr: 'temperature > 0' },
    ];
    const list = suggest(readings, existing);
    for (const s of list) expect(sorts(s.transforms)).toEqual([]);
    expect(kpiOf(list).widget.config).toMatchObject({ agg: 'last', compare: 'previous', sparkline: true });
  });

  it('still sorts when nothing orders the rows, or an aggregate reset the order', () => {
    expect(sorts(kpiOf(suggest(readings)).transforms)).toHaveLength(1);
    const reset: TransformInput[] = [
      { type: 'sort', by: [{ field: 'time', dir: 'desc' }] },
      {
        type: 'aggregate',
        groupBy: ['time'],
        metrics: [{ op: 'avg', field: 'temperature', as: 'temperature' }],
      },
    ];
    expect(sorts(kpiOf(suggest(readings, reset)).transforms)).toEqual([
      { type: 'sort', by: [{ field: 'time', dir: 'asc' }] },
    ]);
  });
});

describe('measures that do not add up', () => {
  const profile = (name: string) => ({ name }) as ColumnProfile;

  it('classifies by name and explains why', () => {
    expect(summaryOf(profile('magnitude'))).toMatchObject({
      op: 'max',
      why: expect.stringMatching(/logarithmic/),
    });
    expect(summaryOf(profile('width')).op).toBe('avg');
    expect(summaryOf(profile('imageHeight')).op).toBe('avg');
    expect(summaryOf(profile('depth_km')).op).toBe('avg');
    expect(summaryOf(profile('temperature_2m')).op).toBe('avg');
    expect(summaryOf(profile('relative_humidity_2m')).op).toBe('avg');
    expect(summaryOf(profile('conversion_rate')).op).toBe('avg');
    expect(summaryOf(profile('growth %')).op).toBe('avg');
    expect(summaryOf(profile('start_lat')).op).toBe('avg');
    expect(summaryOf(profile('customer_id')).op).toBe('count');
    expect(summaryOf(profile('fiscal_year')).op).toBe('count');
    expect(summaryOf(profile('revenue')).op).toBe('sum');
    expect(summaryOf(profile('units')).op).toBe('sum');
    expect(summaryOf(profile('precipitation')).op).toBe('sum');
    expect(summaryOf(profile('id_count')).op).toBe('sum');
  });

  it('shows the strongest earthquake per region instead of a sum of magnitudes', () => {
    const regions = ['Alaska', 'California', 'Japan', 'Chile'];
    const quakes = Array.from({ length: 40 }, (_, i) => ({
      time: NOW - i * HOUR,
      magnitude: 2.5 + (i % 7) * 0.4,
      depth_km: 5 + i,
      region: regions[i % 4],
    }));
    const list = suggest(quakes);
    const bar = barOf(list);
    expect(bar.title).toBe('Max magnitude by region');
    expect(bar.transforms[0]).toMatchObject({
      metrics: [{ op: 'max', field: 'magnitude', as: 'magnitude' }],
    });
    expect(bar.rationale).toMatch(/logarithmic/);
    expect(JSON.stringify(list)).not.toMatch(/"op":"sum"/);
    expect(list.some((s) => s.title.startsWith('Share of'))).toBe(false);
  });

  it('averages photo dimensions and never offers "Total width"', () => {
    const cameras = ['Canon', 'Nikon', 'Sony'];
    const photos = Array.from({ length: 30 }, (_, i) => ({
      photo_id: 1000 + (i % 25),
      camera: cameras[i % 3],
      width: 4000 + (i % 5) * 100,
      height: 3000 + (i % 4) * 100,
    }));
    const list = suggest(photos);
    const titles = list.map((s) => s.title);
    expect(titles).not.toContain('Total width');
    expect(titles).toContain('Average width');
    expect(titles).toContain('Average width by camera');
    expect(kpiOf(list).widget.config).toMatchObject({ field: 'width', agg: 'avg' });
    expect(JSON.stringify(list)).not.toMatch(/"op":"sum"/);
    // The repeated photo_id is a number but not a measure worth charting.
    expect(JSON.stringify(list)).not.toMatch(/photo_id/);
  });

  it('keeps sums and shares for real amounts', () => {
    const sales = Array.from({ length: 30 }, (_, i) => ({
      region: ['EU', 'US', 'Asia'][i % 3],
      revenue: 100 + i,
    }));
    const list = suggest(sales);
    expect(barOf(list).title).toBe('revenue by region');
    expect(list.map((s) => s.title)).toEqual(
      expect.arrayContaining(['Total revenue', 'Share of revenue by region']),
    );
  });
});

describe('bar chart limits', () => {
  const branches = (n: number, rows: number) =>
    Array.from({ length: rows }, (_, i) => ({
      branch: `Branch ${(i % n) + 1}`,
      revenue: 100 + ((i * 37) % 500),
    }));

  it('shows all 20 branches without a hidden limit', () => {
    const bar = barOf(suggest(branches(20, 200)));
    expect(bar.transforms.some((t) => t.type === 'limit')).toBe(false);
    expect(bar.title).toBe('revenue by branch');
    const out = run(branches(20, 200), [], bar);
    expect(out.rows).toHaveLength(20);
  });

  it('says so in the title and rationale when it keeps only the top ones', () => {
    const bar = barOf(suggest(branches(40, 400)));
    expect(bar.transforms.at(-1)).toEqual({ type: 'limit', n: 15 });
    expect(bar.title).toBe('revenue by branch: top 15 of 40');
    expect(bar.widget.title).toBe(bar.title);
    expect(bar.rationale).toMatch(/top 15 of 40.*other 25 are left out/);
  });
});

describe('latest value over a forecast', () => {
  // One day of past readings and three days of forecast, as weather.forecast returns them.
  const forecast = Array.from({ length: 96 }, (_, i) => ({
    time: NOW - 24 * HOUR + i * HOUR,
    temperature_2m: i,
  }));

  it('filters out future rows so "current" is not three days ahead', () => {
    const kpi = kpiOf(suggest(forecast));
    expect(kpi.title).toBe('Current temperature 2m');
    expect(kpi.transforms[0]).toEqual({ type: 'filter', expr: 'time <= now()' });
    expect(kpi.rationale).toMatch(/3 days into the future/);
    expect(kpi.widget.config).toMatchObject({ agg: 'last', compare: 'previous' });
  });

  it('picks the reading closest to now when the pipeline runs', () => {
    // Relative to the real clock, because the filter calls now() when the pipeline runs.
    const now = Date.now();
    const rows = Array.from({ length: 96 }, (_, i) => ({
      time: now - 24 * HOUR + i * HOUR,
      temperature_2m: i,
    }));
    const kpi = kpiOf(suggest(rows, [], now));
    const value = computeKpi(KpiConfigSchema.parse(kpi.widget.config), run(rows, [], kpi)).value;
    expect(value).toBe(24);
  });

  it('quotes field names that are not plain identifiers', () => {
    const rows = forecast.map(({ time, temperature_2m }) => ({ 'valid at': time, temperature_2m }));
    const table = inferTable(rows, { types: { 'valid at': 'time' } });
    const kpi = kpiOf(suggestWidgets(profileTable(table), { now: NOW }));
    expect(kpi.transforms[0]).toEqual({ type: 'filter', expr: '`valid at` <= now()' });
  });

  it('shows the next value when every row is in the future', () => {
    const ahead = forecast.map((r) => ({ ...r, time: r.time + 2 * 24 * HOUR }));
    const kpi = kpiOf(suggest(ahead));
    expect(kpi.title).toBe('Next temperature 2m');
    expect(kpi.transforms.some((t) => t.type === 'filter')).toBe(false);
    expect(kpi.widget.config).toMatchObject({ agg: 'first' });
  });

  it('leaves past-only data alone', () => {
    const past = forecast.map((r) => ({ ...r, time: r.time - 3 * 24 * HOUR }));
    const kpi = kpiOf(suggest(past));
    expect(kpi.title).toBe('Latest temperature 2m');
    expect(kpi.transforms).toEqual([{ type: 'sort', by: [{ field: 'time', dir: 'asc' }] }]);
  });

  it('shows a temperature change in a neutral colour, a revenue change as good or bad', () => {
    const past = forecast.map((r) => ({ ...r, time: r.time - 3 * 24 * HOUR }));
    const temp = kpiOf(suggest(past));
    expect(temp.widget.config).toMatchObject({ compare: 'previous', goodWhen: 'neutral' });
    expect(temp.rationale).toMatch(/neither good nor bad/);
    const revenue = kpiOf(
      suggest(past.map(({ time, temperature_2m }) => ({ time, revenue: temperature_2m }))),
    );
    expect(revenue.widget.config).not.toHaveProperty('goodWhen');
  });
});

describe('locations', () => {
  it('skips the map when every row has the same coordinates', () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({
      time: NOW - i * HOUR,
      temperature: i,
      latitude: 48.15,
      longitude: 17.11,
    }));
    expect(suggest(rows).some((s) => s.widget.type === 'map')).toBe(false);
  });

  it('puts earthquakes on a map sized by magnitude, not on a scatter chart', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      time: NOW - i * HOUR,
      magnitude: 2.5 + (i % 7) * 0.6,
      place: `Place ${i}`,
      latitude: -40 + i * 4,
      longitude: -170 + i * 17,
    }));
    const map = suggest(rows).find((s) => s.widget.type === 'map')!;
    expect(map.title).toBe('magnitude by location');
    expect(map.widget.config).toEqual({
      lat: 'latitude',
      lon: 'longitude',
      size: 'magnitude',
      label: 'place',
    });
    expect(map.transforms).toEqual([]);
    expect(suggest(rows).some((s) => (s.widget.config as { kind?: string }).kind === 'scatter')).toBe(false);
  });

  it('turns successive positions of one source into a track with night shading, in time order', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      time: NOW - i * 60_000,
      latitude: 50 * Math.sin(i / 3),
      longitude: -180 + i * 25,
      altitude_km: 418 + i,
      fetched_at: NOW - i * 60_000,
    }));
    const track = suggest(rows).find((s) => s.widget.type === 'map')!;
    expect(track.title).toBe('Track');
    expect(track.widget.config).toEqual({
      lat: 'latitude',
      lon: 'longitude',
      mode: 'track',
      terminator: true,
    });
    expect(track.transforms).toEqual([{ type: 'sort', by: [{ field: 'time', dir: 'asc' }] }]);
  });

  it('knows an accumulated source is a track even without fetched_at', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ time: NOW - i * 5000, lat: i, lon: i * 2 }));
    const table = inferTable(rows as never, { types: { time: 'time' } });
    const profile = profileTable(table);
    const points = suggestWidgets(profile, { now: NOW }).find((s) => s.widget.type === 'map')!;
    expect((points.widget.config as { mode?: string }).mode).toBeUndefined();
    const track = suggestWidgets(profile, { now: NOW, accumulate: true }).find(
      (s) => s.widget.type === 'map',
    )!;
    expect((track.widget.config as { mode?: string }).mode).toBe('track');
  });
});

describe('share of total', () => {
  it('suggests a percentage bar for 7 to 12 categories, computed with col_sum', () => {
    const sales = Array.from({ length: 80 }, (_, i) => ({ store: `S${i % 8}`, revenue: 10 + (i % 8) }));
    const list = suggest(sales);
    const share = list.find((s) => s.title === 'revenue share by store (%)');
    expect(share?.widget.config).toMatchObject({
      kind: 'bar',
      x: 'store',
      y: ['share'],
      horizontal: true,
      format: { style: 'percent' },
    });
    const rows = run(sales, [], share!).rows;
    expect(rows).toHaveLength(8);
    expect(rows.reduce((t, r) => t + (r.share as number), 0)).toBeCloseTo(100, 0);
    // Up to 6 categories the donut already shows part-to-whole.
    const few = suggest(sales.map((r, i) => ({ ...r, store: `S${i % 3}` })));
    expect(few.some((s) => s.title.includes(' share by '))).toBe(false);
  });
});

describe('suggestionDataset', () => {
  const chain = (n: number) => [
    { id: 'd0', name: 'D0', source: { kind: 'inline' as const, rows: [] }, transforms: [], refreshSec: 60 },
    ...Array.from({ length: n }, (_, i) => ({
      id: `d${i + 1}`,
      name: `D${i + 1}`,
      source: { kind: 'dataset' as const, id: `d${i}` },
      transforms: [],
    })),
  ];

  it('derives from the saved dataset instead of copying its source and steps', () => {
    expect(
      suggestionDataset({ datasets: chain(0) }, 'd0', 'view', 'By region', [{ type: 'limit', n: 5 }]),
    ).toEqual({
      id: 'view',
      name: 'D0: By region',
      source: { kind: 'dataset', id: 'd0' },
      transforms: [{ type: 'limit', n: 5 }],
    });
  });

  it('copies when one more level would pass the depth limit', () => {
    const d = suggestionDataset({ datasets: chain(4) }, 'd4', 'view', 'X', [{ type: 'limit', n: 5 }]);
    expect(d.source).toEqual({ kind: 'dataset', id: 'd3' });
    expect(d.transforms).toEqual([{ type: 'limit', n: 5 }]);
  });
});

describe('status suggestions', () => {
  const statusOf = (rows: Record<string, unknown>[]) =>
    suggestWidgets(profileTable(inferTable(rows as never)), { max: 20 }).find(
      (s) => s.widget.type === 'status',
    );

  it('suggests a status widget first for monitor checks, with sections by machine', () => {
    const list = suggestWidgets(profileTable(infraTable()), { now: INFRA_NOW });
    expect(list[0]!.widget).toEqual({
      type: 'status',
      title: 'Status',
      config: {
        entity: 'service',
        status: 'status',
        group: 'machine',
        label: 'name',
        kind: 'kind',
        detail: 'detail',
        since: 'since',
      },
    });
    expect(list[0]!.score).toBe(97);
    expect(list[0]!.rationale).toMatch(/one tile per "service"/);
    expect(WidgetSchema.safeParse({ id: 's', datasetId: 'd', ...list[0]!.widget }).success).toBe(true);
  });

  it('finds a status column by its values when it has another name', () => {
    const rows = ['api', 'db', 'cache', 'queue', 'web'].flatMap((host, i) => [
      { host, result: i === 2 ? 'DOWN' : 'up' },
      { host, result: 'up' },
    ]);
    const s = statusOf(rows)!;
    expect(s.widget.config).toEqual({ entity: 'host', status: 'result' });
    expect(s.score).toBe(97);
  });

  it('offers a column only named status below the table, since its values would all read as warnings', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ticket: `T-${i}`,
      status: i % 2 ? 'open' : 'closed',
    }));
    const all = suggestWidgets(profileTable(inferTable(rows)), { max: 20 });
    const table = all.find((s) => s.widget.type === 'table')!;
    expect(statusOf(rows)!.score).toBe(20);
    expect(statusOf(rows)!.score).toBeLessThan(table.score);
  });

  it('ranks an event log below the time chart and the table: a tile would keep the worst state of every row', () => {
    // CI runs: 300 rows over 5 projects, each failed now and then. A tile per project would stay red for good.
    const start = Date.UTC(2026, 10, 1);
    const rows = Array.from({ length: 300 }, (_, i) => ({
      project: `p${i % 5}`,
      branch: ['main', 'next', 'dev'][i % 3],
      status: i % 7 === 0 ? 'failed' : 'success',
      duration: 60 + (i % 13) * 7,
      started_at: new Date(start + i * 3_600_000).toISOString(),
    }));
    const all = suggestWidgets(profileTable(inferTable(rows)), { max: 20 });
    const status = all.find((s) => s.widget.type === 'status')!;
    const table = all.find((s) => s.widget.type === 'table')!;
    const timeChart = all.find((s) => s.widget.type === 'chart' && s.score === 95)!;
    expect(status.score).toBe(25);
    expect(status.score).toBeLessThan(table.score);
    expect(status.score).toBeLessThan(timeChart.score);
    expect(status.rationale).toMatch(/60 rows per "project"/);
    expect(all[0]!.widget.type).not.toBe('status');
  });

  it('takes rows as one per check up to 10 rows per entity on average', () => {
    const log = (perHost: number) =>
      ['api', 'db', 'cache', 'queue', 'web'].flatMap((host) =>
        Array.from({ length: perHost }, (_, i) => ({ host, status: i ? 'ok' : 'fail' })),
      );
    expect(statusOf(log(10))!.score).toBe(97);
    expect(statusOf(log(11))!.score).toBe(25);
  });

  it('needs more than half of the values in the vocabulary to take a column by its values', () => {
    const rows = (ok: number) =>
      Array.from({ length: 10 }, (_, i) => ({ host: `h${i % 5}`, result: i < ok ? 'ok' : 'pending' }));
    expect(statusOf(rows(5))).toBeUndefined();
    expect(statusOf(rows(6))).toMatchObject({ score: 97, widget: { config: { status: 'result' } } });
  });

  it('takes a column by its values only with at most 12 distinct values', () => {
    const rows = (distinct: number) => [
      ...Array.from({ length: 20 }, (_, i) => ({ host: `h${i % 5}`, result: 'ok' })),
      ...Array.from({ length: distinct - 1 }, (_, i) => ({ host: `h${i % 5}`, result: `code-${i}` })),
    ];
    expect(statusOf(rows(12))?.widget.config).toMatchObject({ status: 'result' });
    expect(statusOf(rows(13))).toBeUndefined();
  });

  it('prefers a column named like a state over another column of status words', () => {
    const rows = ['api', 'db', 'cache'].flatMap((service) => [
      { service, result: 'ok', status: 'ok' },
      { service, result: 'fail', status: 'up' },
    ]);
    expect(statusOf(rows)).toMatchObject({ score: 97, widget: { config: { status: 'status' } } });
  });

  it('needs something to make tiles of, and a group of 2 to 10 values', () => {
    const lonely = Array.from({ length: 10 }, (_, i) => ({ status: i % 2 ? 'ok' : 'fail', latency: i }));
    expect(statusOf(lonely)).toBeUndefined();
    const wide = Array.from({ length: 24 }, (_, i) => ({
      service: `svc-${i}`,
      machine: `m-${i % 12}`,
      status: 'ok',
    }));
    expect(statusOf(wide)!.widget.config).toEqual({ entity: 'service', status: 'status' });
  });
});
