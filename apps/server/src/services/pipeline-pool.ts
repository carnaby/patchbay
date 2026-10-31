/**
 * Where transform pipelines (and the parsing of uploaded files) run.
 *
 * Small inputs with cheap steps run inline: copying a table to a worker costs
 * more than processing it. Everything else goes to a pool of worker threads, so
 * one heavy dashboard cannot freeze the API for everyone else. A job that
 * exceeds the time limit has its worker terminated and replaced - the only
 * reliable way to stop a runaway computation in JavaScript - and each worker has
 * its own heap limit, so a job that allocates without bound kills its worker,
 * not the process. The replacement starts only once the old worker has exited
 * (util/workers.ts), so a slot never holds two heaps.
 *
 * The queue is shared fairly: waiting jobs are taken round-robin per client, and
 * one client may hold only a share of it.
 */
import { availableParallelism } from 'node:os';
import { type ResourceLimits, Worker } from 'node:worker_threads';
import { type DataTable, type PipelineResult, runPipeline, type Transform } from '@patchbay/core';
import { BusyError } from '../util/gate.ts';
import { memoryGuard } from '../util/memory-pressure.ts';
import { currentClient } from '../util/request-context.ts';
import {
  checkHeapLimit,
  retire,
  type WorkerLike,
  workerBytes,
  workerResourceLimits,
} from '../util/workers.ts';
import { parseUpload, UploadError, type UploadInput } from './upload-parse.ts';

export interface PipelineRunner {
  run(table: DataTable, transforms: Transform[]): Promise<PipelineResult>;
  /** Parses an uploaded file into a table, off the main thread when workers are on. */
  parseUpload(input: UploadInput): Promise<DataTable>;
  /** Asks idle workers to collect their garbage (under memory pressure, util/memory-pressure.ts). */
  collectIdle?(): void;
  /** Replaces idle workers by fresh ones, which gives back what a collection cannot (util/memory-pressure.ts). */
  recycleIdle?(): void;
  close(): Promise<void>;
}

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** Runs on the calling thread. Used when workers are disabled (PIPELINE_WORKERS=0). */
export class InlineRunner implements PipelineRunner {
  async run(table: DataTable, transforms: Transform[]) {
    return runPipeline(table, transforms);
  }
  async parseUpload(input: UploadInput) {
    return parseUpload(input);
  }
  async close() {}
}

type Message =
  | { kind: 'pipeline'; table: DataTable; transforms: Transform[] }
  | { kind: 'upload'; input: UploadInput };

