/**
 * Parses feed documents off the main thread (see `FeedParser`). Receives { id, bytes, contentType, base }, the
 * document as transferred UTF-8 bytes (util/workers.ts), and answers { id, ok: true, feed } or
 * { id, ok: false, status, message }.
 */
import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import { HttpError } from '../util/errors.ts';
import { textFromWorkerBytes } from '../util/workers.ts';
import { parseFeed } from './parse.ts';

interface Job {
  id: number;
  bytes: Uint8Array;
  contentType: string;
  base: string;
}

parentPort!.on('message', (job: Job) => {
  try {
    const feed = parseFeed(textFromWorkerBytes(job.bytes), job.contentType, job.base);
    parentPort!.postMessage({ id: job.id, ok: true, feed });
  } catch (e) {
    // Only parse errors carry a message meant for users; anything else is a bug and says so generically.
    const known = e instanceof HttpError;
    parentPort!.postMessage({
      id: job.id,
      ok: false,
      status: known ? e.status : 502,
      message: known ? e.message : 'The feed could not be read',
    });
  }
});

// Signal readiness only after the imports above loaded, so job time limits never include worker start-up. The heap
// limit lets the parser notice when it was overridden.
parentPort!.postMessage({ ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024) });
