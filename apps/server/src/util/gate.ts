/**
 * Admission control for work that holds a lot of memory while it runs (parsing an uploaded file, a large HTTP body,
 * a table on its way to a worker). The instance is small: a burst that ran all of it at once would crash the process
 * for everyone, while a burst that queues briefly and then answers 503 only slows down the burst itself.
 */
import { RetryLaterError } from './errors.ts';

/** The server is saturated; the request may be repeated after `retryAfterSec`. */
export class BusyError extends RetryLaterError {
  constructor(message = 'The server is busy; try again in a few seconds', retryAfterSec = 5) {
    super(503, message, retryAfterSec);
  }
}

export interface GateOptions {
  /** Tasks running at the same time. */
  concurrency: number;
  /** Tasks waiting beyond this are refused at once. */
  maxQueue: number;
  /** Waiting tasks one client may have, so a single client cannot take the whole queue. */
  maxQueuedPerClient?: number;
  /** A task that waited this long is refused instead of started: its caller has likely given up. */
  maxWaitMs?: number;
  retryAfterSec?: number;
}

interface Waiter {
  client: string;
  start: () => void;
  timer: NodeJS.Timeout | null;
}

export class Gate {
  private readonly options: Required<GateOptions>;
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly perClient = new Map<string, number>();

  constructor(options: GateOptions) {
    this.options = {
      maxQueuedPerClient: options.maxQueue,
      maxWaitMs: 20_000,
      retryAfterSec: 5,
      ...options,
    };
  }

  /** Tasks running and waiting (diagnostics and tests). */
  stats() {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(client: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(client);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private busy(): BusyError {
    return new BusyError(undefined, this.options.retryAfterSec);
  }

  private acquire(client: string): Promise<void> {
    if (this.active < this.options.concurrency && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    const queued = this.perClient.get(client) ?? 0;
    if (this.waiting.length >= this.options.maxQueue || queued >= this.options.maxQueuedPerClient) {
      return Promise.reject(this.busy());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        client,
        start: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve();
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        this.dequeued(client);
        reject(this.busy());
      }, this.options.maxWaitMs);
      waiter.timer.unref();
      this.waiting.push(waiter);
      this.perClient.set(client, queued + 1);
    });
  }

  private dequeued(client: string) {
    const n = (this.perClient.get(client) ?? 1) - 1;
    if (n <= 0) this.perClient.delete(client);
    else this.perClient.set(client, n);
  }

  private release() {
    this.active--;
    const next = this.waiting.shift();
    if (!next) return;
    this.dequeued(next.client);
    this.active++;
    next.start();
  }
}
