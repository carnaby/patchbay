/**
 * Where transform pipelines run.
 *
 * Small inputs run inline: copying a table to a worker costs more than
 * processing it. Large inputs go to a pool of worker threads, so one heavy
 * dashboard cannot freeze the API for everyone else. A job that exceeds the
 * time limit has its worker terminated and replaced - the only reliable way to
 * stop a runaway computation in JavaScript.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { type DataTable, type PipelineResult, runPipeline, type Transform } from '@patchbay/core';

export interface PipelineRunner {
  run(table: DataTable, transforms: Transform[]): Promise<PipelineResult>;
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
  async close() {}
}

interface Job {
  id: number;
  table: DataTable;
  transforms: Transform[];
  resolve: (r: PipelineResult) => void;
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
  /** Inputs below this many cells (rows x columns) run inline. */
  inlineBelowCells?: number;
  /** Jobs waiting beyond this are rejected instead of piling up. */
  maxQueue?: number;
}

export const defaultPoolSize = () => Math.max(1, Math.min(4, availableParallelism() - 1));

const WORKER_URL = new URL('../workers/pipeline-worker.ts', import.meta.url);

export class WorkerPool implements PipelineRunner {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly timeoutMs: number;
  private readonly inlineBelowCells: number;
  private readonly maxQueue: number;
  private nextId = 1;
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inlineBelowCells = options.inlineBelowCells ?? 20_000;
    this.maxQueue = options.maxQueue ?? 100;
    const size = options.size ?? defaultPoolSize();
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(WORKER_URL), ready: false, job: null, timer: null };
    slot.worker.unref();
    slot.worker.on(
      'message',
      (msg: { id: number; ok: boolean; ready?: boolean; result?: PipelineResult; message?: string }) => {
        if (msg.ready) {
          slot.ready = true;
          this.drain();
          return;
        }
        const job = slot.job;
        if (!job || job.id !== msg.id) return;
        this.finish(slot);
        if (msg.ok) job.resolve(msg.result!);
        else job.reject(new PipelineError(msg.message ?? 'Processing failed'));
      },
    );
    // A crashed worker fails its job and is replaced.
    slot.worker.on('error', (err: Error) =>
      this.replace(slot, new PipelineError(`Processing crashed: ${err.message}`)),
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

  private drain() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.timer = setTimeout(
        () =>
          this.replace(
            slot,
            new PipelineError(`Processing took longer than ${this.timeoutMs / 1000} s and was stopped`),
          ),
        this.timeoutMs,
      );
      slot.worker.postMessage({ id: job.id, table: job.table, transforms: job.transforms });
    }
  }

  run(table: DataTable, transforms: Transform[]): Promise<PipelineResult> {
    if (transforms.length === 0) return Promise.resolve({ table, trace: [] });
    if (
      table.rows.length * Math.max(table.columns.length, 1) < this.inlineBelowCells ||
      this.slots.length === 0
    ) {
      try {
        return Promise.resolve(runPipeline(table, transforms));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (this.closed) return Promise.reject(new PipelineError('Server is shutting down'));
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new PipelineError('The server is busy processing data; try again shortly'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, table, transforms, resolve, reject });
      this.drain();
    });
  }

  /** Workers currently processing a job (diagnostics and tests). */
  busy(): number {
    return this.slots.filter((s) => s.job).length;
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new PipelineError('Server is shutting down'));
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }
}
