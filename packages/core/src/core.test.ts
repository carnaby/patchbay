import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildChartOption,
  compile,
  computeKpi,
  DocumentError,
  diffSteps,
  ExprError,
  emptyDashboard,
  inferTable,
  normalizeLayout,
  OpError,
  parse,
  parseDashboard,
  profileTable,
  runPipeline,
  suggestWidgets,
  THEMES,
  TransformError,
  TransformSchema,
} from './index.ts';

describe('expressions', () => {
  const row = { price: 12.5, qty: 4, region: 'EU', 'wind speed': 7, empty: null };

  it('evaluates arithmetic with precedence', () => {
    expect(compile('price * qty + 1')(row)).toBe(51);
    expect(compile('-2 ^ 2')(row)).toBe(-4);
    expect(compile('2 ^ 3 ^ 2')(row)).toBe(512);
    expect(compile('(1 + 2) * 3 % 4')(row)).toBe(1);
  });

  it('supports logic, comparisons, ternaries and keywords', () => {
    expect(compile('price > 10 && lower(region) == "eu"')(row)).toBe(true);
    expect(compile('qty < 3 or not (region != "EU")')(row)).toBe(true);
    expect(compile('qty > 3 ? "many" : "few"')(row)).toBe('many');
  });

  it('reads backtick-quoted fields and treats null safely', () => {
    expect(compile('`wind speed` * 2')(row)).toBe(14);
    expect(compile('empty + 1')(row)).toBeNull();
    expect(compile('coalesce(empty, 5)')(row)).toBe(5);
    expect(compile('missing == null')(row)).toBe(true);
  });

  it('rejects anything outside the language', () => {
    expect(() => parse('constructor.constructor("return process")()')).toThrow(ExprError);
    expect(() => parse('a = 1')).toThrow(/Use ==/);
    expect(() => parse('eval("1")')).toThrow(/Unknown function/);
    expect(() => parse('1 +')).toThrow(ExprError);
    expect(() => parse(`${'1+'.repeat(500)}1`)).toThrow(/complex/);
  });

  it('does not leak prototype properties as fields', () => {
    expect(compile('toString')({})).toBeNull();
    expect(compile('__proto__')({})).toBeNull();
  });
});

describe('table inference', () => {
  it('infers numbers, times and flattens nested objects', () => {
    const t = inferTable([
      { date: '2026-01-01', v: '3.5', meta: { tag: 'a' } },
      { date: '2026-01-02T10:00:00Z', v: 4, meta: { tag: 'b' } },
    ]);
    expect(t.columns).toEqual([
      { name: 'date', type: 'time' },
      { name: 'v', type: 'number' },
      { name: 'meta.tag', type: 'string' },
    ]);
    expect(t.rows[0]!.date).toBe(Date.UTC(2026, 0, 1));
    expect(t.rows[0]!.v).toBe(3.5);
  });
});

