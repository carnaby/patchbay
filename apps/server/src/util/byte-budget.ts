/**
 * Admission by bytes held, for response bodies on their way out. A body stays in memory until the client has read
 * it, so a burst of large responses holds their sum at once; this keeps that sum under a budget. Responses that send
 * the same bytes (one serialised result read by many viewers) name the same key and are counted once: the memory is
 * shared, so the hundredth viewer of a popular dashboard costs nothing more than the first.
 */
import { BusyError } from './gate.ts';

export interface ByteBudgetOptions {
  /** Bytes of distinct bodies held at the same time. */
  maxBytes: number;
  /** Bytes one client may bring in; bodies others already hold do not count again. */
  maxBytesPerClient: number;
  /** Requests waiting beyond this are refused at once. */
  maxQueue: number;
  maxQueuedPerClient: number;
  /** A request that waited this long is refused: the budget is held by slow readers, and the client may retry. */
  maxWaitMs: number;
  retryAfterSec: number;
}

interface Holder {
  bytes: number;
  refs: number;
  owner: string;
}

interface Waiter {
  client: string;
  key: string;
  bytes: number;
  grant: () => void;
  timer: NodeJS.Timeout;
}

export class ByteBudget {
  private readonly options: ByteBudgetOptions;
  private readonly holders = new Map<string, Holder>();
  private readonly owned = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  private readonly queued = new Map<string, number>();
  private total = 0;

  constructor(options: ByteBudgetOptions) {
    this.options = options;
  }

  /** Diagnostics and tests. */
  stats() {
    return { bytes: this.total, bodies: this.holders.size, waiting: this.waiting.length };
  }

  /**
   * Waits until `bytes` more fit (or `key` is already held, which costs nothing) and returns the function that gives
   * them back; it may be called more than once. Throws a BusyError when the queue is full or the wait too long.
   */
  acquire(client: string, key: string, bytes: number): Promise<() => void> {
    if (this.holders.has(key) || (this.fits(client, bytes) && !this.waitingForTotal())) {
      return Promise.resolve(this.take(client, key, bytes));
    }
    const queued = this.queued.get(client) ?? 0;
    if (this.waiting.length >= this.options.maxQueue || queued >= this.options.maxQueuedPerClient) {
      return Promise.reject(new BusyError(undefined, this.options.retryAfterSec));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        client,
        key,
        bytes,
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(this.take(client, key, bytes));
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          this.dequeued(client);
          reject(new BusyError(undefined, this.options.retryAfterSec));
          // A waiter that gave up may have been what blocked the ones behind it.
          this.pump();
        }, this.options.maxWaitMs),
      };
      waiter.timer.unref();
      this.waiting.push(waiter);
      this.queued.set(client, queued + 1);
    });
  }

  /** Whether someone within their client's share waits for room in the total; newcomers queue behind them. */
  private waitingForTotal(): boolean {
    return this.waiting.some((w) => this.waitsForTotal(w));
  }

  private waitsForTotal(w: Waiter): boolean {
    return (
      this.total + w.bytes > this.options.maxBytes &&
      (this.owned.get(w.client) ?? 0) + w.bytes <= this.options.maxBytesPerClient
    );
  }

  private fits(client: string, bytes: number): boolean {
    return (
      this.total + bytes <= this.options.maxBytes &&
      (this.owned.get(client) ?? 0) + bytes <= this.options.maxBytesPerClient
    );
  }

  private take(client: string, key: string, bytes: number): () => void {
    const held = this.holders.get(key);
    if (held) held.refs++;
    else {
      this.holders.set(key, { bytes, refs: 1, owner: client });
      this.total += bytes;
      this.owned.set(client, (this.owned.get(client) ?? 0) + bytes);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(key);
    };
  }

  private release(key: string) {
    const held = this.holders.get(key);
    if (!held) return;
    if (--held.refs > 0) return;
    this.holders.delete(key);
    this.total -= held.bytes;
    const left = (this.owned.get(held.owner) ?? 0) - held.bytes;
    if (left > 0) this.owned.set(held.owner, left);
    else this.owned.delete(held.owner);
    this.pump();
  }

  /**
   * Starts waiters in order. One that would bring in more than the total allows stops the bytes for everyone behind
   * it, so a large body is not starved by a stream of small ones; one over its client's share only waits itself, so
   * a client queueing more than its share holds up nobody else.
   */
  private pump() {
    let blocked = false;
    for (let i = 0; i < this.waiting.length; ) {
      const w = this.waiting[i]!;
      const shared = this.holders.has(w.key);
      if (shared || (!blocked && this.fits(w.client, w.bytes))) {
        this.waiting.splice(i, 1);
        this.dequeued(w.client);
        w.grant();
        continue;
      }
      if (this.waitsForTotal(w)) blocked = true;
      i++;
    }
  }

  private dequeued(client: string) {
    const n = (this.queued.get(client) ?? 1) - 1;
    if (n <= 0) this.queued.delete(client);
    else this.queued.set(client, n);
  }
}
