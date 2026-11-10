import { describe, expect, it } from 'vitest';
import { type DataTable, inferTable } from './table.ts';
import { type PipelineInputs, runPipeline, type Transform, TransformSchema } from './transforms.ts';

/**
 * A source may name a column "__proto__" (a JSON key, a CSV header), and uploads keep it. Every step must treat it as
 * an ordinary column: rows keep it as an own property and the normal prototype, and names and types stay strings.
 */
const PROTO = '__proto__';
const TYPES = ['number', 'string', 'boolean', 'time'];

const run = (table: DataTable, list: unknown[], inputs?: PipelineInputs) =>
  runPipeline(
    table,
    list.map((s) => TransformSchema.parse(s) as Transform),
    inputs,
  ).table;

function expectOrdinary(table: DataTable) {
  for (const c of table.columns) {
    expect(typeof c.name).toBe('string');
    expect(TYPES).toContain(c.type);
  }
  const names = table.columns.map((c) => c.name).sort();
  for (const row of table.rows) {
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.keys(row).sort()).toEqual(names);
  }
  // Nothing reached the shared prototype.
  expect(Object.keys(Object.prototype)).toEqual([]);
}

const column = (table: DataTable, name: string) =>
  table.rows.map((r) => (Object.hasOwn(r, name) ? r[name] : 'missing'));

const data = inferTable(
  JSON.parse(`[
    {"__proto__": 3, "g": "a", "b": null, "t": "2026-01-01T05:00:00Z"},
    {"__proto__": 1, "g": "a", "b": 2, "t": "2026-01-02T05:00:00Z"},
    {"__proto__": null, "g": "b", "b": 4, "t": "2026-01-03T05:00:00Z"}
  ]`),
);
const plain = inferTable([
  { g: 'a', b: 1 },
  { g: 'b', b: null },
]);