describe('pipeline', () => {
  const sales = inferTable([
    { day: '2026-01-01T08:00:00Z', region: 'EU', amount: 10 },
    { day: '2026-01-01T12:00:00Z', region: 'US', amount: 5 },
    { day: '2026-01-02T09:00:00Z', region: 'EU', amount: 7 },
    { day: '2026-01-03T09:00:00Z', region: 'US', amount: null },
  ]);
  const t = (input: unknown) => TransformSchema.parse(input);

  it('filters, buckets, aggregates and sorts', () => {
    const { table, trace } = runPipeline(sales, [
      t({ type: 'filter', expr: 'amount != null' }),
      t({ type: 'timeBucket', field: 'day', unit: 'day' }),
      t({
        type: 'aggregate',
        groupBy: ['day'],
        metrics: [{ op: 'sum', field: 'amount', as: 'total' }, { op: 'count' }],
      }),
      t({ type: 'sort', by: [{ field: 'total', dir: 'desc' }] }),
    ]);
    expect(table.rows).toEqual([
      { day: Date.UTC(2026, 0, 1), total: 15, count: 2 },
      { day: Date.UTC(2026, 0, 2), total: 7, count: 1 },
    ]);
    expect(table.columns.find((c) => c.name === 'day')?.type).toBe('time');
    expect(trace.map((s) => s.rows)).toEqual([3, 3, 2, 2]);
  });

  it('derives columns and runs window functions per partition', () => {
    const { table } = runPipeline(sales, [
      t({ type: 'fillNull', fields: ['amount'], value: 0 }),
      t({ type: 'derive', as: 'double', expr: 'amount * 2' }),
      t({ type: 'window', op: 'cumsum', field: 'amount', partitionBy: ['region'], as: 'running' }),
    ]);
    expect(table.rows.map((r) => r.running)).toEqual([10, 5, 17, 5]);
    expect(table.rows.map((r) => r.double)).toEqual([20, 10, 14, 0]);
  });

  it('reports unknown columns with the step number and available columns', () => {
    expect(() => runPipeline(sales, [t({ type: 'select', fields: ['nope'] })])).toThrow(TransformError);
    expect(() => runPipeline(sales, [t({ type: 'filter', expr: 'nope > 1' })])).toThrow(
      /Step 1: Unknown column "nope"/,
    );
  });

  it('stops exponential string growth and ranks large inputs quickly', () => {
    const doubling = Array.from({ length: 30 }, () => t({ type: 'derive', as: 's', expr: 'concat(s, s)' }));
    const seed = inferTable([{ s: 'xxxxxxxxxx' }]);
    expect(() => runPipeline(seed, doubling)).toThrow(/limited to/);
    const big = inferTable(Array.from({ length: 50_000 }, (_, i) => ({ v: (i * 7919) % 1000 })));
    const startedAt = Date.now();
    const { table } = runPipeline(big, [t({ type: 'window', op: 'rank', field: 'v', as: 'r' })]);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const max = table.rows.find((r) => r.v === 999)!;
    expect(max.r).toBe(1);
  });

  it('rejects invalid expressions at validation time', () => {
    expect(TransformSchema.safeParse({ type: 'derive', as: 'x', expr: 'a +' }).success).toBe(false);
  });
});

describe('operations', () => {
  const base = emptyDashboard('Test');
  const dataset = { id: 'ds', name: 'Data', source: { kind: 'inline', rows: [{ a: 1 }] } };

  it('applies a batch atomically and auto-places widgets', () => {
    const { doc, changes } = applyOps(base, [
      { op: 'addDataset', dataset },
      { op: 'addWidget', widget: { id: 'k1', type: 'kpi', datasetId: 'ds', config: { field: 'a' } } },
      { op: 'addWidget', widget: { id: 'k2', type: 'kpi', datasetId: 'ds', config: { field: 'a' } } },
      { op: 'setMeta', title: 'Renamed' },
    ]);
    expect(doc.title).toBe('Renamed');
    expect(doc.layout).toEqual([
      { i: 'k1', x: 0, y: 0, w: 3, h: 2 },
      { i: 'k2', x: 3, y: 0, w: 3, h: 2 },
    ]);
    expect(changes).toHaveLength(4);
  });

  it('leaves the document untouched when any op fails', () => {
    expect(() =>
      applyOps(base, [
        { op: 'addDataset', dataset },
        {
          op: 'addWidget',
          widget: {
            id: 'w',
            type: 'chart',
            datasetId: 'missing',
            config: { kind: 'line', x: 'a', y: ['a'] },
          },
        },
      ]),
    ).toThrow(DocumentError);
    expect(base.datasets).toHaveLength(0);
  });

  it('protects datasets in use unless cascade is requested', () => {
    const { doc } = applyOps(base, [
      { op: 'addDataset', dataset },
      { op: 'addWidget', widget: { id: 't', type: 'table', datasetId: 'ds', config: {} } },
    ]);
    expect(() => applyOps(doc, [{ op: 'removeDataset', id: 'ds' }])).toThrow(OpError);
    expect(applyOps(doc, [{ op: 'removeDataset', id: 'ds', cascade: true }]).doc.widgets).toHaveLength(0);
  });

  it('merges widget config updates and validates them', () => {
    const { doc } = applyOps(base, [
      { op: 'addDataset', dataset },
      {
        op: 'addWidget',
        widget: { id: 'c', type: 'chart', datasetId: 'ds', config: { kind: 'line', x: 'a', y: ['a'] } },
      },
    ]);
    const next = applyOps(doc, [{ op: 'updateWidget', id: 'c', set: { config: { kind: 'bar' } } }]).doc;
    expect(next.widgets[0]).toMatchObject({ config: { kind: 'bar', x: 'a' } });
    expect(() =>
      applyOps(doc, [{ op: 'updateWidget', id: 'c', set: { config: { kind: 'pizza' } } }]),
    ).toThrow(OpError);
    expect(() => applyOps(doc, [{ op: 'updateWidget', id: 'c', set: { config: { bogus: 1 } } }])).toThrow(
      OpError,
    );
  });

  it('rejects unknown op shapes', () => {
    expect(() => applyOps(base, [{ op: 'dropTable' }])).toThrow(OpError);
  });
});

