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
