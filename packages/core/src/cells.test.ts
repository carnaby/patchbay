import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildChartOption,
  ChartConfigSchema,
  cellStyle,
  compileTableRules,
  computeKpi,
  contrastRatio,
  emptyDashboard,
  inferTable,
  KpiConfigSchema,
  referenceLineValue,
  resolveColor,
  TableConfigSchema,
  THEMES,
  tableColumns,
} from './index.ts';

const t = THEMES.light;

describe('table columns', () => {
  const table = inferTable([{ name: 'a', price: 1234.5, pct: 12.345, status: 'late' }]);

  it('accepts plain names and column objects side by side', () => {
    const config = TableConfigSchema.parse({
      columns: ['name', { field: 'price', label: 'Price', format: { style: 'currency', currency: 'EUR' } }],
      format: { style: 'number', decimals: 1 },
    });
    const cols = tableColumns(config, table);
    expect(cols.map((c) => [c.field, c.label])).toEqual([
      ['name', 'name'],
      ['price', 'Price'],
    ]);
    // A column's format overrides the table's; the others keep the table's.
    expect(cols[1]!.format).toEqual({ style: 'currency', currency: 'EUR' });
    const rules = compileTableRules(config);
    expect(cellStyle(table.rows[0]!, cols[1]!, rules, t).text).toBe('€1,234.5');
  });

  it('defaults to every column, with the table format', () => {
    const config = TableConfigSchema.parse({ format: { style: 'number', decimals: 1 } });
    const cols = tableColumns(config, table);
    expect(cols.map((c) => c.field)).toEqual(['name', 'price', 'pct', 'status']);
    expect(cellStyle(table.rows[0]!, cols[2]!, compileTableRules(config), t).text).toBe('12.3');
  });

  it('keeps a configured column missing from the data, as a string column', () => {
    const cols = tableColumns(TableConfigSchema.parse({ columns: ['nope'] }), table);
    expect(cols[0]).toMatchObject({ field: 'nope', type: 'string', label: 'nope' });
  });
});

