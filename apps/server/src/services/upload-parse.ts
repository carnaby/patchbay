/**
 * Turns an uploaded CSV or JSON file into a table. Runs in the pipeline worker (see pipeline-pool.ts), so a large
 * or hostile file costs a worker, never the main thread.
 *
 * The limit is in cells (rows x columns), not bytes: a 5 MB file of one-digit columns is two million cells and
 * several hundred megabytes once parsed. CSV is counted while it is read and parsing stops as soon as the limit is
 * passed, so an oversized file never becomes a table. JSON is measured before it is parsed (`jsonUploadProblem`);
 * the server does that on the main thread already, so a hostile document never reaches a worker.
 *
 * Column names and the number of columns are bounded too: every row of a data response repeats the names, so a
 * small file with very long names becomes a very large response.
 */
import { type DataTable, inferTable, LIMITS } from '@patchbay/core';
import Papa from 'papaparse';
import { jsonShapeProblem, MAX_JSON_DEPTH } from '../util/json-shape.ts';

export interface UploadInput {
  content: string;
  format: 'csv' | 'json';
  maxCells: number;
}

/** A refusal whose message is meant for the uploader. */
export class UploadError extends Error {
  readonly tooLarge: boolean;
  constructor(message: string, tooLarge = false) {
    super(message);
    this.name = 'UploadError';
    this.tooLarge = tooLarge;
  }
}

/** Columns of one upload: far more than a chart or a table can show. */
export const UPLOAD_MAX_COLUMNS = 500;
/** Characters of a column name, the same as for inline rows. */
export const UPLOAD_MAX_COLUMN_NAME = LIMITS.inlineColumnName;

/**
 * JSON values an upload may hold, given its cell limit. A record costs one value per cell plus one for itself, and a
 * cell holding a small array a few more; three per cell leaves room for that while keeping the parsed document well
 * within the worker's heap.
 */
export const maxUploadValues = (maxCells: number) => maxCells * 3;

const fmt = (n: number) => n.toLocaleString('en-US');

function tooLarge(rows: number, columns: number, maxCells: number, atLeast: boolean): UploadError {
  return new UploadError(
    `The file has ${atLeast ? 'more than ' : ''}${fmt(rows)} rows × ${fmt(columns)} columns; this dashboard accepts files of up to ${fmt(maxCells)} cells (rows × columns). Remove rows or columns you do not need.`,
    true,
  );
}

/** Why these column names cannot be stored, or null. */
function columnsProblem(names: readonly string[]): UploadError | null {
  if (names.length > UPLOAD_MAX_COLUMNS)
    return new UploadError(
      `The file has ${fmt(names.length)} columns; uploads are limited to ${fmt(UPLOAD_MAX_COLUMNS)}. Remove columns you do not need.`,
    );
  const long = names.find((name) => name.length > UPLOAD_MAX_COLUMN_NAME);
  if (long !== undefined)
    return new UploadError(
      `Column names are limited to ${UPLOAD_MAX_COLUMN_NAME} characters ("${long.slice(0, 40)}…" has ${fmt(long.length)}). Shorten the column names.`,
    );
  return null;
}

/**
 * Why a JSON upload must not be parsed at all, or null. Linear and without allocation, so the server runs it on the
 * main thread before queueing the file for a worker; the worker repeats it for callers that skip that step.
 */
export function jsonUploadProblem(content: string, maxCells: number): UploadError | null {
  const problem = jsonShapeProblem(content, {
    maxDepth: MAX_JSON_DEPTH,
    maxValues: maxUploadValues(maxCells),
  });
  if (!problem) return null;
  return problem.kind === 'depth'
    ? new UploadError(
        `The JSON nests deeper than ${problem.limit} levels. Uploads are tables: an array of records, each holding values or small nested objects.`,
      )
    : new UploadError(
        `The JSON holds more than ${fmt(problem.limit)} values; this dashboard accepts files of up to ${fmt(maxCells)} cells (rows × columns). Remove rows or fields you do not need.`,
        true,
      );
}

function check(table: DataTable, maxCells: number): DataTable {
  if (table.columns.length === 0) throw new UploadError('The file contains no columns');
  const columns = columnsProblem(table.columns.map((c) => c.name));
  if (columns) throw columns;
  if (table.rows.length * table.columns.length > maxCells)
    throw tooLarge(table.rows.length, table.columns.length, maxCells, false);
  return table;
}

function parseCsv(content: string, maxCells: number): DataTable {
  const records: Record<string, string>[] = [];
  let columns = 0;
  let firstError: string | null = null;
  let stopped = false;
  let refused: UploadError | null = null;
  Papa.parse<Record<string, string>>(content.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    step: (result, parser) => {
      // The header decides the columns, so a bad one is refused before any row is kept.
      if (records.length === 0) {
        refused = columnsProblem(result.meta.fields ?? []);
        if (refused) {
          parser.abort();
          return;
        }
      }
      if (result.errors.length && firstError === null) firstError = result.errors[0]!.message;
      columns = Math.max(columns, result.meta.fields?.length ?? 0, Object.keys(result.data).length);
      if ((records.length + 1) * Math.max(columns, 1) > maxCells) {
        stopped = true;
        parser.abort();
        return;
      }
      records.push(result.data);
    },
  });
  if (refused) throw refused;
  if (stopped) throw tooLarge(records.length, columns, maxCells, true);
  if (records.length === 0 && firstError !== null)
    throw new UploadError(`Could not parse CSV: ${firstError}`);
  return check(inferTable(records), maxCells);
}

function parseJson(content: string, maxCells: number): DataTable {
  const problem = jsonUploadProblem(content, maxCells);
  if (problem) throw problem;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new UploadError('The file is not valid JSON');
  }
  const records = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? (Object.values(json).find(Array.isArray) ?? [json])
      : [json];
  // Flattening every record first would build the oversized table this check exists to avoid; the first records
  // tell the width (and the names) well enough to refuse early, and the exact checks below catch the rest.
  const head = inferTable(records.slice(0, 200)).columns;
  const columns = columnsProblem(head.map((c) => c.name));
  if (columns) throw columns;
  if (records.length * Math.max(head.length, 1) > maxCells)
    throw tooLarge(records.length, head.length, maxCells, false);
  return check(inferTable(records), maxCells);
}

export function parseUpload(input: UploadInput): DataTable {
  return input.format === 'json'
    ? parseJson(input.content, input.maxCells)
    : parseCsv(input.content, input.maxCells);
}