describe('a column named "__proto__" in every step', () => {
  it('starts as an ordinary column', () => {
    expect(data.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      '__proto__:number',
      'g:string',
      'b:number',
      't:time',
    ]);
    expectOrdinary(data);
  });

  it('filter, select, drop, sort and limit', () => {
    const cases: [unknown[], (number | null | string)[]][] = [
      [[{ type: 'filter', expr: '`__proto__` > 1' }], [3]],
      [[{ type: 'select', fields: [PROTO, 'g'] }], [3, 1, null]],
      [[{ type: 'drop', fields: ['b'] }], [3, 1, null]],
      [[{ type: 'sort', by: [{ field: PROTO, dir: 'asc' }] }], [1, 3, null]],
      [[{ type: 'limit', n: 1 }], [3]],
    ];
    for (const [steps, values] of cases) {
      const table = run(data, steps);
      expectOrdinary(table);
      expect(column(table, PROTO)).toEqual(values);
    }
  });

  it('rename: other columns, and a column renamed to it', () => {
    const renamed = run(data, [{ type: 'rename', map: { g: 'group' } }]);
    expectOrdinary(renamed);
    expect(renamed.columns.map((c) => c.name)).toEqual([PROTO, 'group', 'b', 't']);
    expect(column(renamed, PROTO)).toEqual([3, 1, null]);
    const to = run(plain, [{ type: 'rename', map: { b: PROTO } }]);
    expectOrdinary(to);
    expect(column(to, PROTO)).toEqual([1, null]);
    // A column named after an inherited member is not renamed by the prototype either.
    const ctor = run(inferTable([{ constructor: 'x', g: 'a' }]), [{ type: 'rename', map: { g: 'h' } }]);
    expect(ctor.columns.map((c) => c.name)).toEqual(['constructor', 'h']);
  });

  it('derive into it, also when every value is null', () => {
    const derived = run(plain, [{ type: 'derive', as: PROTO, expr: 'b * 2' }]);
    expectOrdinary(derived);
    expect(column(derived, PROTO)).toEqual([2, null]);
    const nulls = run(inferTable([{ b: null }, { b: null }]), [{ type: 'derive', as: PROTO, expr: 'b' }]);
    expectOrdinary(nulls);
  });

  it('aggregate: grouped by it, a metric of it and a metric named it', () => {
    const grouped = run(data, [{ type: 'aggregate', groupBy: [PROTO], metrics: [{ op: 'count' }] }]);
    expectOrdinary(grouped);
    expect(column(grouped, PROTO)).toEqual([3, 1, null]);
    const summed = run(data, [
      { type: 'aggregate', groupBy: ['g'], metrics: [{ op: 'sum', field: PROTO, as: PROTO }] },
    ]);
    expectOrdinary(summed);
    expect(column(summed, PROTO)).toEqual([4, null]);
    // A time column grouped by, or taken as a time metric, keeps its type.
    const times = inferTable(
      JSON.parse(
        '[{"__proto__": "2026-01-01T05:00:00Z", "g": "a"}, {"__proto__": "2026-01-02T05:00:00Z", "g": "a"}]',
      ),
    );
    expect(times.columns[0]).toEqual({ name: PROTO, type: 'time' });
    const byTime = run(times, [{ type: 'aggregate', groupBy: [PROTO], metrics: [{ op: 'count' }] }]);
    expectOrdinary(byTime);
    expect(byTime.columns[0]).toEqual({ name: PROTO, type: 'time' });
    const latest = run(times, [
      { type: 'aggregate', groupBy: ['g'], metrics: [{ op: 'max', field: PROTO, as: PROTO }] },
    ]);
    expectOrdinary(latest);
    expect(latest.columns[1]).toEqual({ name: PROTO, type: 'time' });
  });

  it('timeBucket, window and fillNull on it', () => {
    const asTime = run(data, [
      { type: 'derive', as: PROTO, expr: 't' },
      { type: 'timeBucket', field: PROTO, unit: 'month' },
    ]);
    expectOrdinary(asTime);
    expect(column(asTime, PROTO)).toEqual([Date.UTC(2026, 0), Date.UTC(2026, 0), Date.UTC(2026, 0)]);
    const windowed = run(data, [{ type: 'window', op: 'cumsum', field: PROTO, as: 'running' }]);
    expectOrdinary(windowed);
    expect(column(windowed, 'running')).toEqual([3, 4, 4]);
    const into = run(data, [{ type: 'window', op: 'cumsum', field: 'b', as: PROTO }]);
    expectOrdinary(into);
    expect(column(into, PROTO)).toEqual([0, 2, 6]);
    const filled = run(data, [{ type: 'fillNull', fields: [PROTO], value: 0 }]);
    expectOrdinary(filled);
    expect(column(filled, PROTO)).toEqual([3, 1, 0]);
  });

  it('join brings it in from the other dataset', () => {
    const inputs: PipelineInputs = {
      tables: { other: { name: 'Other', table: data } },
      self: { id: 'p', name: 'P' },
    };
    const joined = run(
      plain,
      [{ type: 'join', with: 'other', on: ['g'], fields: [PROTO], how: 'left' }],
      inputs,
    );
    expectOrdinary(joined);
    expect(joined.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'g:string',
      'b:number',
      '__proto__:number',
    ]);
    expect(column(joined, PROTO)).toEqual([3, 1, null]);
  });

  it('union: a column only one side has, and an origin column named it', () => {
    const ctor = inferTable([{ constructor: 'x', g: 'c' }]);
    const inputs: PipelineInputs = {
      tables: { other: { name: 'Other', table: data }, ctor: { name: 'Ctor', table: ctor } },
      self: { id: 'p', name: 'P' },
    };
    const united = run(plain, [{ type: 'union', with: ['other', 'ctor'] }], inputs);
    expectOrdinary(united);
    expect(column(united, PROTO)).toEqual([null, null, 3, 1, null, null]);
    // Rows without a "constructor" column read it as empty, not as Object's constructor.
    expect(column(united, 'constructor')).toEqual([null, null, null, null, null, 'x']);
    const origin = run(plain, [{ type: 'union', with: ['ctor'], origin: PROTO }], inputs);
    expectOrdinary(origin);
    expect(column(origin, PROTO)).toEqual(['P', 'P', 'Ctor']);
    expect(origin.columns.at(-1)).toEqual({ name: PROTO, type: 'string' });
  });
});
