/**
 * Parses feed documents off the main thread (see `FeedParser`). Receives { id, body, contentType, base } and
 * answers { id, ok: true, feed } or { id, ok: false, status, message }.
 */
import { parentPort } from 'node:worker_threads';
import { HttpError } from '../util/errors.ts';
import { parseFeed } from './parse.ts';

interface Job {
  id: number;
  body: string;
  contentType: string;
  base: string;
}

parentPort!.on('message', (job: Job) => {
  try {
    parentPort!.postMessage({ id: job.id, ok: true, feed: parseFeed(job.body, job.contentType, job.base) });
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

// Signal readiness only after the imports above loaded, so job time limits never include worker start-up.
parentPort!.postMessage({ ready: true });
