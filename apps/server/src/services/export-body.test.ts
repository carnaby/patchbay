/** The parts of an export body: one table read across parts. */

import type { DataTable } from '@patchbay/core';
import { readExport } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import type { ExportPlan } from './dashboards.ts';
import { EXPORT_PART_BYTES, type ExportBodyDeps, exportBodies } from './export-body.ts';
import type { Body } from './result-wire.ts';

const held = async (chunks: Uint8Array[]): Promise<Body> => ({
  chunks,
  bytes: chunks.reduce((sum, c) => sum + c.byteLength, 0),
  release: () => {},
});

const plan = (fileId = 'f_1'): ExportPlan => ({
  target: { id: 'd1', ownerId: null },
  doc: {
    schemaVersion: 1,
    title: 'T',
    datasets: [{ id: 'up', name: 'Up', source: { kind: 'upload', fileId } }],
  } as never,
  files: [
    { id: fileId, name: 'a.csv', rows: 0, columns: 1, size: 0, uploadedAt: '2026-11-03T00:00:00.000Z' },
  ],
  secretsRemovedFrom: [],
});

const tableOf = (texts: string[]): DataTable => ({
  columns: [{ name: 'text', type: 'string' }] as DataTable['columns'],
  rows: texts.map((text) => ({ text })),
});

/** Every body of an export, as the bytes the client receives. */
async function drain(deps: ExportBodyDeps, p: ExportPlan) {
  const { first, next } = await exportBodies(deps, p);
  const bodies: Buffer[] = [Buffer.concat(first.chunks)];
  for (let body = await next(); body; body = await next()) bodies.push(Buffer.concat(body.chunks));
  return bodies;
}

const serializedDoc = (doc: unknown) => Buffer.from(JSON.stringify(doc));

describe('exportBodies', () => {
  it('fails when the file it is reading is replaced between parts, instead of mixing two tables', async () => {
    // Enough rows for three parts, so the table is loaded again after the first.
    const row = 'x'.repeat(1000);
    const rows = Array.from({ length: Math.ceil((EXPORT_PART_BYTES * 2.5) / row.length) }, () => row);
    let loads = 0;
    const deps: ExportBodyDeps = {
      wire: { held },
      serializedDoc,
      data: {
        uploadTable: async () => {
          loads++;
          // The second load finds another file under the same id: deleted and supplied again.
          return loads === 1
            ? { table: tableOf(rows), stamp: 'upload:1:1@1:10' }
            : { table: tableOf(['other']), stamp: 'upload:1:2@2:20' };
        },
      },
    };
    const { next } = await exportBodies(deps, plan());
    expect(await next()).not.toBeNull();
    await expect(next()).rejects.toThrow('Uploaded file "f_1" changed while it was being exported');
  });

  it('reads one unchanged file across parts into one table', async () => {
    const row = 'y'.repeat(1000);
    const rows = Array.from({ length: Math.ceil((EXPORT_PART_BYTES * 2.5) / row.length) }, () => row);
    const deps: ExportBodyDeps = {
      wire: { held },
      serializedDoc,
      data: { uploadTable: async () => ({ table: tableOf(rows), stamp: 'upload:1:1@1:10' }) },
    };
    const bodies = await drain(deps, plan());
    expect(bodies.length).toBeGreaterThan(3);
    const exp = readExport(JSON.parse(Buffer.concat(bodies).toString('utf8')));
    expect(exp.files[0]!.data).toHaveLength(rows.length);
  });
});
