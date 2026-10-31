import { describe, expect, it } from 'vitest';
import { buildChartOption, ChartConfigSchema, inferTable, THEMES } from './index.ts';

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
