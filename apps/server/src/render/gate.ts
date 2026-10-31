/**
 * Admission control for PNG snapshots.
 *
 * A snapshot is the most memory-hungry thing the server does, and anyone can ask for one of a public dashboard. Two
 * properties keep that safe on a small box:
 *
 * - Few snapshot requests are in flight at once (data resolution included), and only one of them rasterises at a
 *   time. The rest are turned away with 503 straight away instead of queueing up behind each other.
 * - resvg keeps its pixmaps in native memory that is released only when V8 collects the small JavaScript wrappers.
 *   V8 does not see that memory, so it felt no pressure to collect: 40 renders in a row held on to 900 MB. After
 *   each render the gate forces a collection and lets the finalisers run before the next render may start.
 */
import { HttpError } from '../util/errors.ts';
import { releaseNativeMemory } from './gc.ts';

export class RenderBusyError extends HttpError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec = 5) {
    super(503, 'The server is busy rendering other snapshots; try again in a few seconds');
    this.retryAfterSec = retryAfterSec;
  }
}

/** Runs one draw at a time; resolves with its result once native memory from it has been released. */
export type Draw = <R>(draw: () => R) => Promise<R>;

export interface RenderGateOptions {
  /** Snapshot requests allowed in flight (resolving data, waiting or drawing); more get RenderBusyError. */
  maxPending?: number;
}

export class RenderGate {
  private readonly maxPending: number;
  private pendingCount = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: RenderGateOptions = {}) {
    this.maxPending = Math.max(1, options.maxPending ?? 4);
  }

  /**
   * Admits a snapshot job or throws RenderBusyError. The job gets `draw`, which serialises the rasterisation itself
   * across every job of this gate.
   */
  async run<T>(job: (draw: Draw) => Promise<T>): Promise<T> {
    if (this.pendingCount >= this.maxPending) throw new RenderBusyError();
    this.pendingCount++;
    try {
      return await job((draw) => this.exclusive(draw));
    } finally {
      this.pendingCount--;
    }
  }

  /** Jobs admitted and not finished yet (tests and diagnostics). */
  pending(): number {
    return this.pendingCount;
  }

  private exclusive<R>(draw: () => R): Promise<R> {
    const turn = this.tail.then(async () => {
      try {
        return draw();
      } finally {
        await releaseNativeMemory();
      }
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}

/**
 * The one gate every snapshot goes through, REST and MCP alike: the limits only mean something if they are
 * process-wide.
 */
export const snapshotGate = new RenderGate();
