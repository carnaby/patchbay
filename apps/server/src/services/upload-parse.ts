/**
 * Turns an uploaded CSV or JSON file into a table. Runs in the pipeline worker (see pipeline-pool.ts), so a large
 * or hostile file costs a worker, never the main thread.
 *
 * The limit is in cells (rows x columns), not bytes: a 5 MB file of one-digit columns is two million cells and
 * several hundred megabytes once parsed. CSV is counted while it is read and parsing stops as soon as the limit is
 * passed, so an oversized file never becomes a table.
 */
import { type DataTable, inferTable } from '@patchbay/core';
import Papa from 'papaparse';

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

const fmt = (n: number) => n.toLocaleString('en-US');

function tooLarge(rows: number, columns: number, maxCells: number, atLeast: boolean): UploadError {
  return new UploadError(
    `The file has ${atLeast ? 'more than ' : ''}${fmt(rows)} rows × ${fmt(columns)} columns; this dashboard accepts files of up to ${fmt(maxCells)} cells (rows × columns). Remove rows or columns you do not need.`,
    true,
  );
}

function check(table: DataTable, maxCells: number): DataTable {
  if (table.columns.length === 0) throw new UploadError('The file contains no columns');
  if (table.rows.length * table.columns.length > maxCells)
    throw tooLarge(table.rows.length, table.columns.length, maxCells, false);
  return table;
}

function parseCsv(content: string, maxCells: number): DataTable {
  const records: Record<string, string>[] = [];
  let columns = 0;
  let firstError: string | null = null;
  let stopped = false;
  Papa.parse<Record<string, string>>(content.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    step: (result, parser) => {
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
  if (stopped) throw tooLarge(records.length, columns, maxCells, true);
  if (records.length === 0 && firstError !== null)
    throw new UploadError(`Could not parse CSV: ${firstError}`);
  return check(inferTable(records), maxCells);
}

function parseJson(content: string, maxCells: number): DataTable {
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
  // tell the width well enough to refuse early, and the exact count below catches the rest.
  const width = inferTable(records.slice(0, 200)).columns.length;
  if (records.length * Math.max(width, 1) > maxCells) throw tooLarge(records.length, width, maxCells, false);
  return check(inferTable(records), maxCells);
}

export function parseUpload(input: UploadInput): DataTable {
  return input.format === 'json'
    ? parseJson(input.content, input.maxCells)
    : parseCsv(input.content, input.maxCells);
}