describe('cellStyle', () => {
  const rows = [
    { order: 1, status: 'late', stock: 3 },
    { order: 2, status: 'ok', stock: 30 },
    { order: 3, status: 'late', stock: 300 },
  ];
  const table = inferTable(rows);
  const config = TableConfigSchema.parse({
    columns: ['order', 'status', { field: 'stock', bands: [{ upTo: 5, color: 'warning' }] }],
    rules: [
      { when: 'status == "late"', color: 'negative', label: 'late orders' },
      { when: 'order == 2', color: 'positive', columns: ['status'], colorAs: 'text' },
    ],
  });
  const cols = tableColumns(config, table);
  const rules = compileTableRules(config);
  const style = (r: number, c: number) => cellStyle(table.rows[r]!, cols[c]!, rules, t);

  it('tints the whole row for a row rule, keeping the normal ink, and names the rule', () => {
    expect(style(0, 0)).toEqual({
      text: '1',
      background: resolveColor('negative', t, 'fill'),
      reason: 'late orders',
    });
    expect(style(0, 1).background).toBe(resolveColor('negative', t, 'fill'));
    expect(style(0, 1).color).toBeUndefined();
  });

  it("lets a column's bands win over row rules for that cell", () => {
    expect(style(0, 2)).toMatchObject({
      background: resolveColor('warning', t, 'fill'),
      reason: 'stock up to 5',
    });
    // Above the last band the column has no colour, so the row rule applies again.
    expect(style(2, 2).background).toBe(resolveColor('negative', t, 'fill'));
  });

  it('applies a rule to its columns only, as text colour with contrast enforced', () => {
    expect(style(1, 0)).toEqual({ text: '2' });
    const status = style(1, 1);
    expect(status.color).toBe(resolveColor('positive', t, 'text'));
    expect(contrastRatio(status.color!, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(status.reason).toBe('order == 2');
  });

  it('the first matching rule wins', () => {
    const two = TableConfigSchema.parse({
      rules: [
        { when: 'stock > 10', color: 'accent-1' },
        { when: 'stock > 100', color: 'accent-2' },
      ],
    });
    const out = cellStyle(table.rows[2]!, tableColumns(two, table)[0]!, compileTableRules(two), t);
    expect(out.background).toBe(resolveColor('accent-1', t, 'fill'));
  });

  it('a rule that fails on a row just does not match', () => {
    const bad = TableConfigSchema.parse({ rules: [{ when: 'upper(stock) == "X"', color: 'accent-1' }] });
    expect(
      cellStyle(table.rows[0]!, tableColumns(bad, table)[0]!, compileTableRules(bad), t).background,
    ).toBeUndefined();
  });

  it('rejects rules whose expression does not parse', () => {
    expect(TableConfigSchema.safeParse({ rules: [{ when: 'status ==', color: 'negative' }] }).success).toBe(
      false,
    );
  });
});

describe('KPI value colour and neutral change', () => {
  const table = inferTable([{ v: 10 }, { v: 30 }]);

  it('takes the first band whose upTo is >= the value, none above the last', () => {
    const bands = [
      { upTo: 0, color: 'negative' },
      { upTo: 25, color: 'warning' },
    ];
    const kpi = (agg: 'first' | 'last' | 'min') =>
      computeKpi(KpiConfigSchema.parse({ field: 'v', agg, bands }), table).valueColor;
    expect(kpi('first')).toBe('warning');
    expect(kpi('last')).toBeNull();
    expect(computeKpi(KpiConfigSchema.parse({ field: 'v' }), table).valueColor).toBeNull();
  });

  it('reports a neutral trend for goodWhen "neutral"', () => {
    const up = computeKpi(
      KpiConfigSchema.parse({ field: 'v', compare: 'previous', goodWhen: 'neutral' }),
      table,
    );
    expect(up.trend).toBe('neutral');
    expect(up.delta).toBe(20);
    const flat = computeKpi(
      KpiConfigSchema.parse({ field: 'v', compare: 'previous', goodWhen: 'neutral' }),
      inferTable([{ v: 1 }, { v: 1 }]),
    );
    expect(flat.trend).toBe('flat');
    expect(computeKpi(KpiConfigSchema.parse({ field: 'v', compare: 'previous' }), table).trend).toBe('good');
  });
});

describe('reference lines', () => {
  const table = inferTable([
    { station: 'a', temp: 10, rain: 1 },
    { station: 'b', temp: 20, rain: 2 },
    { station: 'c', temp: 60, rain: 3 },
    { station: 'd', temp: null, rain: 4 },
  ]);
  const chart = (extra: Record<string, unknown>) =>
    ChartConfigSchema.parse({ kind: 'bar', x: 'station', y: ['temp'], ...extra });
  type MarkData = {
    yAxis?: number;
    xAxis?: number;
    lineStyle: { color: string; type: string };
    label: { formatter: () => string };
  };
  const marks = (config: ReturnType<typeof chart>) =>
    (buildChartOption(config, table, t).series as { markLine?: { data: MarkData[] } }[])[0]!.markLine?.data ??
    [];

  it('computes each statistic over the plotted numbers', () => {
    const value = (stat: 'avg' | 'median' | 'min' | 'max', field?: string) =>
      referenceLineValue({ stat, ...(field ? { field } : {}) }, chart({}), table);
    expect(value('avg')).toBe(30);
    expect(value('median')).toBe(20);
    expect(value('min')).toBe(10);
    expect(value('max')).toBe(60);
    expect(value('median', 'rain')).toBe(2.5);
    expect(referenceLineValue({ value: 7 }, chart({}), table)).toBe(7);
  });

  it('draws a dashed line on the value axis with a labelled value', () => {
    const data = marks(
      chart({
        referenceLines: [
          { stat: 'avg', label: 'Network average' },
          { value: 15, color: 'warning' },
        ],
      }),
    );
    expect(data).toHaveLength(2);
    expect(data[0]!.yAxis).toBe(30);
    expect(data[0]!.lineStyle).toMatchObject({ type: 'dashed', color: t.muted });
    expect(data[0]!.label.formatter()).toBe('Network average · 30');
    expect(data[1]!.lineStyle.color).toBe(t.status.warning);
    expect(data[1]!.label.formatter()).toBe('15');
  });

  it('draws on the x axis of horizontal bars', () => {
    const data = marks(chart({ horizontal: true, referenceLines: [{ value: 15 }] }));
    expect(data[0]!.xAxis).toBe(15);
    expect(data[0]!.yAxis).toBeUndefined();
  });

  it('widens the value axis so a line outside the data stays visible, unless the bound is fixed', () => {
    const axis = (config: ReturnType<typeof chart>) =>
      buildChartOption(config, table, t).yAxis as { min?: unknown; max?: unknown };
    const wide = axis(chart({ referenceLines: [{ value: 100 }] }));
    const max = wide.max as (e: { min: number; max: number }) => number | undefined;
    expect(max({ min: 0, max: 60 })).toBeGreaterThan(100);
    expect(max({ min: 0, max: 200 })).toBeUndefined();
    expect(axis(chart({ yMax: 80, referenceLines: [{ value: 100 }] })).max).toBe(80);
    expect(axis(chart({})).max).toBeUndefined();
  });

  it('refuses lines without a value axis, with both or neither of value and stat, or on another column', () => {
    const base = applyOps(emptyDashboard(), [
      { op: 'addDataset', dataset: { id: 'd', name: 'D', source: { kind: 'inline', rows: [] } } },
    ]).doc;
    const add = (config: Record<string, unknown>) => () =>
      applyOps(base, [
        { op: 'addWidget', widget: { id: 'stations', type: 'chart', datasetId: 'd', config } },
      ]);
    expect(add({ kind: 'pie', x: 'station', y: ['temp'], referenceLines: [{ value: 1 }] })).toThrow(
      /no value axis/,
    );
    expect(
      add({ kind: 'bar', x: 'station', y: ['temp'], referenceLines: [{ value: 1, stat: 'avg' }] }),
    ).toThrow('Reference line 1 of "stations": give either value or stat');
    expect(add({ kind: 'bar', x: 'station', y: ['temp'], referenceLines: [{ label: 'x' }] })).toThrow(
      /either value or stat/,
    );
    expect(
      add({ kind: 'bar', x: 'station', y: ['temp'], referenceLines: [{ stat: 'avg', field: 'rain' }] }),
    ).toThrow(/not one of the chart's y columns/);
    expect(add({ kind: 'line', x: 'station', y: ['temp'], referenceLines: [{ stat: 'max' }] })).not.toThrow();
  });
});
