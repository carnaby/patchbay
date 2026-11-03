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
import { type HeavyReservation, memoryGuard } from './memory-pressure.ts';
import { currentClient } from './request-context.ts';

/** A pipeline over a table at least this large (rows x columns) is heavy; smaller ones stay well inside the heap. */
export const HEAVY_PIPELINE_CELLS = 100_000;
/** A feed document at least this large is heavy: the parser needs several times its size. */
export const HEAVY_FEED_BYTES = 512 * 1024;
/** A stored upload at least this large on disk is heavy to load: its text, its parsed values and the table at once. */
export const HEAVY_FILE_BYTES = 1024 * 1024;

/** The turn being held, marked released when it ends: work its task left behind waits for a turn of its own. */
const holding = new AsyncLocalStorage<{ released: boolean }>();
const inTurn = () => {
  const turn = holding.getStore();
  return turn !== undefined && !turn.released;
};

async function inOwnTurn<T>(task: () => Promise<T>): Promise<T> {
  const turn = { released: false };
  try {
    return await holding.run(turn, task);
  } finally {
    turn.released = true;
  }
}

/** Runs that make up one result (a dataset and what it reads, see `heavyWork.chain`). */
interface Chain {
  done: boolean;
  /** Held from the chain's first admitted turn until it ends. */
  job: HeavyReservation | undefined;
}
const chains = new AsyncLocalStorage<Chain>();

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
   * (util/memory-pressure.ts) a new job may be refused, both on arrival and when its turn comes after a wait; a job
   * inside a turn, or inside other heavy work the guard counts (a large request body), is part of work already
   * running and is never refused.
   */
  async run<T>(task: () => Promise<T>, client = currentClient()): Promise<T> {
    if (inTurn()) return task();
    const chain = chains.getStore();
    const live = chain && !chain.done ? chain : undefined;
    // A later run of an admitted chain: part of work already running. Should the chain end while this waits, the
    // reservation is released and its turn is checked like any new job's.
    if (live?.job) {
      const job = live.job;
      return job.run(() => gate.run(client, () => memoryGuard.runHeavy(() => inOwnTurn(task))));
    }
    memoryGuard.admitHeavy();
    if (!live) return gate.run(client, () => memoryGuard.runHeavy(() => inOwnTurn(task)));
    return gate.run(client, () => {
      if (live.done) return memoryGuard.runHeavy(() => inOwnTurn(task));
      // Checked at its turn exactly like any job; admitted, it is held for the chain's later runs.
      live.job ??= memoryGuard.reserveHeavy();
      return live.job.run(() => inOwnTurn(task));
    });
  },
  /**
   * Runs `work`, whose heavy runs build one result, as a chain: its first heavy run is admitted like any job, on
   * arrival and at its turn, and from then on the chain counts as one heavy job until it ends, so its later runs are
   * not refused at their turns. Those come after the first has raised memory, and refusing them threw the first
   * run's work away and turned away every reader of the result while memory stayed up. A chain whose first turn
   * comes under pressure is refused as before, so what continues past the soft line is only what was admitted below
   * it (or the one job a resting server lets through), never a queue of new chains.
   */
  async chain<T>(work: () => Promise<T>): Promise<T> {
    const chain: Chain = { done: false, job: undefined };
    try {
      return await chains.run(chain, work);
    } finally {
      chain.done = true;
      chain.job?.release();
    }
  },
  /** Running and waiting heavy jobs (diagnostics and tests). */
  stats: () => gate.stats(),
};
