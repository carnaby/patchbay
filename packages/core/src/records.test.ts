import { describe, expect, it } from 'vitest';
import { columnShape, columnsToRecords, findRecords, PathNotFoundError, pickPath } from './records.ts';

/** A metrics API answer in columns: an ISO time, a number with a gap, a status. */
const METRICS = {
  timestamps: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', '2026-11-01T02:00:00Z'],
  values: [12.5, null, 14],
  status: ['ok', 'warn', 'ok'],
};
/** One list only: the first-array rule already reads it, as single values. */
const SINGLE = { values: [1, 2, 3] };
/** Lists of different lengths: not columns, the first list wins as before. */
const UNEQUAL = { timestamps: [1, 2, 3], values: [5, 6] };
/** A list holding objects: not columns, the first list wins as before. */
const NESTED = { timestamps: [1, 2], values: [{ v: 5 }, { v: 6 }] };

describe('columnsToRecords', () => {
  it('turns a metrics object into one row per position, columns in key order', () => {
    expect(columnsToRecords(METRICS)).toEqual([
      { timestamps: '2026-11-01T00:00:00Z', values: 12.5, status: 'ok' },
      { timestamps: '2026-11-01T01:00:00Z', values: null, status: 'warn' },
      { timestamps: '2026-11-01T02:00:00Z', values: 14, status: 'ok' },
    ]);
    expect(Object.keys(columnsToRecords({ z: [1], a: [2], m: [3] })![0]!)).toEqual(['z', 'a', 'm']);
  });

  it('allows null and boolean elements', () => {
    expect(columnsToRecords({ ok: [true, null], n: [null, 0] })).toEqual([
      { ok: true, n: null },
      { ok: null, n: 0 },
    ]);
  });

  it('keeps the record rules for anything looser', () => {
    expect(columnsToRecords(SINGLE)).toBeNull();
    expect(columnsToRecords(UNEQUAL)).toBeNull();
    expect(columnsToRecords(NESTED)).toBeNull();
    expect(columnsToRecords({ a: [[1], [2]], b: [1, 2] })).toBeNull();
    expect(columnsToRecords({ a: [], b: [] })).toBeNull();
    expect(columnsToRecords({ a: [1], b: 2 })).toBeNull();
    expect(columnsToRecords([[1], [2]])).toBeNull();
    expect(columnsToRecords(null)).toBeNull();
    expect(columnsToRecords('x')).toBeNull();
  });

  it('builds at most one row more than maxCells holds', () => {
    const long = {
      a: Array.from({ length: 1000 }, (_, i) => i),
      b: Array.from({ length: 1000 }, (_, i) => -i),
    };
    expect(columnsToRecords(long, 500)).toHaveLength(251);
    expect(columnsToRecords(long)).toHaveLength(1000);
  });

  it('keeps a "__proto__" key as a column, not as the prototype', () => {
    const rows = columnsToRecords(JSON.parse('{"__proto__": [1, 2], "b": [3, 4]}'))!;
    expect(Object.keys(rows[0]!)).toEqual(['__proto__', 'b']);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });

  it('keeps the key order JSON objects have in JavaScript: whole-number keys first, ascending', () => {
    const rows = columnsToRecords(JSON.parse('{"b": [1], "2025": [2], "2024": [3]}'))!;
    expect(Object.keys(rows[0]!)).toEqual(['2024', '2025', 'b']);
  });
});

describe('columnShape', () => {
  it('measures a column-shaped object, and is null for anything the record rules read', () => {
    expect(columnShape(METRICS)).toEqual({ rows: 3, columns: 3 });
    expect(columnShape(SINGLE)).toBeNull();
    expect(columnShape(UNEQUAL)).toBeNull();
    expect(columnShape(NESTED)).toBeNull();
    expect(columnShape([[1], [2]])).toBeNull();
    expect(columnShape(null)).toBeNull();
  });
});

describe('pickPath', () => {
  it('walks a dot path and names where it stopped', () => {
    const doc = { data: { items: [{ x: 1 }] } };
    expect(pickPath(doc, 'data.items', 'file')).toEqual([{ x: 1 }]);
    expect(pickPath(doc, '.data..items.', 'file')).toEqual([{ x: 1 }]);
    expect(pickPath(doc, 'data.items.0', 'file')).toEqual({ x: 1 });
    expect(pickPath(doc, undefined, 'file')).toBe(doc);
    expect(pickPath(doc, '', 'file')).toBe(doc);
    expect(() => pickPath(doc, 'data.rows', 'file')).toThrow(PathNotFoundError);
    expect(() => pickPath(doc, 'data.rows', 'file')).toThrow(
      'Path "data.rows" not found in the file (stopped at "rows")',
    );
    expect(() => pickPath(doc, 'data.rows', 'response')).toThrow(
      'Path "data.rows" not found in the response (stopped at "rows")',
    );
    expect(() => pickPath({ a: null }, 'a.b', 'file')).toThrow('(stopped at "b")');
    expect(() => pickPath({}, 'toString', 'file')).toThrow('(stopped at "toString")');
  });
});

describe('findRecords', () => {
  const at = (doc: unknown, path?: string) =>
    findRecords(pickPath(doc, path, 'file'), { viaPath: Boolean(path), maxCells: Number.POSITIVE_INFINITY });

  it('reads lists, column-shaped objects, envelopes and single objects as before', () => {
    expect(at([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(at(METRICS)).toHaveLength(3);
    expect(at({ data: METRICS }, 'data')).toHaveLength(3);
    expect(at({ data: METRICS })).toEqual([{ data: METRICS }]);
    expect(at(SINGLE)).toEqual([1, 2, 3]);
    expect(at(UNEQUAL)).toEqual([1, 2, 3]);
    expect(at(NESTED)).toEqual([1, 2]);
    expect(at({ count: 2, results: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(at({ data: { a: 1, list: [1] } }, 'data')).toEqual([{ a: 1, list: [1] }]);
    expect(at({ a: 1 })).toEqual([{ a: 1 }]);
    expect(at(5)).toBeNull();
    expect(at(null)).toBeNull();
  });

  it('passes the cell bound on to the conversion', () => {
    const long = { a: Array.from({ length: 100 }, (_, i) => i), b: Array.from({ length: 100 }, () => 0) };
    expect(findRecords(long, { viaPath: false, maxCells: 10 })).toHaveLength(6);
  });
});