interface Job {
  id: number;
  client: string;
  message: Message;
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: WorkerLike;
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

export interface PoolOptions {
  size?: number;
  /** Hard limit per job; the worker is killed and replaced when exceeded. */
  timeoutMs?: number;
  /** Inputs below this many cells (rows x columns) with only cheap steps run inline. */
  inlineBelowCells?: number;
  /** Jobs waiting beyond this are rejected instead of piling up. */
  maxQueue?: number;
  /** Jobs one client may have waiting; by default a tenth of maxQueue. */
  maxQueuedPerClient?: number;
  /** Old-generation heap limit of each worker in MB; a job that needs more fails and its worker is replaced. */
  workerMemoryMb?: number;
  /** How long a terminated worker may take to exit before its replacement starts anyway. */
  retireGraceMs?: number;
  /** Tests only: stands in for `new Worker`. */
  createWorker?: (resourceLimits: ResourceLimits) => WorkerLike;
}

export const defaultPoolSize = () => Math.max(1, Math.min(4, availableParallelism() - 1));

/**
 * Steps whose cost is bounded by their input: they never build values larger than the ones they read. Expressions
 * (filter, derive) and windows can allocate without limit even on a tiny input, so they always go to a worker.
 */
const CHEAP_STEPS = new Set<Transform['type']>([
  'select',
  'drop',
  'rename',
  'sort',
  'limit',
  'aggregate',
  'timeBucket',
  'fillNull',
]);
const MAX_INLINE_STEPS = 4;

/** Whether a pipeline is cheap enough to run on the calling thread. */
export function runsInline(table: DataTable, transforms: Transform[], inlineBelowCells: number): boolean {
  return (
    table.rows.length * Math.max(table.columns.length, 1) < inlineBelowCells &&
    transforms.length <= MAX_INLINE_STEPS &&
    transforms.every((t) => CHEAP_STEPS.has(t.type))
  );
}

const WORKER_URL = new URL('../workers/pipeline-worker.ts', import.meta.url);

interface WorkerReply {
  id: number;
  ok: boolean;
  ready?: boolean;
  heapLimitMb?: number;
  result?: unknown;
  message?: string;
  /** The failure is an UploadError (its message is for the uploader). */
  upload?: boolean;
  tooLarge?: boolean;
}

export class WorkerPool implements PipelineRunner {
  private readonly slots: Slot[] = [];
  /** Waiting jobs per client; the Map's order is the round-robin order. */
  private readonly queues = new Map<string, Job[]>();
  private queued = 0;
  private readonly timeoutMs: number;
  private readonly inlineBelowCells: number;
  private readonly maxQueue: number;
  private readonly maxQueuedPerClient: number;
  private readonly workerMemoryMb: number;
  private readonly retireGraceMs: number;
  private readonly createWorker: (resourceLimits: ResourceLimits) => WorkerLike;
  /** Workers terminated and not yet exited; each one's replacement waits for it. */
  private readonly retiring = new Set<Promise<void>>();
  private readonly size: number;
  private nextId = 1;
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inlineBelowCells = options.inlineBelowCells ?? 20_000;
    this.maxQueue = options.maxQueue ?? 100;
    this.maxQueuedPerClient = options.maxQueuedPerClient ?? Math.max(1, Math.ceil(this.maxQueue / 10));
    this.workerMemoryMb = options.workerMemoryMb ?? 96;
    this.retireGraceMs = options.retireGraceMs ?? 30_000;
    this.createWorker =
      options.createWorker ?? ((resourceLimits) => new Worker(WORKER_URL, { resourceLimits }));
    this.size = options.size ?? defaultPoolSize();
    for (let i = 0; i < this.size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const worker = this.createWorker(workerResourceLimits(this.workerMemoryMb));
    const slot: Slot = { worker, ready: false, job: null, timer: null };
    slot.worker.unref();
    slot.worker.on('message', (msg: WorkerReply) => {
      if (msg.ready) {
        checkHeapLimit('pipeline', this.workerMemoryMb, msg.heapLimitMb);
        slot.ready = true;
        this.drain();
        return;
      }
      const job = slot.job;
      if (!job || job.id !== msg.id) return;
      this.finish(slot);
      if (msg.ok) job.resolve(msg.result);
      else if (msg.upload)
        job.reject(new UploadError(msg.message ?? 'Could not read the file', msg.tooLarge));
      else job.reject(new PipelineError(msg.message ?? 'Processing failed'));
    });
    // A crashed worker fails its job and is replaced. Running out of its heap is the usual way to crash.
    slot.worker.on('error', (err: Error & { code?: string }) =>
      this.replace(
        slot,
        new PipelineError(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'Processing needed more memory than this server allows; use less data or simpler steps'
            : `Processing crashed: ${err.message}`,
        ),
      ),
    );
    slot.worker.on('exit', (code) => {
      if (!this.closed && this.slots.includes(slot))
        this.replace(slot, new PipelineError(`Processing worker exited (${code})`));
    });
    return slot;
  }

  private finish(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    this.drain();
  }

  private replace(slot: Slot, reason: Error) {
    const job = slot.job;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    // Remove first so the 'exit' event of the terminated worker is ignored.
    this.slots.splice(index, 1);
    job?.reject(reason);
    // The replacement starts only after the old thread has exited: until then its heap is still allocated, and a
    // new job in a new worker would add a second one. Waiting jobs stay queued meanwhile.
    const exited = retire(slot.worker, this.retireGraceMs, 'pipeline');
    this.retiring.add(exited);
    void exited.then(() => {
      this.retiring.delete(exited);
      if (this.closed) return;
      this.slots.push(this.spawn());
      this.drain();
    });
  }

  /** The next job, round-robin across clients: a client with many jobs waits for its turn like everyone else. */
  private take(): Job | undefined {
    const first = this.queues.entries().next();
    if (first.done) return undefined;
    const [client, jobs] = first.value;
    const job = jobs.shift()!;
    this.queues.delete(client);
    if (jobs.length) this.queues.set(client, jobs);
    this.queued--;
    return job;
  }

