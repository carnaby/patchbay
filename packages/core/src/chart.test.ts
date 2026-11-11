import { describe, expect, it } from 'vitest';
import { buildChartOption, CHART_KINDS, ChartConfigSchema, inferTable, THEMES } from './index.ts';

type Axis = { type: string; min?: number; max?: number };

describe('scatter axis bounds', () => {
  const quakes = inferTable([
    { longitude: 17.1, latitude: 48.1, region: 'Slovakia' },
    { longitude: 139.7, latitude: 35.7, region: 'Japan' },
    { longitude: -118.2, latitude: 34.1, region: 'California' },
  ]);

  it('applies xMin/xMax to a numeric x axis so a lat/lon map keeps its frame', () => {
    const config = ChartConfigSchema.parse({
      kind: 'scatter',
      x: 'longitude',
      y: ['latitude'],
      xMin: -180,
      xMax: 180,
      yMin: -90,
      yMax: 90,
    });
    const option = buildChartOption(config, quakes, THEMES.light) as { xAxis: Axis; yAxis: Axis };
    expect(option.xAxis).toMatchObject({ type: 'value', min: -180, max: 180 });
    expect(option.yAxis).toMatchObject({ type: 'value', min: -90, max: 90 });
  });

  it('leaves the x axis automatic without bounds', () => {
    const config = ChartConfigSchema.parse({ kind: 'scatter', x: 'longitude', y: ['latitude'] });
    const option = buildChartOption(config, quakes, THEMES.light) as { xAxis: Axis };
    expect(option.xAxis.min).toBeUndefined();
    expect(option.xAxis.max).toBeUndefined();
  });

  it('ignores x bounds on a category axis, where they would hide categories', () => {
    const config = ChartConfigSchema.parse({ kind: 'bar', x: 'region', y: ['latitude'], xMin: 0, xMax: 1 });
    const option = buildChartOption(config, quakes, THEMES.light) as { xAxis: Axis };
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.min).toBeUndefined();
  });

  it('rejects non-numeric bounds in the strict schema', () => {
    expect(
      ChartConfigSchema.safeParse({ kind: 'scatter', x: 'longitude', y: ['latitude'], xMin: 'west' }).success,
    ).toBe(false);
  });
});

describe('labels near the value axis end', () => {
  const stations = inferTable([
    { station: 'Chopok', temp: 3.4 },
    { station: 'Poprad', temp: 9.8 },
    { station: 'Bratislava', temp: 14.9 },
  ]);
  type Built = {
    grid: { right: number };
    series: {
      label?: { textBorderColor?: string };
      markLine?: { data: { label: { textBorderColor: string } }[] };
    }[];
  };
  const build = (config: Record<string, unknown>, opts = { static: true }) =>
    buildChartOption(
      ChartConfigSchema.parse({ x: 'station', y: ['temp'], ...config }),
      stations,
      THEMES.dark,
      opts,
    ) as unknown as Built;

  it('reserves room right of horizontal bars for their value labels', () => {
    const option = build({ kind: 'bar', horizontal: true });
    // "14.9" at 12 px is about 29 px wide; the old fixed 16 px cut it to "14.".
    expect(option.grid.right).toBeGreaterThanOrEqual(36);
  });

  it('reserves half a reference-line label right of horizontal bars, where it is centred on its line', () => {
    const option = build(
      { kind: 'bar', horizontal: true, referenceLines: [{ stat: 'max', label: 'Warmest' }] },
      { static: false },
    );
    // "Warmest · 14.9": 14 characters at 11 px, half of it right of a line at the axis end.
    expect(option.grid.right).toBeGreaterThanOrEqual(Math.ceil((14 * 11 * 0.6) / 2));
  });

  it('gives reference-line labels a halo in the card colour, since they are drawn above the series', () => {
    const option = build({ kind: 'bar', horizontal: true, referenceLines: [{ stat: 'avg' }] });
    expect(option.series[0]!.markLine!.data[0]!.label.textBorderColor).toBe(THEMES.dark.surface);
    expect(build({ kind: 'bar', horizontal: true }).series[0]!.label?.textBorderColor).toBeUndefined();
  });

  it('leaves vertical bars and line charts as they were', () => {
    expect(build({ kind: 'bar' }).grid.right).toBe(16);
    expect(build({ kind: 'bar', referenceLines: [{ stat: 'max', label: 'Warmest' }] }).grid.right).toBe(16);
    expect(build({ kind: 'line', referenceLines: [{ value: 5 }] }).grid.right).toBe(16);
    expect(build({ kind: 'bar', horizontal: true }, { static: false }).grid.right).toBe(16);
  });
});

