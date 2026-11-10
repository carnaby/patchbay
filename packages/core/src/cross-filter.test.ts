import { describe, expect, it } from 'vitest';
import {
  buildChartOption,
  ChartConfigSchema,
  crossFilterOf,
  crossFilterPick,
  crossFilterSelection,
  DIMMED_OPACITY,
  inferTable,
  MapConfigSchema,
  ParameterSchema,
  rowSelected,
  THEMES,
  WidgetSchema,
} from './index.ts';
import { buildMapOption } from './map.ts';

/** Parsed, so every default the option builders read is there. */
const chart = (config: Record<string, unknown>) => ChartConfigSchema.parse(config);

const region = ParameterSchema.parse({
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu' }, { value: 'us' }, { value: 2026 }],
  all: 'All',
  default: null,
});
const q = ParameterSchema.parse({ id: 'q', label: 'Search', type: 'text' });
const table = inferTable([
  { region: 'eu', kind: 'a', v: 1, lat: 48, lon: 17 },
  { region: 'us', kind: 'b', v: 2, lat: 40, lon: -74 },
  { region: 'apac', kind: 'a', v: 3, lat: 1, lon: 103 },
]);
const bars = WidgetSchema.parse({
  id: 'bars',
  type: 'chart',
  datasetId: 's',
  config: { kind: 'bar', x: 'region', y: ['v'], crossFilter: { parameter: 'region', field: 'region' } },
});
const theme = THEMES.light;
type Series = {
  name: string;
  data: unknown[];
  itemStyle: { opacity: number };
  lineStyle?: { opacity: number };
  showSymbol?: boolean;
  triggerEvent?: boolean;
};

describe('the selection of a cross-filter', () => {
  it('is the filter value as text, and nothing at "All", an empty text or without a cross-filter', () => {
    expect(crossFilterOf(bars)).toEqual({ parameter: 'region', field: 'region' });
    expect(crossFilterSelection(bars, { region: 'eu' })).toEqual({ field: 'region', value: 'eu' });
    expect(crossFilterSelection(bars, { region: 2026 })).toEqual({ field: 'region', value: '2026' });
    expect(crossFilterSelection(bars, { region: null })).toBeNull();
    expect(crossFilterSelection(bars, { region: '' })).toBeNull();
    expect(crossFilterSelection(bars, undefined)).toBeNull();
    const plain = WidgetSchema.parse({
      id: 'p',
      type: 'chart',
      datasetId: 's',
      config: { kind: 'bar', x: 'region', y: ['v'] },
    });
    expect(crossFilterSelection(plain, { region: 'eu' })).toBeNull();
    expect(rowSelected({ region: 'eu' }, { field: 'region', value: 'eu' })).toBe(true);
    expect(rowSelected({ region: 'us' }, { field: 'region', value: 'eu' })).toBe(false);
    expect(rowSelected({ year: 2026 }, { field: 'year', value: '2026' })).toBe(true);
    expect(rowSelected({ region: 'us' }, null)).toBeNull();
  });

  it('turns a clicked value into filter text, or says why it cannot', () => {
    expect(crossFilterPick(region, 'eu')).toEqual({ text: 'eu' });
    expect(crossFilterPick(region, 2026)).toEqual({ text: '2026' });
    expect(crossFilterPick(region, 'EU-West')).toEqual({
      problem: 'EU-West is not one of the Region choices',
    });
    expect(crossFilterPick(region, 'Other')).toEqual({ problem: 'Other is not one of the Region choices' });
    expect(crossFilterPick(region, null)).toEqual({ problem: 'This item has no value to filter by' });
    expect(crossFilterPick(q, '  shoes ')).toEqual({ text: 'shoes' });
    expect(crossFilterPick(q, 'x'.repeat(101))).toEqual({ problem: 'Search takes at most 100 characters' });
  });

  it('lets the server judge a click on a select whose choices come from data', () => {
    const country = ParameterSchema.parse({
      id: 'country',
      label: 'Country',
      type: 'select',
      optionsFrom: { dataset: 'countries', field: 'code' },
      all: 'All',
      default: null,
    });
    expect(crossFilterPick(country, 'SK')).toEqual({ text: 'SK' });
  });
});

