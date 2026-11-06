/**
 * How a JSON document (an http response, an uploaded JSON file) becomes records: a dot `path` to walk, then the record
 * rules. One implementation for both sources, so the same document reads the same way, with the same messages.
 */
import type { Scalar } from './table.ts';

/** Where a path was looked for, as its message names it. */
export type JsonOrigin = 'response' | 'file';

/** A `path` the document does not have; the message names the part where the walk stopped. */
export class PathNotFoundError extends Error {
  constructor(path: string, part: string, origin: JsonOrigin) {
    super(`Path "${path}" not found in the ${origin} (stopped at "${part}")`);
    this.name = 'PathNotFoundError';
  }
}

/**
 * Walks a dot path such as "data.items". Empty parts are skipped (".data..items." is "data.items") and a list is
 * walked by index ("items.0"), as http sources always did, so saved paths keep their meaning. No path is the document.
 */
export function pickPath(json: unknown, path: string | undefined, origin: JsonOrigin): unknown {
  if (!path) return json;
  let current: unknown = json;
  for (const part of path.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      throw new PathNotFoundError(path, part, origin);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';

/**
 * The rows of a column-shaped object, or null when `value` is not one. Metric and time-series APIs answer
 * { "timestamps": [1, 2], "values": [5, 6] }: row i takes element i of every list, in the object's key order. The rule
 * is strict so that an object which merely holds some lists keeps the record rules: at least two properties, every one
 * a list of scalars (number, string, boolean, null), all of one length of at least 1. A single list is left to the
 * first-list rule, which already reads it.
 *
 * `maxCells` bounds the rows built to one more than that many cells hold: the caller's cap (`inferTableCapped`) still
 * sees that rows were dropped, and a dense column-shaped body never allocates more rows than its table keeps.
 */
export function columnsToRecords(
  value: unknown,
  maxCells = Number.POSITIVE_INFINITY,
): Record<string, Scalar>[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length < 2) return null;
  const columns: unknown[][] = [];
  for (const key of keys) {
    const column = (value as Record<string, unknown>)[key];
    if (!Array.isArray(column) || column.length === 0) return null;
    if (columns.length > 0 && column.length !== columns[0]!.length) return null;
    columns.push(column);
  }
  for (const column of columns) if (!column.every(isScalar)) return null;
  const length = Math.min(columns[0]!.length, Math.floor(maxCells / keys.length) + 1);
  const rows: Record<string, Scalar>[] = [];
  // fromEntries defines every key as an own property, so a "__proto__" column stays a column.
  for (let i = 0; i < length; i++)
    rows.push(Object.fromEntries(keys.map((key, c) => [key, columns[c]![i] as Scalar])));
  return rows;
}

/**
 * The records in `target`, the document or what its path led to (`pickPath`): a list is the records, a column-shaped
 * object its rows (`columnsToRecords`), any other object its first list property when no path led there, or else itself
 * as one record. Null for a scalar, where the callers differ: a response without records is an error, while a file of
 * one value is one record.
 */
export function findRecords(
  target: unknown,
  options: { viaPath: boolean; maxCells?: number },
): unknown[] | null {
  if (Array.isArray(target)) return target;
  if (target === null || typeof target !== 'object') return null;
  const rows = columnsToRecords(target, options.maxCells);
  if (rows) return rows;
  const firstArray = Object.values(target).find(Array.isArray);
  return firstArray && !options.viaPath ? firstArray : [target];
}
