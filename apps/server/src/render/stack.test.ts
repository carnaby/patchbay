import { buildChartOption, ChartConfigSchema, inferTable, THEMES } from '@patchbay/core';
import * as echarts from 'echarts';
import { describe, expect, it } from 'vitest';

/** The slice of ECharts' private model that these tests read. */
type SeriesModel = {
  name: string;
  getData(): {
    count(): number;
    get(dim: string, i: number): unknown;
    mapDimension(dim: string): string;
    getCalculationInfo(key: string): unknown;
  };
};

/** Where ECharts draws each stacked segment: [hour, start, end] per series, after its own stacking. */
function segments(kind: string, rows: Record<string, unknown>[]) {
  const config = ChartConfigSchema.parse({ kind, x: 'hour', y: ['n'], series: 'type', stacked: true });
  const option = buildChartOption(config, inferTable(rows), THEMES.light, { animation: false });
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 300 });
  try {
    chart.setOption(option);
    const out: Record<string, [number, number, number][]> = {};
    (chart as unknown as { getModel(): { eachSeries(f: (s: SeriesModel) => void): void } })
      .getModel()
      .eachSeries((s) => {
        const data = s.getData();
        const over = data.getCalculationInfo('stackedOverDimension') as string;
        const top = data.getCalculationInfo('stackResultDimension') as string;
        const xDim = data.mapDimension('x');
        const list: [number, number, number][] = [];
        for (let i = 0; i < data.count(); i++) {
          const end = data.get(top, i) as number;
          if (Number.isNaN(end)) continue;
          const start = data.get(over, i) as number;
          list.push([
            new Date(data.get(xDim, i) as number).getUTCHours(),
            Number.isNaN(start) ? 0 : start,
            end,
          ]);
        }
        out[s.name] = list;
      });
    return out;
  } finally {
    chart.dispose();
  }
}

describe('stacked charts on a time axis', () => {
  const hours = ['00', '01', '02', '03', '04'].map((h) => `2026-11-11T${h}:00:00Z`);
  // Maintenance and feature every hour, bug only at 00, 02 and 04: the merges per hour of a real GitLab run.
  const rows = hours.flatMap((hour, i) => [
    { hour, type: 'maintenance', n: 5 },
    ...(i % 2 === 0 ? [{ hour, type: 'bug', n: 2 }] : []),
    { hour, type: 'feature', n: 3 },
  ]);

  it.each(['bar', 'line', 'area'])('stacks each %s segment on the segments of the same hour', (kind) => {
    const s = segments(kind, rows);
    expect(s.bug).toEqual([
      [0, 0, 2],
      [2, 0, 2],
      [4, 0, 2],
    ]);
    expect(s.feature).toEqual([
      [0, 2, 5],
      [1, 0, 3],
      [2, 2, 5],
      [3, 0, 3],
      [4, 2, 5],
    ]);
    expect(s.maintenance).toEqual([
      [0, 5, 10],
      [1, 3, 8],
      [2, 5, 10],
      [3, 3, 8],
      [4, 5, 10],
    ]);
  });
});
