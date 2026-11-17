/**
 * Limits on requests this server makes to addresses its users chose. A public instance fetches from its operator's
 * network, so a stranger must not be able to turn it into a crawler: a few requests at a time overall, fewer per
 * host, and a per-host budget over time. Distinct URLs on one host share the budget, so a list of query strings
 * cannot be used to hammer someone else's server.
 *
 * Requests wait for their host in a FIFO queue instead of being refused: HTTP sources and feeds 2 at a time and 60 a
 * minute per host (up to 8 s, at most 16 waiting per host and 8 per client), built-in connectors 4 and 120 (up to 8 s,
 * 32 and 8). A dashboard opens several addresses on one host together (a status wall, a connector with several param
 * sets), and a refusal there is an error on screen. Waiting changes only the order: what a host receives stays within
 * its budget, and the bounded queues refuse at once whatever would pile up beyond them, so a stranger's dashboard
 * cannot hammer a host by asking for more.
 */
import { lastingError, RetryLaterError } from './errors.ts';
import { Gate } from './gate.ts';

export interface OutboundOptions {
  /**
   * Requests in flight across all hosts. Few by default: each may hold a 5 MB body and its parsed JSON on the main
   * thread until it becomes a table.
   */
  concurrency?: number;
  /** Requests in flight to one host. */
  perHostConcurrency?: number;
  /** Requests one host may receive per minute (burst = the same number). */
  perHostPerMinute?: number;
  /**
   * How long a request waits for its host before it is refused. Then the global gate and the fetch itself may pass
   * the scope deadline (20 s): the scope reports the source as still loading and the page asks again.
   */
  maxWaitMs?: number;
  /** Requests waiting for one host beyond this are refused at once. */
  maxQueuePerHost?: number;
  /** Requests one client may have waiting for one host, so a single dashboard cannot take a host's whole queue. */
  maxQueuedPerClient?: number;
  /** Built-in connector loads, counted per upstream host in buckets of their own (see `acquireConnectorSlot`). */
  connector?: ConnectorOptions;
}

export interface ConnectorOptions {
  /** Loads holding a place on one host at the same time. */
  perHostConcurrency?: number;
  /** Loads one host may receive per minute (burst = the same number). */
  perHostPerMinute?: number;
  /**
   * How long a load waits for its turn before it is refused. A single-host load that waited the full 8 s still fits
   * the scope deadline (20 s) with its 10 s fetch; a two-host load (geocoder, then forecast) may not, and a scope then
   * reports its source as still loading and the page asks again.
   */
  maxWaitMs?: number;
  /** Loads waiting for one host beyond this are refused at once. */
  maxQueuePerHost?: number;
  /** Loads one client may have waiting for one host, so a single dashboard cannot take a host's whole queue. */
  maxQueuedPerClient?: number;
}

interface Waiter {
  client: string;
  grant: (release: () => void) => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Bucket {
  tokens: number;
  updated: number;
  active: number;
  waiting: Waiter[];
  wake: NodeJS.Timeout | null;
}

const BUSY_HOST_HEAD = 'This server is already loading a lot from ';
const BUSY_HOST_TAIL = '; it will try again shortly';
/** Answered for both kinds of request: the status and the retry hint make the page ask again by itself. */
const busyHost = (host: string) => new RetryLaterError(429, `${BUSY_HOST_HEAD}${host}${BUSY_HOST_TAIL}`, 10);

/**
 * Whether an error message is a per-host refusal of this limiter, also as the reason a dataset reading the refused one
 * failed (`Source dataset "x" failed: …`). Results carry only the message, and a slow source's "still loading" has a
 * retry hint too, so the message is what names the cause.
 */
export const isBusyHostRefusal = (message: string | undefined): boolean => {
  if (message === undefined || !message.endsWith(BUSY_HOST_TAIL)) return false;
  const at = message.indexOf(BUSY_HOST_HEAD);
  return at === 0 || (at > 0 && message.startsWith('Source dataset "'));
};

/** Places and a minute budget per host, with a bounded FIFO queue of those waiting for them. */
class HostQueue {
  private readonly limits: Required<ConnectorOptions>;
  private readonly hosts = new Map<string, Bucket>();

  constructor(limits: Required<ConnectorOptions>) {
    this.limits = limits;
  }

  /** A place on `host`, waiting for it if needed; resolves to its release. */
  async acquire(client: string, host: string, signal?: AbortSignal): Promise<() => void> {
    // The load this place is for has ended (it failed on another host): no place, no token, no queue entry.
    if (signal?.aborted) throw new Error('The load ended before its turn came');
    const { maxWaitMs, maxQueuePerHost, maxQueuedPerClient } = this.limits;
    const b = this.bucket(host);
    const now = this.tryGrant(host, b);
    if (now) return now;
    if (
      b.waiting.length >= maxQueuePerHost ||
      b.waiting.filter((w) => w.client === client).length >= maxQueuedPerClient
    ) {
      throw busyHost(host);
    }
    return new Promise((resolve, reject) => {
      // A waiter leaves the queue exactly once: granted by pump, timed out, or here when its load ends first.
      const leave = () => {
        const index = b.waiting.indexOf(waiter);
        if (index < 0) return;
        b.waiting.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.fail(new Error('The load ended before its turn came'));
        this.pump(host, b);
      };
      const waiter: Waiter = {
        client,
        grant: (release) => {
          signal?.removeEventListener('abort', leave);
          resolve(release);
        },
        fail: (e) => {
          signal?.removeEventListener('abort', leave);
          reject(e);
        },
        timer: setTimeout(() => {
          const index = b.waiting.indexOf(waiter);
          if (index < 0) return;
          b.waiting.splice(index, 1);
          waiter.fail(busyHost(host));
          this.pump(host, b);
        }, maxWaitMs),
      };
      waiter.timer.unref();
      signal?.addEventListener('abort', leave, { once: true });
      b.waiting.push(waiter);
      this.pump(host, b);
    });
  }

