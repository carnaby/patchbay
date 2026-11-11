/**
 * Limits on requests this server makes to addresses its users chose. A public instance fetches from its operator's
 * network, so a stranger must not be able to turn it into a crawler: a few requests at a time overall, fewer per
 * host, and a per-host budget over time. Distinct URLs on one host share the budget, so a list of query strings
 * cannot be used to hammer someone else's server.
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

interface Bucket {
  tokens: number;
  updated: number;
  active: number;
}

interface Waiter {
  client: string;
  grant: (release: () => void) => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface ConnectorBucket extends Bucket {
  waiting: Waiter[];
  wake: NodeJS.Timeout | null;
}

/** Answered for both kinds of request: the status and the retry hint make the page ask again by itself. */
const busyHost = (host: string) =>
  new RetryLaterError(
    429,
    `This server is already loading a lot from ${host}; it will try again shortly`,
    10,
  );

export class OutboundLimiter {
  private readonly gate: Gate;
  private readonly hosts = new Map<string, Bucket>();
  private readonly perHostConcurrency: number;
  private readonly perHostPerMinute: number;
  private readonly connectorHosts = new Map<string, ConnectorBucket>();
  private readonly connector: Required<ConnectorOptions>;

  constructor(options: OutboundOptions = {}) {
    this.gate = new Gate({
      concurrency: options.concurrency ?? 3,
      maxQueue: 64,
      maxQueuedPerClient: 16,
      maxWaitMs: 15_000,
    });
    this.perHostConcurrency = options.perHostConcurrency ?? 2;
    this.perHostPerMinute = options.perHostPerMinute ?? 60;
    const c = options.connector ?? {};
    this.connector = {
      perHostConcurrency: c.perHostConcurrency ?? 4,
      perHostPerMinute: c.perHostPerMinute ?? 120,
      maxWaitMs: c.maxWaitMs ?? 8000,
      maxQueuePerHost: c.maxQueuePerHost ?? 32,
      maxQueuedPerClient: c.maxQueuedPerClient ?? 8,
    };
  }

  private bucket(host: string): Bucket {
    const now = Date.now();
    let b = this.hosts.get(host);
    if (!b) {
      b = { tokens: this.perHostPerMinute, updated: now, active: 0 };
      this.hosts.set(host, b);
      if (this.hosts.size > 10_000) {
        for (const [h, x] of this.hosts)
          if (x.active === 0 && now - x.updated > 120_000) this.hosts.delete(h);
      }
    }
    b.tokens = Math.min(
      this.perHostPerMinute,
      b.tokens + ((now - b.updated) / 60_000) * this.perHostPerMinute,
    );
    b.updated = now;
    return b;
  }

  /** Runs one request to `url`, or refuses it when the host's budget or the server's capacity is spent. */
  async run<T>(client: string, url: string, task: () => Promise<T>): Promise<T> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw lastingError(400, 'Invalid URL');
    }
    const b = this.bucket(host);
    if (b.active >= this.perHostConcurrency || b.tokens < 1) throw busyHost(host);
    b.tokens -= 1;
    b.active++;
    try {
      return await this.gate.run(client, task);
    } finally {
      b.active--;
    }
  }

  /**
   * Connector loads wait for their turn instead of being refused: a dashboard opens several param sets of one connector
   * at once (compare-cities: two forecasts, two air-quality readings), and a refusal there is an error on screen. One
   * place per load and host, held until the load ends, because one load may ask its host for 50 URLs at once.
   * Not through the global gate: connectors call a fixed set of public APIs, not addresses a stranger chose.
   */
  async acquireConnectorSlot(client: string, host: string): Promise<() => void> {
    const { perHostConcurrency, maxWaitMs, maxQueuePerHost, maxQueuedPerClient } = this.connector;
    const b = this.connectorBucket(host);
    // Only with nobody waiting: a new load never takes the place a waiter is about to get.
    if (b.waiting.length === 0 && b.active < perHostConcurrency && b.tokens >= 1) return this.grant(host, b);
    if (
      b.waiting.length >= maxQueuePerHost ||
      b.waiting.filter((w) => w.client === client).length >= maxQueuedPerClient
    ) {
      throw busyHost(host);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        client,
        grant: resolve,
        fail: reject,
        timer: setTimeout(() => {
          const index = b.waiting.indexOf(waiter);
          if (index < 0) return;
          b.waiting.splice(index, 1);
          waiter.fail(busyHost(host));
          this.pump(host, b);
        }, maxWaitMs),
      };
      waiter.timer.unref();
      b.waiting.push(waiter);
      this.pump(host, b);
    });
  }

  private connectorBucket(host: string): ConnectorBucket {
    const now = Date.now();
    let b = this.connectorHosts.get(host);
    if (!b) {
      b = { tokens: this.connector.perHostPerMinute, updated: now, active: 0, waiting: [], wake: null };
      this.connectorHosts.set(host, b);
      if (this.connectorHosts.size > 10_000) {
        // Only buckets nobody holds or waits on, and full again: forgetting them changes nothing.
        for (const [h, x] of this.connectorHosts)
          if (x.active === 0 && x.waiting.length === 0 && now - x.updated > 120_000)
            this.connectorHosts.delete(h);
      }
    }
    this.refill(b, now);
    return b;
  }

  private refill(b: ConnectorBucket, now = Date.now()) {
    const { perHostPerMinute } = this.connector;
    b.tokens = Math.min(perHostPerMinute, b.tokens + ((now - b.updated) / 60_000) * perHostPerMinute);
    b.updated = now;
  }

  private grant(host: string, b: ConnectorBucket): () => void {
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
  private pump(host: string, b: ConnectorBucket) {
    const { perHostConcurrency, perHostPerMinute } = this.connector;
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
