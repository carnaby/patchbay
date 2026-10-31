/**
 * One heavy job at a time, across the whole process.
 *
 * Each worker thread has its own heap limit (pipeline 96 MB, feeds 48 MB, snapshots 96 MB plus resvg's native
 * pixmaps), and an upload or a large stored table takes tens of megabytes of the main thread while it is parsed,
 * saved or loaded. Each is safe alone, but a 384 MB container cannot hold all of them at their peak next to each
 * other: with every heavy path attacked at once the process was killed within seconds. So these jobs take turns here:
 * drawing a snapshot, an upload from parse to disk, loading a large stored upload, a pipeline over a large table and
 * parsing a large feed. Small jobs never wait; they cannot fill a heap. Workers collect their garbage after a large job
 * (`collectAfterLargeJob` in util/workers.ts), so the next heavy job starts next to an emptied heap.
 *
 * A heavy job that starts another (an upload's parse, the pipeline inside a snapshot's data) runs it in its own turn,
 * so nesting never waits for itself. The budget this keeps is in guide/deployment.md ("Memory budget").
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Gate } from './gate.ts';
import { memoryGuard } from './memory-pressure.ts';
import { currentClient } from './request-context.ts';

/** A pipeline over a table at least this large (rows x columns) is heavy; smaller ones stay well inside the heap. */
export const HEAVY_PIPELINE_CELLS = 100_000;
/** A feed document at least this large is heavy: the parser needs several times its size. */
export const HEAVY_FEED_BYTES = 512 * 1024;
/** A stored upload at least this large on disk is heavy to load: its text, its parsed values and the table at once. */
export const HEAVY_FILE_BYTES = 1024 * 1024;

const holding = new AsyncLocalStorage<true>();

/**
 * FIFO, one at a time; a short queue per client so one client cannot hold everyone else's turn. Every job has a
 * time limit of its own (render 15 s, pipeline 10 s, feed 8 s, upload gate 15 s), so a wait is bounded; past
 * `maxWaitMs` the request gets 503 with Retry-After.
 */
const gate = new Gate({
  concurrency: 1,
  maxQueue: 16,
  maxQueuedPerClient: 4,
  maxWaitMs: 30_000,
  retryAfterSec: 10,
});

export const heavyWork = {
  /**
   * Runs `task` in the process's one heavy turn, or at once when the caller already holds it. Under memory pressure
   * (util/memory-pressure.ts) a new job is refused, both on arrival and when its turn comes after a wait; a job inside
   * a turn is part of work already running and is never refused.
   */
  async run<T>(task: () => Promise<T>, client = currentClient()): Promise<T> {
    if (holding.getStore()) return task();
    memoryGuard.admitHeavy();
    return gate.run(client, () => {
      memoryGuard.admitHeavy();
      return holding.run(true, task);
    });
  },
  /** Running and waiting heavy jobs (diagnostics and tests). */
  stats: () => gate.stats(),
};
