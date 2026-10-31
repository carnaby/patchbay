/**
 * How a data result's rows travel to clients. As objects (the default, and what MCP agents read) every row repeats
 * every column name, so a table with long names costs many times what it holds; as arrays the names come once, in
 * `columns`, and each row lists its values in that order. The web app asks for arrays and turns them back into rows
 * with `decodeTable`, so everything after the fetch sees ordinary rows.
 */
import type { Column, DataTable, Row, Scalar } from './table.ts';

export type RowsFormat = 'objects' | 'arrays';

/** A table as sent: rows as objects or, in the arrays format, as value lists in column order. */
export interface WireTable {
  columns: Column[];
  rows: Row[] | Scalar[][];
}

/** Approximate JSON size of one value in characters: text with its quotes, a typical number, null or a boolean. */
function valueSize(value: Scalar | undefined): number {
  return typeof value === 'string' ? value.length + 2 : 6;
}

/** Approximate JSON size of one row in the given format, in characters (escapes and non-ASCII text add more). */
export function rowSize(columns: Column[], row: Row, format: RowsFormat): number {
  let size = 3;
  if (format === 'objects') for (const c of columns) size += c.name.length + 4 + valueSize(row[c.name]);
  else for (const c of columns) size += 1 + valueSize(row[c.name]);
  return size;
}

/** Approximate JSON size of the column list, in characters. */
export function columnsSize(columns: Column[]): number {
  let size = 2;
  for (const c of columns) size += c.name.length + c.type.length + 22;
  return size;
}

/**
 * Approximate size of a table as JSON in the given format, in characters, without building it. The same measure as
 * `tableSize` for objects; the server compares it with what it may send before it serialises anything.
 */
export function wireSize(table: DataTable, format: RowsFormat): number {
  let size = 24 + columnsSize(table.columns);
  for (const row of table.rows) size += rowSize(table.columns, row, format);
  return size;
}

/** One row as the arrays format sends it; a missing value becomes null. */
export function rowValues(columns: Column[], row: Row): Scalar[] {
  return columns.map((c) => row[c.name] ?? null);
}

/** Turns a table in either format back into rows keyed by column name. */
export function decodeTable(table: WireTable): DataTable {
  const rows = table.rows;
  if (rows.length === 0 || !Array.isArray(rows[0])) return table as DataTable;
  const names = table.columns.map((c) => c.name);
  return {
    columns: table.columns,
    rows: (rows as Scalar[][]).map((values) => {
      const row: Row = {};
      for (let i = 0; i < names.length; i++) row[names[i]!] = values[i] ?? null;
      return row;
    }),
  };
}
