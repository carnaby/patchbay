import { describe, expect, it } from 'vitest';
import {
  computeKpi,
  inferTable,
  KpiConfigSchema,
  profileTable,
  runPipeline,
  type Suggestion,
  suggestWidgets,
  summaryOf,
  type TransformInput,
  TransformSchema,
} from './index.ts';
import type { ColumnProfile } from './profile.ts';

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
});

describe('locations', () => {
  it('skips the map when every row has the same coordinates', () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({
      time: NOW - i * HOUR,
      temperature: i,
      latitude: 48.15,
      longitude: 17.11,
    }));
    expect(suggest(rows).some((s) => s.title === 'Locations')).toBe(false);
  });
});