describe('dimming', () => {
  it('dims the bars of other categories and keeps the selected one, with explicit opacities', () => {
    const config = chart({ kind: 'bar', x: 'region', y: ['v'] });
    const plain = buildChartOption(config, table, theme);
    const selected = buildChartOption(config, table, theme, { selection: { field: 'region', value: 'us' } });
    const [s] = selected.series as Series[];
    const [p] = plain.series as Series[];
    // Categories come in first-seen order: eu, us, apac.
    expect(s!.data).toEqual([
      { value: 1, itemStyle: { opacity: DIMMED_OPACITY } },
      2,
      { value: 3, itemStyle: { opacity: DIMMED_OPACITY } },
    ]);
    expect(p!.data).toEqual([1, 2, 3]);
    // Explicit, so a merged update after the selection is cleared does not keep an old opacity.
    expect(p!.itemStyle.opacity).toBe(1);
  });

  it('dims other series of a split chart, and other slices of a pie, never recolouring them', () => {
    const split = chart({ kind: 'line', x: 'region', y: ['v'], series: 'kind' });
    const lines = buildChartOption(split, table, theme, { selection: { field: 'kind', value: 'b' } });
    const byName = Object.fromEntries((lines.series as Series[]).map((s) => [s.name, s]));
    expect(byName.a!.lineStyle!.opacity).toBe(DIMMED_OPACITY);
    expect(byName.b!.lineStyle!.opacity).toBe(1);
    const plainLines = buildChartOption(split, table, theme);
    expect((plainLines.series as Series[]).map((s) => (s.itemStyle as { color?: string }).color)).toEqual(
      (lines.series as Series[]).map((s) => (s.itemStyle as { color?: string }).color),
    );
    const pie = buildChartOption(chart({ kind: 'pie', x: 'region', y: ['v'] }), table, theme, {
      selection: { field: 'region', value: 'eu' },
    });
    const items = (pie.series as { data: { name: string; itemStyle: { opacity: number } }[] }[])[0]!.data;
    expect(Object.fromEntries(items.map((i) => [i.name, i.itemStyle.opacity]))).toEqual({
      apac: DIMMED_OPACITY,
      us: DIMMED_OPACITY,
      eu: 1,
    });
  });

  it('dims map dots of other values and tells each dot what a click picks', () => {
    const config = MapConfigSchema.parse({ lat: 'lat', lon: 'lon', basemap: 'none' });
    const option = buildMapOption(config, table, theme, {
      selection: { field: 'region', value: 'eu' },
      pickField: 'region',
    });
    const dots = (
      option.series as { id: string; data: { pick: unknown; itemStyle?: { opacity: number } }[] }[]
    ).find((s) => s.id.startsWith('points:'))!;
    expect(dots.data.map((d) => [d.pick, d.itemStyle?.opacity ?? 1])).toEqual([
      ['eu', 1],
      ['us', DIMMED_OPACITY],
      ['apac', DIMMED_OPACITY],
    ]);
  });
});

describe('clickable line and area charts', () => {
  // More than 40 rows: a line hides its symbols, so there would be nothing to click or to see dimmed.
  const many = inferTable(
    Array.from({ length: 60 }, (_, i) => ({ day: `d${i % 30}`, kind: i < 30 ? 'a' : 'b', v: i })),
  );
  const split = chart({ kind: 'line', x: 'day', y: ['v'], series: 'kind' });
  const area = chart({ kind: 'area', x: 'day', y: ['v'] });
  const first = (config: ReturnType<typeof chart>, clickable?: 'x' | 'series') =>
    (buildChartOption(config, many, theme, clickable ? { clickable } : {}).series as Series[])[0]!;

  it('makes the line itself receive clicks when it is clickable by series', () => {
    expect(first(split, 'series').triggerEvent).toBe(true);
    expect(first(split).triggerEvent).toBeFalsy();
  });

  it('keeps the symbols of a long line when it is clickable by x, so there is a point to click and to dim', () => {
    expect(first(split).showSymbol).toBe(false);
    expect(first(split, 'x').showSymbol).toBe(true);
    expect(first(area, 'x').showSymbol).toBe(true);
    expect(first(area, 'series').showSymbol).toBe(false);
  });

  it('dims the points of other categories of a line by x', () => {
    const plain = chart({ kind: 'line', x: 'region', y: ['v'] });
    const [s] = buildChartOption(plain, table, theme, {
      clickable: 'x',
      selection: { field: 'region', value: 'us' },
    }).series as Series[];
    expect(s!.data).toEqual([
      { value: 1, itemStyle: { opacity: DIMMED_OPACITY } },
      2,
      { value: 3, itemStyle: { opacity: DIMMED_OPACITY } },
    ]);
  });

  it('fades the line and the fill of an area series that is not selected', () => {
    const areas = chart({ kind: 'area', x: 'region', y: ['v'], series: 'kind' });
    const option = (selection: { field: string; value: string } | null) =>
      Object.fromEntries(
        (
          buildChartOption(areas, table, theme, { selection }).series as (Series & {
            areaStyle: { opacity: number };
          })[]
        ).map((s) => [s.name, s]),
      );
    const chosen = option({ field: 'kind', value: 'b' });
    expect(chosen.a!.areaStyle.opacity).toBeCloseTo(0.12 * DIMMED_OPACITY);
    expect(chosen.b!.areaStyle.opacity).toBeCloseTo(0.12);
    expect(option(null).a!.areaStyle.opacity).toBeCloseTo(0.12);
  });
});
