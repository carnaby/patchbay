/**
 * Where transform pipelines (and the parsing of uploaded files) run.
 *
 * Small inputs with cheap steps run inline: copying a table to a worker costs
 * more than processing it. Everything else goes to a pool of worker threads, so
 * one heavy dashboard cannot freeze the API for everyone else. A job that
 * exceeds the time limit has its worker terminated and replaced - the only
 * reliable way to stop a runaway computation in JavaScript - and each worker has
 * its own heap limit, so a job that allocates without bound kills its worker,
 * not the process.
 *
 * The queue is shared fairly: waiting jobs are taken round-robin per client, and
 * one client may hold only a share of it.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { type DataTable, type PipelineResult, runPipeline, type Transform } from '@patchbay/core';
import { BusyError } from '../util/gate.ts';
import { currentClient } from '../util/request-context.ts';
import { parseUpload, UploadError, type UploadInput } from './upload-parse.ts';

export interface PipelineRunner {
  run(table: DataTable, transforms: Transform[]): Promise<PipelineResult>;
  /** Parses an uploaded file into a table, off the main thread when workers are on. */
  parseUpload(input: UploadInput): Promise<DataTable>;
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
  worker: Worker;
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
  private nextId = 1;
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inlineBelowCells = options.inlineBelowCells ?? 20_000;
    this.maxQueue = options.maxQueue ?? 100;
    this.maxQueuedPerClient = options.maxQueuedPerClient ?? Math.max(1, Math.ceil(this.maxQueue / 10));
    this.workerMemoryMb = options.workerMemoryMb ?? 96;
    const size = options.size ?? defaultPoolSize();
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: this.workerMemoryMb },
    });
    const slot: Slot = { worker, ready: false, job: null, timer: null };
    slot.worker.unref();
    slot.worker.on('message', (msg: WorkerReply) => {
      if (msg.ready) {
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
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    // Remove first so the 'exit' event of the terminated worker is ignored.
    this.slots.splice(index, 1);
    void slot.worker.terminate();
    job?.reject(reason);
    if (!this.closed) this.slots.push(this.spawn());
    this.drain();
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
      slot.worker.postMessage({ id: job.id, ...job.message });
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
    if (this.slots.length === 0 || runsInline(table, transforms, this.inlineBelowCells)) {
      try {
        return Promise.resolve(runPipeline(table, transforms));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this.submit({ kind: 'pipeline', table, transforms });
  }

  parseUpload(input: UploadInput): Promise<DataTable> {
    if (this.slots.length === 0) {
      try {
        return Promise.resolve(parseUpload(input));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this.submit({ kind: 'upload', input });
  }

  /** Workers currently processing a job (diagnostics and tests). */
  busy(): number {
    return this.slots.filter((s) => s.job).length;
  }

  /** Jobs waiting for a worker (diagnostics and tests). */
  waiting(): number {
    return this.queued;
  }

  async close() {
    this.closed = true;
    for (const jobs of this.queues.values())
      for (const job of jobs) job.reject(new PipelineError('Server is shutting down'));
    this.queues.clear();
    this.queued = 0;
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }
}
