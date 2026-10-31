import { describe, expect, it } from 'vitest';
import { type DataTable, decodeTable, hashTable, rowValues, tableSize, wireSize } from './index.ts';

const table: DataTable = {
  columns: [
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
    { name: 'open', type: 'boolean' },
  ],
  rows: [
    { region: 'EU', revenue: 12.5, open: true },
    { region: 'US', revenue: null, open: false },
    { region: 'APAC', open: true },
  ],
};

describe('rows as arrays', () => {
  it('round-trips through JSON, a missing value coming back as null', () => {
    const wire = JSON.parse(
      JSON.stringify({ columns: table.columns, rows: table.rows.map((r) => rowValues(table.columns, r)) }),
    );
    expect(wire.rows[2]).toEqual(['APAC', null, true]);
    expect(decodeTable(wire)).toEqual({
      columns: table.columns,
      rows: [table.rows[0], table.rows[1], { region: 'APAC', revenue: null, open: true }],
    });
  });

  it('leaves rows that already are objects alone', () => {
    expect(decodeTable(table)).toBe(table);
    expect(decodeTable({ columns: table.columns, rows: [] }).rows).toEqual([]);
  });

  it('measures column names once instead of once per row', () => {
    const name = 'x'.repeat(1000);
    const wide: DataTable = {
      columns: [{ name, type: 'number' }],
      rows: Array.from({ length: 1000 }, (_, i) => ({ [name]: i })),
    };
    expect(wireSize(wide, 'objects')).toBeGreaterThan(1_000_000);
    expect(wireSize(wide, 'arrays')).toBeLessThan(20_000);
    expect(wireSize(wide, 'objects')).toBeGreaterThanOrEqual(tableSize(wide));
  });

  it('estimates plain text at least as large as the JSON it becomes', () => {
    const json = JSON.stringify({ columns: table.columns, rows: table.rows });
    const arrays = JSON.stringify({
      columns: table.columns,
      rows: table.rows.map((r) => rowValues(table.columns, r)),
    });
    expect(wireSize(table, 'objects')).toBeGreaterThanOrEqual(json.length);
    expect(wireSize(table, 'arrays')).toBeGreaterThanOrEqual(arrays.length);
  });
});

describe('hashTable', () => {
  it('tells values, types and their boundaries apart', () => {
    const one = (v: unknown) =>
      hashTable({ columns: [{ name: 'a', type: 'string' }], rows: [{ a: v as string }] });
    expect(new Set([one(1), one('1'), one(true), one('true'), one(null), one('')]).size).toBe(6);
    const two = (a: string, b: string) =>
      hashTable({
        columns: [
          { name: 'a', type: 'string' },
          { name: 'b', type: 'string' },
        ],
        rows: [{ a, b }],
      });
    expect(two('ab', 'c')).not.toBe(two('a', 'bc'));
    expect(hashTable(table)).toBe(hashTable(structuredClone(table)));
  });

  it('hashes a table with long column names without building its JSON', () => {
    const columns = Array.from({ length: 20 }, (_, i) => ({
      name: `${i}${'n'.repeat(1000)}`,
      type: 'number' as const,
    }));
    const rows = Array.from({ length: 10_000 }, (_, r) =>
      Object.fromEntries(columns.map((c) => [c.name, r % 10])),
    );
    // As one JSON string this table is about 200 MB.
    const started = Date.now();
    expect(hashTable({ columns, rows })).toMatch(/^[0-9a-z]+$/);
    // A 200 MB JSON string would take far longer and allocate gigabytes; this is only a safety net.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