describe('x labels at the ends of a category axis without a gap', () => {
  const stations = inferTable([
    { station: 'Chopok', temp: 3.4 },
    { station: 'Poprad', temp: 9.8 },
    { station: 'Bratislava', temp: 14.9 },
  ]);
  type Label = { color?: string; hideOverlap?: boolean; alignMinLabel?: string; alignMaxLabel?: string };
  const label = (config: Record<string, unknown>, table = stations) =>
    (
      buildChartOption(
        ChartConfigSchema.parse({ x: 'station', y: ['temp'], ...config }),
        table,
        THEMES.light,
        {
          static: true,
        },
      ) as unknown as { xAxis: { axisLabel: Label }; yAxis: { axisLabel: Label } }
    ).xAxis.axisLabel;

  it('aligns the first and last label inward on line, area and scatter charts', () => {
    for (const kind of ['line', 'area', 'scatter']) {
      expect(label({ kind })).toMatchObject({
        alignMinLabel: 'left',
        alignMaxLabel: 'right',
        color: THEMES.light.muted,
        hideOverlap: true,
      });
    }
  });

  it('keeps centred labels on bars, vertical and horizontal', () => {
    expect(label({ kind: 'bar' }).alignMaxLabel).toBeUndefined();
    expect(label({ kind: 'bar' }).alignMinLabel).toBeUndefined();
    const horizontal = buildChartOption(
      ChartConfigSchema.parse({ kind: 'bar', x: 'station', y: ['temp'], horizontal: true }),
      stations,
      THEMES.light,
      { static: true },
    ) as unknown as { yAxis: { axisLabel: Label } };
    expect(horizontal.yAxis.axisLabel.alignMaxLabel).toBeUndefined();
    expect(horizontal.yAxis.axisLabel.alignMinLabel).toBeUndefined();
  });

  it('leaves time axes as they were', () => {
    const dated = inferTable(
      [
        { at: Date.UTC(2026, 0, 1), temp: 1 },
        { at: Date.UTC(2026, 0, 2), temp: 2 },
      ],
      { types: { at: 'time' } },
    );
    const axis = label({ kind: 'line', x: 'at' }, dated);
    expect(axis).toEqual({ color: THEMES.light.muted, hideOverlap: true });
  });
});

describe('time axis of dated buckets', () => {
  const DAY = 86_400_000;
  const days = (from: string, values: number[]) =>
    inferTable(
      values.map((quakes, i) => ({ day: new Date(Date.parse(from) + i * DAY).toISOString(), quakes })),
    );
  type Built = { useUTC?: boolean; xAxis: { type: string; boundaryGap?: unknown } };
  const build = (kind: string, table = days('2026-10-25', [41, 38, 52, 47, 35, 44]), x = 'day') =>
    buildChartOption(ChartConfigSchema.parse({ kind, x, y: ['quakes'] }), table, THEMES.light, {
      static: true,
    }) as unknown as Built;

  // Day buckets are UTC midnights. ECharts places time ticks at the viewer's local midnight, so east of UTC the
  // first bucket's tick fell before the axis start and its label went missing ("", 26, 27 …), and west of UTC the
  // last one did. In UTC every bucket's midnight is a tick, labelled "25" or "Nov" by ECharts' own time format.
  it('lays out a bar chart of daily buckets in UTC, so the first bucket keeps its label', () => {
    const option = build('bar');
    expect(option.xAxis.type).toBe('time');
    expect(option.useUTC).toBe(true);
  });

  it('does the same for a line of daily values', () => {
    expect(build('line').useUTC).toBe(true);
  });

  it('keeps local time for timestamps within the day, such as an hourly line', () => {
    const hourly = inferTable(
      Array.from({ length: 48 }, (_, i) => ({
        time: new Date(Date.parse('2026-10-31') + i * 3_600_000).toISOString(),
        quakes: i,
      })),
    );
    const option = build('line', hourly, 'time');
    expect(option.xAxis.type).toBe('time');
    expect(option.useUTC).toBe(false);
  });

  it('asks no category boundary gap of a time axis, where ECharts ignores it with a warning', () => {
    expect(build('bar').xAxis.boundaryGap).toBe(false);
  });
});