describe('pipeline steps with stable ids', () => {
  const base = applyOps(emptyDashboard(), [
    {
      op: 'addDataset',
      dataset: {
        id: 'ds',
        name: 'Data',
        source: { kind: 'inline', rows: [{ a: 1, b: 'x' }] },
        transforms: [
          { type: 'filter', expr: 'a > 0' },
          { type: 'sort', by: [{ field: 'a' }] },
        ],
      },
    },
  ]).doc;
  const steps = () => base.datasets[0]!.transforms;

  it('assigns ids to steps that have none (migration on read)', () => {
    expect(steps().map((s) => s.id)).toEqual(['s1', 's2']);
    const reparsed = parseDashboard(JSON.parse(JSON.stringify(base)));
    expect(reparsed.datasets[0]!.transforms.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('adds, updates, moves and removes single steps by id', () => {
    const { doc } = applyOps(base, [
      { op: 'addStep', datasetId: 'ds', step: { type: 'limit', n: 5 }, before: 's2' },
      { op: 'updateStep', datasetId: 'ds', stepId: 's1', set: { expr: 'a > 1' } },
      { op: 'moveStep', datasetId: 'ds', stepId: 's2', before: 's1' },
      { op: 'removeStep', datasetId: 'ds', stepId: 's3' },
    ]);
    expect(doc.datasets[0]!.transforms).toMatchObject([
      { id: 's2', type: 'sort' },
      { id: 's1', type: 'filter', expr: 'a > 1' },
    ]);
    expect(() => applyOps(base, [{ op: 'updateStep', datasetId: 'ds', stepId: 'nope', set: {} }])).toThrow(
      /no step "nope"/,
    );
    expect(() =>
      applyOps(base, [{ op: 'updateStep', datasetId: 'ds', stepId: 's1', set: { expr: 'a +' } }]),
    ).toThrow(OpError);
  });

  it('turns an edited pipeline into step ops that survive a concurrent edit', () => {
    // The user edits locally: changes the sort, adds a limit at the end, reorders.
    const mine = [
      { id: 's2', type: 'sort', by: [{ field: 'a', dir: 'desc' }] },
      { id: 's1', type: 'filter', expr: 'a > 0' },
      { type: 'limit', n: 10 },
    ];
    const ops = diffSteps('ds', steps(), mine);
    expect(applyOps(base, ops).doc.datasets[0]!.transforms.map((s) => s.type)).toEqual([
      'sort',
      'filter',
      'limit',
    ]);
    // Meanwhile an agent changed the filter. Replaying my ops keeps its change.
    const theirs = applyOps(base, [
      { op: 'updateStep', datasetId: 'ds', stepId: 's1', set: { expr: 'a > 100' } },
    ]).doc;
    const merged = applyOps(theirs, ops).doc.datasets[0]!.transforms;
    expect(merged).toMatchObject([
      { id: 's2', type: 'sort', by: [{ field: 'a', dir: 'desc' }] },
      { id: 's1', expr: 'a > 100' },
      { type: 'limit', n: 10 },
    ]);
  });

  it('produces no ops for an unchanged pipeline', () => {
    expect(diffSteps('ds', steps(), steps())).toEqual([]);
  });
});

describe('document validation', () => {
  it('reports integrity problems', () => {
    expect(() =>
      parseDashboard({
        ...emptyDashboard(),
        widgets: [{ id: 'x', type: 'text', config: { markdown: 'hi' } }],
        layout: [],
      }),
    ).toThrow(/no layout entry/);
  });

  it('normalises overlapping and orphan layout entries', () => {
    const layout = normalizeLayout(
      [
        { i: 'a', x: 0, y: 0, w: 6, h: 2 },
        { i: 'b', x: 0, y: 0, w: 6, h: 2 },
        { i: 'ghost', x: 0, y: 0, w: 1, h: 1 },
      ],
      [
        { id: 'a', type: 'text' },
        { id: 'b', type: 'text' },
        { id: 'c', type: 'kpi' },
      ],
    );
    expect(layout).toEqual([
      { i: 'a', x: 0, y: 0, w: 6, h: 2 },
      { i: 'b', x: 0, y: 2, w: 6, h: 2 },
      { i: 'c', x: 6, y: 0, w: 3, h: 2 },
    ]);
  });
});

describe('profiling and suggestions', () => {
  const rows = Array.from({ length: 48 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    temperature: 10 + Math.sin(i / 4) * 5,
    city: i % 2 ? 'Bratislava' : 'Vienna',
  }));
  const table = inferTable(rows);

  it('detects column roles', () => {
    const p = profileTable(table);
    expect(p.columns.map((c) => c.role)).toEqual(['time', 'measure', 'dimension']);
    expect(p.span?.field).toBe('time');
  });

  it('suggests a time series first and validates as real widgets', () => {
    const suggestions = suggestWidgets(profileTable(table));
    expect(suggestions[0]!.widget).toMatchObject({ type: 'chart', config: { kind: 'line', x: 'time' } });
    let doc = applyOps(emptyDashboard(), [
      { op: 'addDataset', dataset: { id: 'ds', name: 'd', source: { kind: 'inline', rows: [] } } },
    ]).doc;
    suggestions.forEach((s, i) => {
      doc = applyOps(doc, [{ op: 'addWidget', widget: { ...s.widget, id: `w${i}`, datasetId: 'ds' } }]).doc;
      for (const tr of s.transforms) expect(TransformSchema.safeParse(tr).success).toBe(true);
    });
    expect(doc.widgets.length).toBe(suggestions.length);
  });
});

describe('chart + kpi builders', () => {
  const table = inferTable([
    { t: '2026-01-01', v: 1, s: 'a' },
    { t: '2026-01-02', v: 3, s: 'b' },
    { t: '2026-01-03', v: 2, s: 'a' },
  ]);

  it('builds a time series option with one series per split value', () => {
    const option = buildChartOption(
      {
        kind: 'line',
        x: 't',
        y: ['v'],
        series: 's',
        horizontal: false,
        stacked: false,
        smooth: false,
        showLabels: false,
        logScale: false,
        maxPoints: 5000,
      },
      table,
      THEMES.light,
    ) as { xAxis: { type: string }; series: { name: string }[] };
    expect(option.xAxis.type).toBe('time');
    expect(option.series.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('explains missing columns instead of throwing', () => {
    const option = buildChartOption(
      {
        kind: 'bar',
        x: 'nope',
        y: ['v'],
        horizontal: false,
        stacked: false,
        smooth: false,
        showLabels: false,
        logScale: false,
        maxPoints: 5000,
      },
      table,
      THEMES.dark,
    ) as { title: { text: string } };
    expect(option.title.text).toMatch(/Missing column/);
  });

  it('computes KPI deltas with direction semantics', () => {
    const kpi = computeKpi(
      { field: 'v', agg: 'last', compare: 'previous', goodWhen: 'down', sparkline: true },
      table,
    );
    expect(kpi).toMatchObject({ value: 2, previous: 3, delta: -1, trend: 'good', spark: [1, 3, 2] });
  });
});
