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
