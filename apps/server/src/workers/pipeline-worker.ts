/**
 * Runs transform pipelines off the main thread. Receives { id, table, transforms }
 * and answers { id, ok, result } or { id, ok: false, message }.
 */
import { parentPort } from 'node:worker_threads';
import { type DataTable, runPipeline, type Transform } from '@patchbay/core';

interface Job {
  id: number;
  table: DataTable;
  transforms: Transform[];
}

parentPort!.on('message', (job: Job) => {
  try {
    parentPort!.postMessage({ id: job.id, ok: true, result: runPipeline(job.table, job.transforms) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});

// Signal readiness only after the imports above loaded, so job time limits
// never include worker start-up.
parentPort!.postMessage({ ready: true });
