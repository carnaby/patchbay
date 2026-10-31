/**
 * Runs transform pipelines and parses uploaded files off the main thread. Receives
 * { id, kind: 'pipeline', table, transforms } or { id, kind: 'upload', input } and
 * answers { id, ok, result } or { id, ok: false, message }.
 */
import { parentPort } from 'node:worker_threads';
import { type DataTable, runPipeline, type Transform } from '@patchbay/core';
import { parseUpload, UploadError, type UploadInput } from '../services/upload-parse.ts';

type Job =
  | { id: number; kind: 'pipeline'; table: DataTable; transforms: Transform[] }
  | { id: number; kind: 'upload'; input: UploadInput };

parentPort!.on('message', (job: Job) => {
  try {
    const result = job.kind === 'upload' ? parseUpload(job.input) : runPipeline(job.table, job.transforms);
    parentPort!.postMessage({ id: job.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({
      id: job.id,
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      ...(e instanceof UploadError ? { upload: true, tooLarge: e.tooLarge } : {}),
    });
  }
});

// Signal readiness only after the imports above loaded, so job time limits
// never include worker start-up.
parentPort!.postMessage({ ready: true });