describe('value labels in snapshots', () => {
  const sales = inferTable([
    { region: 'North', units: 120 },
    { region: 'South', units: 95 },
    { region: 'West', units: 143 },
  ]);
  type Built = { series: { label?: { show: boolean } }[] };
  const labelled = (config: Record<string, unknown>, opts = { static: true }) =>
    Boolean(
      (
        buildChartOption(
          ChartConfigSchema.parse({ kind: 'bar', x: 'region', y: ['units'], ...config }),
          sales,
          THEMES.light,
          opts,
        ) as unknown as Built
      ).series[0]!.label?.show,
    );

  it('labels a few single-series bars in a snapshot when the author left showLabels unset', () => {
    expect(labelled({})).toBe(true);
    expect(labelled({}, { static: false })).toBe(false);
  });

  it('respects an explicit showLabels: false in a snapshot', () => {
    expect(labelled({ showLabels: false })).toBe(false);
  });

  it('shows labels everywhere when showLabels is true', () => {
    expect(labelled({ showLabels: true }, { static: false })).toBe(true);
  });
});

// The web app merges an update whose series keep their type and name into the previous option, so a key that is
// only left out when a setting is off would keep its old value on a live chart.
describe('settings turned off in a live chart', () => {
  const sales = inferTable([
    { month: 'Jan', revenue: 120, cost: 80 },
    { month: 'Feb', revenue: 95, cost: 70 },
  ]);
  type Built = { series: { label: { show: boolean }; stack: unknown; areaStyle?: unknown }[] };
  const build = (config: Record<string, unknown>, opts = {}) =>
    buildChartOption(
      ChartConfigSchema.parse({ x: 'month', y: ['revenue', 'cost'], ...config }),
      sales,
      THEMES.light,
      opts,
    ) as unknown as Built;

  it.each(['bar', 'line', 'area', 'scatter'])('switches %s value labels off explicitly', (kind) => {
    for (const s of build({ kind, showLabels: false }).series) expect(s.label).toEqual({ show: false });
    for (const s of build({ kind }).series) expect(s.label).toEqual({ show: false });
  });

  it('switches snapshot value labels off explicitly when showLabels is false', () => {
    const series = build({ kind: 'bar', y: ['revenue'], showLabels: false }, { static: true }).series;
    expect(series[0]!.label).toEqual({ show: false });
  });

  it.each(['bar', 'line', 'area'])('unstacks a %s chart explicitly', (kind) => {
    expect(build({ kind, stacked: true }).series.map((s) => s.stack)).toEqual(['total', 'total']);
    expect(build({ kind, stacked: false }).series.map((s) => s.stack)).toEqual([null, null]);
  });

  it('drops the fill explicitly when an area becomes a line, which keeps the series type', () => {
    expect(build({ kind: 'area' }).series[0]!.areaStyle).toMatchObject({ opacity: 0.12 });
    expect(build({ kind: 'line' }).series[0]!.areaStyle).toBeNull();
  });
});

describe('tooltips', () => {
  const sales = inferTable([
    { region: 'North', month: 'Jan', revenue: 120, cost: 80 },
    { region: 'South', month: 'Feb', revenue: 95, cost: 70 },
    { region: 'East', month: 'Mar', revenue: 140, cost: 90 },
  ]);

  // The web app isolates each chart's stacking context, so the header and dialogs stay above its tooltip; a tooltip
  // that left the chart would be cut off by the widget frame or drawn under the widget beside it.
  it.each(CHART_KINDS)('keeps the %s tooltip inside the chart', (kind) => {
    const config = ChartConfigSchema.parse({
      kind,
      x: kind === 'heatmap' ? 'month' : 'region',
      y: kind === 'heatmap' ? ['revenue'] : ['revenue', 'cost'].slice(0, kind === 'radar' ? 2 : 1),
      ...(kind === 'heatmap' ? { series: 'region' } : {}),
    });
    const option = buildChartOption(config, sales, THEMES.light) as { tooltip?: { confine?: boolean } };
    expect(option.tooltip?.confine).toBe(true);
  });
});
