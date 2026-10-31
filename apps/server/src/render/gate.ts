/**
 * Admission control for PNG snapshots.
 *
 * A snapshot is the most expensive thing the server does, and anyone can ask for one of a public dashboard. Few
 * snapshot requests are in flight at once (data resolution included), one client may hold only some of them, and
 * only one of them renders at a time, in the render worker (render/worker-host.ts). The rest are turned away with 503
 * straight away instead of queueing up behind each other.
 */
import { RetryLaterError } from '../util/errors.ts';
import { BusyError } from '../util/gate.ts';
import type { RateLimiter } from '../util/rate-limit.ts';
import { currentClient } from '../util/request-context.ts';
import { type RenderTask, RenderWorker } from './worker-host.ts';

export class RenderBusyError extends BusyError {
  constructor(retryAfterSec = 5) {
    super('The server is busy rendering other snapshots; try again in a few seconds', retryAfterSec);
  }
}

export class SnapshotRateError extends RetryLaterError {
  constructor(retryAfterSec: number) {
    super(429, `Too many snapshots from you; try again in ${retryAfterSec} s`, retryAfterSec);
  }
}

/**
 * Counts a snapshot that has to be drawn against the caller's budget (`limits.snapshots`), or throws
 * SnapshotRateError. Cache hits are not counted: they cost nothing. Without this one client cycling through the
 * widgets and themes of one heavy dashboard (two images per widget, each a cache miss) kept the renderer busy alone.
 */
export function chargeSnapshot(limiter: RateLimiter, client = currentClient()) {
  if (!limiter.take(client)) throw new SnapshotRateError(limiter.retryAfterSec(client));
}

/** Renders one task once every earlier one of the same gate has finished. */
export type Draw<Task = RenderTask, Out = Buffer> = (task: Task) => Promise<Out>;

export interface RenderGateOptions<Task, Out> {
  /** Snapshot requests allowed in flight (resolving data, waiting or drawing); more get RenderBusyError. */
  maxPending?: number;
  /** Of those, how many one client may hold, so a single client cannot keep everyone else out. */
  maxPendingPerClient?: number;
  render: (task: Task) => Promise<Out>;
}

export class RenderGate<Task = RenderTask, Out = Buffer> {
  private readonly maxPending: number;
  private readonly maxPendingPerClient: number;
  private readonly renderTask: (task: Task) => Promise<Out>;
  private pendingCount = 0;
  private readonly perClient = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: RenderGateOptions<Task, Out>) {
    this.maxPending = Math.max(1, options.maxPending ?? 4);
    this.maxPendingPerClient = Math.max(1, options.maxPendingPerClient ?? Math.ceil(this.maxPending / 2));
    this.renderTask = options.render;
  }

  /**
   * Admits a snapshot job or throws RenderBusyError. The job gets `draw`, which serialises the rendering itself
   * across every job of this gate.
   */
  async run<T>(job: (draw: Draw<Task, Out>) => Promise<T>): Promise<T> {
    const client = currentClient();
    const mine = this.perClient.get(client) ?? 0;
    if (this.pendingCount >= this.maxPending || mine >= this.maxPendingPerClient) throw new RenderBusyError();
    this.pendingCount++;
    this.perClient.set(client, mine + 1);
    try {
      return await job((task) => this.exclusive(task));
    } finally {
      this.pendingCount--;
      const left = (this.perClient.get(client) ?? 1) - 1;
      if (left > 0) this.perClient.set(client, left);
      else this.perClient.delete(client);
    }
  }

  /** Jobs admitted and not finished yet (tests and diagnostics). */
  pending(): number {
    return this.pendingCount;
  }

  private exclusive(task: Task): Promise<Out> {
    const turn = this.tail.then(() => this.renderTask(task));
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}

/** The worker every snapshot is drawn in. */
export const snapshotRenderer = new RenderWorker();

/**
 * The one gate every snapshot goes through, REST and MCP alike: the limits only mean something if they are
 * process-wide.
 */
export const snapshotGate = new RenderGate({ render: (task: RenderTask) => snapshotRenderer.render(task) });
