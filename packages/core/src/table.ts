/**
 * The tabular data model every source is normalised into.
 *
 * Times are stored as epoch milliseconds (numbers) with column type `time`.
 * That keeps rows JSON-friendly, makes comparisons cheap and maps directly
 * onto ECharts' time axis.
 */

export type Scalar = number | string | boolean | null;
export type Row = Record<string, Scalar>;
export type ColumnType = 'number' | 'string' | 'boolean' | 'time';

export interface Column {
  name: string;
  type: ColumnType;
}

export interface DataTable {
  columns: Column[];
  rows: Row[];
}

export const EMPTY_TABLE: DataTable = { columns: [], rows: [] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// The fraction is one optional group: `\d+\.?\d*` can split a run of digits in n ways, and a long digit string that
// fails at its end ("1111…1x" in an upload) then takes quadratic time, seconds for 80,000 digits.
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Parses an ISO-like date string to epoch ms, or returns null. */
export function parseTime(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  // A bare date or a timestamp without an offset is treated as UTC for reproducibility.
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalised = value.replace(' ', 'T');
  const ms = Date.parse(hasZone || normalised.length === 10 ? normalised : `${normalised}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function detectType(values: unknown[]): ColumnType {
  let numbers = 0;
  let numericStrings = 0;
  let booleans = 0;
  let times = 0;
  let strings = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') numbers++;
    else if (typeof v === 'boolean') booleans++;
    else if (v instanceof Date) times++;
    else if (typeof v === 'string') {
      if (NUMERIC.test(v.trim())) numericStrings++;
      else if (parseTime(v.trim()) !== null) times++;
      else strings++;
    } else strings++;
  }
  const total = numbers + numericStrings + booleans + times + strings;
  if (total === 0) return 'string';
  if (numbers + numericStrings === total) return 'number';
  if (booleans === total) return 'boolean';
  if (times === total) return 'time';
  return 'string';
}

function coerce(value: unknown, type: ColumnType): Scalar {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return Boolean(value);
    case 'time': {
      if (typeof value === 'number') return value;
      if (value instanceof Date) return value.getTime();
      return parseTime(String(value).trim());
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** Flattens one level of nested objects into dotted keys (`a.b`). Arrays are serialised. */
function flatten(record: Record<string, unknown>, out: Record<string, unknown> = {}, prefix = '', depth = 0) {
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      depth < 2
    ) {
      flatten(value as Record<string, unknown>, out, name, depth + 1);
    } else {
      out[name] = value;
    }
  }
  return out;
}

export interface InferOptions {
  /** Explicit column types that skip detection (connectors know their schema). */
  types?: Record<string, ColumnType>;
  maxRows?: number;
}

/** Builds a typed table from arbitrary JSON-ish records. */
export function inferTable(records: unknown[], options: InferOptions = {}): DataTable {
  const limit = options.maxRows ?? Number.POSITIVE_INFINITY;
  const flat: Record<string, unknown>[] = [];
  const names = new Map<string, true>();
  for (const record of records) {
    if (flat.length >= limit) break;
    const obj =
      record && typeof record === 'object' && !Array.isArray(record)
        ? flatten(record as Record<string, unknown>)
        : { value: record };
    for (const key of Object.keys(obj)) names.set(key, true);
    flat.push(obj);
  }
  const columns: Column[] = [...names.keys()].map((name) => ({
    name,
    type: options.types?.[name] ?? detectType(flat.slice(0, 500).map((r) => r[name])),
  }));
  const rows = flat.map((r) => {
    const row: Row = {};
    for (const col of columns) row[col.name] = coerce(r[col.name], col.type);
    return row;
  });
  return { columns, rows };
}

/** Re-derives column types after a transform produced new values. */
export function retype(rows: Row[], order?: string[], known: Record<string, ColumnType> = {}): DataTable {
  const names = order ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns: Column[] = names.map((name) => {
    const hint = known[name];
    // Time columns are plain numbers at runtime, so a known `time` hint survives retyping.
    if (hint === 'time' && rows.every((r) => r[name] === null || typeof r[name] === 'number')) {
      return { name, type: 'time' };
    }
    let type: ColumnType | null = null;
    for (const row of rows) {
      const v = row[name];
      if (v === null || v === undefined) continue;
      const t: ColumnType = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
      if (type === null) type = t;
      else if (type !== t) {
        type = 'string';
        break;
      }
    }
    return { name, type: type ?? hint ?? 'string' };
  });
  return { columns, rows };
}

export function columnType(table: DataTable, name: string): ColumnType | undefined {
  return table.columns.find((c) => c.name === name)?.type;
}

/**
 * A stable content hash (FNV-1a) used to skip pushing unchanged data to clients. It runs over the values one by one:
 * the table as one JSON string repeats every column name in every row, and with long names that string alone was
 * larger than the server's heap.
 */
export function hashTable(table: DataTable): string {
  let h = 0x811c9dc5;
  // A tag before each value keeps 1, "1", true and "true" apart, and so does the end mark ["ab", "c"] and ["a", "bc"].
  const add = (tag: number, text: string) => {
    h ^= tag;
    h = Math.imul(h, 0x01000193);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  };
  for (const c of table.columns) {
    add(0x63, c.name);
    add(0x74, c.type);
  }
  add(0x72, String(table.rows.length));
  for (const row of table.rows) {
    for (const c of table.columns) {
      const v = row[c.name];
      if (typeof v === 'string') add(0x73, v);
      else if (v === undefined || v === null) add(0x7a, '');
      else add(typeof v === 'number' ? 0x6e : 0x62, String(v));
    }
  }
  return (h >>> 0).toString(36);
}