  private drain() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job || this.queued === 0) continue;
      const job = this.take()!;
      slot.job = job;
      slot.timer = setTimeout(
        () =>
          this.replace(
            slot,
            new PipelineError(`Processing took longer than ${this.timeoutMs / 1000} s and was stopped`),
          ),
        this.timeoutMs,
      );
      const message = job.message;
      if (message.kind === 'upload') {
        // Encoded only now, so files waiting in the queue hold no second copy; then moved, not cloned.
        const { content, ...rest } = message.input;
        const bytes = workerBytes(content);
        slot.worker.postMessage({ id: job.id, kind: 'upload', input: { ...rest, bytes } }, [
          bytes.buffer as ArrayBuffer,
        ]);
      } else {
        slot.worker.postMessage({ id: job.id, ...message });
      }
    }
  }

  private submit<T>(message: Message): Promise<T> {
    if (this.closed) return Promise.reject(new PipelineError('Server is shutting down'));
    const client = currentClient();
    const mine = this.queues.get(client);
    if (this.queued >= this.maxQueue || (mine?.length ?? 0) >= this.maxQueuedPerClient)
      return Promise.reject(new BusyError('The server is busy processing data; try again shortly'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        client,
        message,
        resolve: resolve as (r: unknown) => void,
        reject,
      };
      if (mine) mine.push(job);
      else this.queues.set(client, [job]);
      this.queued++;
      this.drain();
    });
  }

  run(table: DataTable, transforms: Transform[]): Promise<PipelineResult> {
    if (transforms.length === 0) return Promise.resolve({ table, trace: [] });
    // The configured size, not the live slots: while a worker is being replaced there may be none, and that work
    // must wait for the replacement rather than run here.
    if (this.size === 0 || runsInline(table, transforms, this.inlineBelowCells)) {
      try {
        return Promise.resolve(runPipeline(table, transforms));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    // A large table is copied to the worker and grows its heap: no such job starts while memory is short. Small
    // tables go to a worker only for their expressions, and refusing them would break ordinary dashboards. Tables
    // over HEAVY_PIPELINE_CELLS run inside a heavy turn (services/data.ts) and pass here as part of it.
    if (table.rows.length * Math.max(table.columns.length, 1) >= this.inlineBelowCells) {
      try {
        memoryGuard.admitHeavy({ oneShot: true });
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this.submit({ kind: 'pipeline', table, transforms });
  }

  parseUpload(input: UploadInput): Promise<DataTable> {
    if (this.size === 0) {
      try {
        return Promise.resolve(parseUpload(input));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this.submit({ kind: 'upload', input });
  }

  /**
   * Idle workers collect at once. A worker collects after a large job (util/workers.ts), but below that threshold its
   * leftovers stay until V8 needs room, which under memory pressure is room the container may not have.
   */
  collectIdle() {
    for (const slot of this.slots) if (slot.ready && !slot.job) slot.worker.postMessage({ kind: 'collect' });
  }

  /**
   * Idle workers are replaced by fresh ones. A collection empties a worker's heap but keeps the isolate it grew to
   * and the native memory its thread allocated; only an exit gives those back. Used once the server has been idle
   * under memory pressure for a while (util/memory-pressure.ts), when the restart costs nobody a wait.
   */
  recycleIdle() {
    for (const slot of [...this.slots]) {
      if (slot.ready && !slot.job) this.replace(slot, new PipelineError('Worker recycled'));
    }
  }

  /** Workers currently processing a job (diagnostics and tests). */
  busy(): number {
    return this.slots.filter((s) => s.job).length;
  }

  /** Jobs waiting for a worker (diagnostics and tests). */
  waiting(): number {
    return this.queued;
  }

  /** Workers alive or still exiting (tests): never more than the pool's size. */
  threads(): number {
    return this.slots.length + this.retiring.size;
  }

  async close() {
    this.closed = true;
    for (const jobs of this.queues.values())
      for (const job of jobs) job.reject(new PipelineError('Server is shutting down'));
    this.queues.clear();
    this.queued = 0;
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.job?.reject(new PipelineError('Server is shutting down'));
      slot.job = null;
    }
    await Promise.all([...this.slots.splice(0).map((s) => s.worker.terminate()), ...this.retiring]);
  }
}
