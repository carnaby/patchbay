import { buildChartOption, ChartConfigSchema, inferTable, THEMES } from '@patchbay/core';
import * as echarts from 'echarts';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ECharts lays out a time axis in the process's local time unless told otherwise, so these render the option the
 * way the snapshot renderer does, under zones on both sides of UTC. The web app runs in the viewer's zone and the
 * server in whatever TZ its host sets, so a bug that only shows outside UTC shows in both.
 */
const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const DAY = 86_400_000;
const days = (from: string, values: number[]) =>
  inferTable(values.map((v, i) => ({ day: new Date(Date.parse(from) + i * DAY).toISOString(), v })));

/** The x axis labels, left to right: the text on the lowest row of the SVG. */
function xLabels(config: Record<string, unknown>, table: ReturnType<typeof inferTable>): string[] {
  const option = buildChartOption(ChartConfigSchema.parse(config), table, THEMES.light, { animation: false });
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 640, height: 360 });
  try {
    chart.setOption(option);
    const texts = [
      ...chart.renderToSVGString().matchAll(/transform="translate\(([\d.]+) ([\d.]+)\)"[^>]*>([^<]+)</g),
    ].map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3]! }));
    const bottom = Math.max(...texts.map((t) => t.y));
    return texts
      .filter((t) => t.y === bottom)
      .sort((a, b) => a.x - b.x)
      .map((t) => t.text);
  } finally {
    chart.dispose();
  }
}

describe.each(['UTC', 'Europe/Bratislava', 'Asia/Tokyo', 'America/Los_Angeles'])('time axis in %s', (tz) => {
  it('labels every daily bar, the first and the last included', () => {
    process.env.TZ = tz;
    const quakes = days('2026-10-25', [41, 38, 52, 47, 35, 44]);
    expect(xLabels({ kind: 'bar', x: 'day', y: ['v'] }, quakes)).toEqual([
      '25',
      '26',
      '27',
      '28',
      '29',
      '30',
    ]);
  });

  it('labels every daily point of a line, the first and the last included', () => {
    process.env.TZ = tz;
    const series = days('2026-10-25', [41, 38, 52, 47, 35, 44]);
    expect(xLabels({ kind: 'line', x: 'day', y: ['v'] }, series)).toEqual([
      '25',
      '26',
      '27',
      '28',
      '29',
      '30',
    ]);
  });

  it('names the month where a daily line crosses into one', () => {
    process.env.TZ = tz;
    const rain = days('2026-10-31', [0.2, 3.1, 0, 1.4, 5.2, 0.6, 2]);
    expect(xLabels({ kind: 'line', x: 'day', y: ['v'] }, rain)).toEqual([
      '31',
      'Nov',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });

  it('names the month where a daily bar starts one', () => {
    process.env.TZ = tz;
    const rain = days('2026-10-31', [0.2, 3.1, 0, 1.4, 5.2, 0.6, 2]);
    expect(xLabels({ kind: 'bar', x: 'day', y: ['v'] }, rain)).toEqual([
      '31',
      'Nov',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });

  // ECharts steps days within each month (1, 8, 15, …) and used to keep the step after the month's last one as a tick
  // of its own, so "Oct 6" sat right after "Oct": irregular labels on every 30- and 90-day view.
  const weekly = (from: string, n: number) =>
    days(
      from,
      Array.from({ length: n }, (_, i) => 100 + (i % 7) * 10),
    );

  it('steps a 90-day daily line by week within each month, with nothing between the month and its 8th', () => {
    process.env.TZ = tz;
    expect(xLabels({ kind: 'line', x: 'day', y: ['v'] }, weekly('2026-08-14', 90))).toEqual([
      '15',
      '22',
      'Sep',
      '8',
      '15',
      '22',
      'Oct',
      '8',
      '15',
      '22',
      'Nov',
      '8',
    ]);
    expect(xLabels({ kind: 'bar', x: 'day', y: ['v'] }, weekly('2026-08-14', 90))).toEqual([
      '15',
      '22',
      'Sep',
      '8',
      '15',
      '22',
      'Oct',
      '8',
      '15',
      '22',
      'Nov',
      '8',
    ]);
  });

  it('steps a 30-day daily line by four days, with nothing between the month and its 5th', () => {
    process.env.TZ = tz;
    expect(xLabels({ kind: 'line', x: 'day', y: ['v'] }, weekly('2026-10-13', 30))).toEqual([
      '13',
      '17',
      '21',
      '25',
      '29',
      'Nov',
      '5',
      '9',
    ]);
  });
});
