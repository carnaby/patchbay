/**
 * Where feed documents are parsed: on one worker thread with a time and a memory limit.
 *
 * A feed is a document of up to 5 MB from any address a user types. Parsing is linear, but a 5 MB flood of tiny
 * elements still takes most of a second and a few hundred megabytes of heap inside the XML parser: on the main
 * thread that would stall every request, and on a small instance it would take the whole server down. The worker
 * is killed when it exceeds either limit (the only reliable way to stop a runaway computation in JavaScript) and a
 * new one starts with the next feed, once the old one has exited (util/workers.ts): two heaps at their limit at the
 * same time are what a small container cannot hold. It is not the pipeline pool on purpose: a slow feed must not
 * delay dashboards' pipelines, nor a heavy pipeline the feeds. It starts on first use and stops when idle, so an
 * instance that reads no feeds pays nothing for it.
 */
import { type ResourceLimits, Worker } from 'node:worker_threads';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '../util/errors.ts';
import {
  checkHeapLimit,
  retire,
  type WorkerLike,
  workerBytes,
  workerResourceLimits,
} from '../util/workers.ts';
import type { ParsedFeed } from './parse.ts';

export type ParseFn = (body: string, contentType: string, base: string) => Promise<ParsedFeed>;

/**
 * The feed worker's old-generation heap, part of the memory budget in guide/deployment.md. A 5 MB podcast feed with
 * long show notes needs about 32 MB, a feed of 15,000 tiny items (2.7 MB) about this much; larger floods of tiny
 * elements are refused as too large.
 */
export const FEED_WORKER_MEMORY_MB = 48;

export interface FeedParserOptions {
  /** Hard limit per document; the worker is terminated when exceeded. */
  timeoutMs?: number;
  /** The worker's heap limit; a document that needs more ends that worker, not the server. */
  maxHeapMb?: number;
  /** The worker stops after this long without work. */
  idleMs?: number;
  /** Documents waiting beyond this are refused instead of piling up. */
  maxQueue?: number;
  /** How long a terminated worker may take to exit before the next one starts anyway. */
  retireGraceMs?: number;
  /** Tests only: stands in for `new Worker`. */
  createWorker?: (resourceLimits: ResourceLimits) => WorkerLike;
}

interface Job {
  id: number;
  body: string;
  contentType: string;
  base: string;
  resolve: (feed: ParsedFeed) => void;
  reject: (e: Error) => void;
}

type Reply =
  | { ready: true; heapLimitMb?: number }
  | { id: number; ok: true; feed: ParsedFeed }
  | { id: number; ok: false; status: ContentfulStatusCode; message: string };

const WORKER_URL = new URL('./parse-worker.ts', import.meta.url);

export class FeedParser {
  private readonly timeoutMs: number;
  private readonly maxHeapMb: number;
  private readonly idleMs: number;
  private readonly maxQueue: number;
  private readonly retireGraceMs: number;
  private readonly createWorker: (resourceLimits: ResourceLimits) => WorkerLike;
  private readonly queue: Job[] = [];
  private worker: WorkerLike | null = null;
  /** A terminated worker that has not exited yet; no new one starts before it has. */
  private retiring: Promise<void> | null = null;
  private ready = false;
  private job: Job | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private nextId = 1;
  private closed = false;

  constructor(options: FeedParserOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxHeapMb = options.maxHeapMb ?? FEED_WORKER_MEMORY_MB;
    this.idleMs = options.idleMs ?? 60_000;
    this.maxQueue = options.maxQueue ?? 32;
    this.retireGraceMs = options.retireGraceMs ?? 30_000;
    this.createWorker =
      options.createWorker ?? ((resourceLimits) => new Worker(WORKER_URL, { resourceLimits }));
  }

  parse: ParseFn = (body, contentType, base) => {
    if (this.closed) return Promise.reject(new HttpError(503, 'Server is shutting down'));
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new HttpError(503, 'The server is busy reading feeds; try again shortly'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, body, contentType, base, resolve, reject });
      this.drain();
    });
  };

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new HttpError(503, 'Server is shutting down'));
    this.stop(new HttpError(503, 'Server is shutting down'));
    await this.retiring;
  }

  private drain() {
    if (this.job || this.queue.length === 0 || this.closed || this.retiring) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.worker) this.spawn();
    if (!this.ready) return;
    const job = this.queue.shift()!;
    this.job = job;
    this.timer = setTimeout(
      () => this.stop(new HttpError(502, 'The feed took too long to read and was stopped')),
      this.timeoutMs,
    );
    // Moved as bytes rather than cloned as a string (see workerBytes); the job keeps no copy of its own.
    const bytes = workerBytes(job.body);
    job.body = '';
    this.worker!.postMessage({ id: job.id, bytes, contentType: job.contentType, base: job.base }, [
      bytes.buffer as ArrayBuffer,
    ]);
  }

  private spawn() {
    const worker = this.createWorker(workerResourceLimits(this.maxHeapMb));
    worker.unref();
    this.worker = worker;
    this.ready = false;
    worker.on('message', (msg: Reply) => {
      if (this.worker !== worker) return;
      if ('ready' in msg) {
        checkHeapLimit('feeds', this.maxHeapMb, msg.heapLimitMb);
        this.ready = true;
        this.drain();
        return;
      }
      const job = this.job;
      if (!job || job.id !== msg.id) return;
      this.settle();
      if (msg.ok) job.resolve(msg.feed);
      else job.reject(new HttpError(msg.status, msg.message));
      this.drain();
      this.scheduleIdle();
    });
    worker.on('error', (err: Error & { code?: string }) => {
      if (this.worker !== worker) return;
      this.stop(
        new HttpError(
          502,
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'The feed is too large to read'
            : 'The feed could not be read',
        ),
      );
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.stop(new HttpError(502, 'The feed could not be read'));
    });
  }

  private settle() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.job = null;
  }

  /** Ends the current worker, failing its document; the next document starts a fresh one once this one exited. */
  private stop(reason: Error) {
    const job = this.job;
    this.settle();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const worker = this.worker;
    const started = this.ready;
    // Cleared first so the terminated worker's own 'exit' event is ignored.
    this.worker = null;
    this.ready = false;
    job?.reject(reason);
    // A worker that dies before it is ready would die again: fail what waits instead of respawning in a loop.
    if (worker && !started) for (const waiting of this.queue.splice(0)) waiting.reject(reason);
    if (!worker) return;
    const exited = retire(worker, this.retireGraceMs, 'feeds');
    this.retiring = exited;
    void exited.then(() => {
      if (this.retiring === exited) this.retiring = null;
      this.drain();
    });
  }

  private scheduleIdle() {
    if (this.job || this.queue.length || !this.worker) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.job && this.queue.length === 0) this.stop(new HttpError(503, 'Idle'));
    }, this.idleMs);
    this.idle.unref();
  }

  /** Whether a worker thread is running (tests). */
  running(): boolean {
    return this.worker !== null;
  }

  /** Whether a worker is alive or still exiting (tests). */
  threads(): number {
    return (this.worker ? 1 : 0) + (this.retiring ? 1 : 0);
  }
}