  /** A place on `host` now, or the busy-host refusal: never a queue entry. */
  tryAcquire(host: string): () => void {
    const b = this.bucket(host);
    const now = this.tryGrant(host, b);
    if (!now) throw busyHost(host);
    return now;
  }

  private tryGrant(host: string, b: Bucket): (() => void) | null {
    // Only with nobody waiting: a new request never takes the place a waiter is about to get.
    if (b.waiting.length === 0 && b.active < this.limits.perHostConcurrency && b.tokens >= 1)
      return this.grant(host, b);
    return null;
  }

  private bucket(host: string): Bucket {
    const now = Date.now();
    let b = this.hosts.get(host);
    if (!b) {
      b = { tokens: this.limits.perHostPerMinute, updated: now, active: 0, waiting: [], wake: null };
      this.hosts.set(host, b);
      if (this.hosts.size > 10_000) {
        // Only buckets nobody holds or waits on, and full again: forgetting them changes nothing.
        for (const [h, x] of this.hosts)
          if (x.active === 0 && x.waiting.length === 0 && now - x.updated > 120_000) this.hosts.delete(h);
      }
    }
    this.refill(b, now);
    return b;
  }

  private refill(b: Bucket, now = Date.now()) {
    const { perHostPerMinute } = this.limits;
    b.tokens = Math.min(perHostPerMinute, b.tokens + ((now - b.updated) / 60_000) * perHostPerMinute);
    b.updated = now;
  }

  private grant(host: string, b: Bucket): () => void {
    b.tokens -= 1;
    b.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      b.active--;
      this.pump(host, b);
    };
  }

  /** Starts waiters in order while the host has room, and wakes up later when only the minute budget holds them. */
  private pump(host: string, b: Bucket) {
    const { perHostConcurrency, perHostPerMinute } = this.limits;
    this.refill(b);
    while (b.waiting.length > 0 && b.active < perHostConcurrency && b.tokens >= 1) {
      const next = b.waiting.shift()!;
      clearTimeout(next.timer);
      next.grant(this.grant(host, b));
    }
    if (b.waiting.length === 0) {
      if (b.wake) clearTimeout(b.wake);
      b.wake = null;
      return;
    }
    // A release pumps again when concurrency is what holds the head; only a missing token needs a timer. With no
    // minute budget no token ever comes (and a delay of Infinity fires after 1 ms): the waiters time out instead.
    if (b.wake || b.active >= perHostConcurrency || perHostPerMinute <= 0) return;
    b.wake = setTimeout(
      () => {
        b.wake = null;
        this.pump(host, b);
      },
      Math.ceil(((1 - b.tokens) / perHostPerMinute) * 60_000),
    );
    b.wake.unref();
  }
}

export class OutboundLimiter {
  private readonly gate: Gate;
  private readonly http: HostQueue;
  private readonly connectors: HostQueue;

  constructor(options: OutboundOptions = {}) {
    this.gate = new Gate({
      concurrency: options.concurrency ?? 3,
      maxQueue: 64,
      maxQueuedPerClient: 16,
      maxWaitMs: 15_000,
    });
    this.http = new HostQueue({
      perHostConcurrency: options.perHostConcurrency ?? 2,
      perHostPerMinute: options.perHostPerMinute ?? 60,
      maxWaitMs: options.maxWaitMs ?? 8000,
      maxQueuePerHost: options.maxQueuePerHost ?? 16,
      maxQueuedPerClient: options.maxQueuedPerClient ?? 8,
    });
    const c = options.connector ?? {};
    this.connectors = new HostQueue({
      perHostConcurrency: c.perHostConcurrency ?? 4,
      perHostPerMinute: c.perHostPerMinute ?? 120,
      maxWaitMs: c.maxWaitMs ?? 8000,
      maxQueuePerHost: c.maxQueuePerHost ?? 32,
      maxQueuedPerClient: c.maxQueuedPerClient ?? 8,
    });
  }

  /**
   * Runs one request to `url` once its host has a place and a token, or refuses it when the wait runs out, the queue
   * is full, or (with `wait: false`) the host is busy now.
   */
  async run<T>(
    client: string,
    url: string,
    task: () => Promise<T>,
    options: { wait?: boolean } = {},
  ): Promise<T> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw lastingError(400, 'Invalid URL');
    }
    // The host place comes before the global gate: a request waiting for a busy host must not hold one of the few
    // places every host shares.
    const release =
      options.wait === false ? this.http.tryAcquire(host) : await this.http.acquire(client, host);
    try {
      return await this.gate.run(client, task);
    } finally {
      release();
    }
  }

  /**
   * Connector loads wait for their host like http sources (4 at a time and 120 a minute per host, up to 8 s, at most
   * 32 waiting per host and 8 per client): a dashboard opens several param sets of one connector at once
   * (compare-cities: two forecasts, two air-quality readings), and a refusal there is an error on screen. One place
   * per load and host, held until the load ends, because one load may ask its host for 50 URLs at once. Buckets of
   * their own, not through the global gate: connectors call a fixed set of public APIs, not addresses a stranger chose.
   */
  acquireConnectorSlot(client: string, host: string, signal?: AbortSignal): Promise<() => void> {
    return this.connectors.acquire(client, host, signal);
  }
}
