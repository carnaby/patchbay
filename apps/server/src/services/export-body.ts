/**
 * The .patchbay.json file of GET /api/dashboards/:id/export (packages/core/src/export.ts), built while it is sent.
 *
 * Anyone may export a public dashboard, so a crowd of slow readers must not each hold a copy of something large. The
 * document is the store's shared serialisation, counted once in the response budget however many exports read it.
 * Uploaded tables are written a part at a time: each part is built only when the socket has taken the previous one
 * and is held within the response budget until it has been read (streamBodies in result-wire.ts). Between parts the
 * export holds nothing but its position and which stored file it reads; the table itself is the data cache's, loaded
 * again when it was dropped.
 */
import { EXPORT_FORMAT, EXPORT_VERSION, exportedFile, exportedRow } from '@patchbay/core';
import type { ExportPlan } from './dashboards.ts';
import type { DataService } from './data.ts';
import type { Body, ResultWire } from './result-wire.ts';

/**
 * Text of one table part. Small next to the response budget's share per client (RESPONSE_BUDGET), so several exports
 * and data reads fit beside each other; large enough that a table of a few megabytes takes few loads of its rows.
 */
export const EXPORT_PART_BYTES = 1024 * 1024;

export interface ExportBodyDeps {
  data: Pick<DataService, 'uploadTable'>;
  wire: Pick<ResultWire, 'held'>;
  /** The store's serialisation of a document, shared by every response that sends it. */
  serializedDoc: (doc: ExportPlan['doc']) => Uint8Array;
}

/**
 * The first body (the envelope up to its files, within the budget: throws a BusyError when it cannot be held now) and
 * the function that builds the bodies after it, null at the end.
 */
export async function exportBodies(
  deps: ExportBodyDeps,
  plan: ExportPlan,
): Promise<{ first: Body; next: () => Promise<Body | null> }> {
  const meta = JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    secretsRemovedFrom: plan.secretsRemovedFrom,
  });
  const doc = deps.serializedDoc(plan.doc);
  const first = await deps.wire.held(
    [Buffer.from(`${meta.slice(0, -1)},"doc":`), doc, Buffer.from(',"files":[')],
    doc,
  );
  let file = 0;
  let row = 0;
  /** The stored file the current table's first part came from. */
  let reading = '';
  let ended = false;
  const next = async (): Promise<Body | null> => {
    const current = plan.files[file];
    if (!current) {
      if (ended) return null;
      ended = true;
      return deps.wire.held([Buffer.from(']}')]);
    }
    const { table, stamp } = await deps.data.uploadTable(plan.target, current.id);
    // A file deleted and supplied again under the same id between two parts is another table: going on would put
    // its rows under the first one's columns. The stream fails instead (logged by the route), so the client gets a
    // broken download rather than a file that reads as valid.
    if (row > 0 && stamp !== reading)
      throw new Error(`Uploaded file "${current.id}" changed while it was being exported`);
    reading = stamp;
    const parts: string[] = [];
    let size = 0;
    if (row === 0) {
      // The file without its rows ends in `"data":[]}`; its rows go between the brackets.
      const head = JSON.stringify(exportedFile(current, { columns: table.columns, rows: [] }));
      parts.push(`${file > 0 ? ',' : ''}${head.slice(0, -2)}`);
    }
    while (row < table.rows.length && size < EXPORT_PART_BYTES) {
      const text = JSON.stringify(exportedRow(table.columns, table.rows[row]!));
      parts.push(row > 0 ? `,${text}` : text);
      size += text.length + 1;
      row++;
    }
    if (row >= table.rows.length) {
      parts.push(']}');
      file++;
      row = 0;
    }
    return deps.wire.held([Buffer.from(parts.join(''))]);
  };
  return { first, next };
}
