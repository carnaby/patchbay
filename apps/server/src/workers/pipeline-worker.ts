/**
 * Runs transform pipelines and parses uploaded files off the main thread. Receives
 * { id, kind: 'pipeline', table, transforms } or { id, kind: 'upload', input } (the file as transferred UTF-8
 * bytes, see util/workers.ts) and answers { id, ok, result } or { id, ok: false, message }. { kind: 'collect' } asks
 * an idle worker to collect its garbage and gets no answer.
 */
import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import { type DataTable, runPipeline, type Transform } from '@patchbay/core';
import { parseUpload, UploadError, type UploadInput } from '../services/upload-parse.ts';
import { collectAfterLargeJob, collectNow, textFromWorkerBytes } from '../util/workers.ts';

type Job =
  | { id: number; kind: 'pipeline'; table: DataTable; transforms: Transform[] }
  | { id: number; kind: 'upload'; input: Omit<UploadInput, 'content'> & { bytes: Uint8Array } };

function run(job: Job) {
  if (job.kind === 'pipeline') return runPipeline(job.table, job.transforms);
  const { bytes, ...rest } = job.input;
  return parseUpload({ ...rest, content: textFromWorkerBytes(bytes) });
}

parentPort!.on('message', (job: Job | { kind: 'collect' }) => {
  // Asked by the pool while this worker is idle and memory is short; there is nothing to answer.
  if (job.kind === 'collect') {
    collectNow();
    return;
  }
  try {
    parentPort!.postMessage({ id: job.id, ok: true, result: run(job) });
  } catch (e) {
    parentPort!.postMessage({
      id: job.id,
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      ...(e instanceof UploadError ? { upload: true, tooLarge: e.tooLarge } : {}),
    });
  }
  // Once this handler has returned: until then the job and its result are still referenced and would survive.
  setImmediate(() => collectAfterLargeJob(getHeapStatistics().used_heap_size));
});

// Signal readiness only after the imports above loaded, so job time limits
// never include worker start-up. The heap limit lets the pool notice when it was overridden.
parentPort!.postMessage({ ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024) });
