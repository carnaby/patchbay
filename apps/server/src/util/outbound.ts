/**
 * Limits on requests this server makes to addresses its users chose. A public instance fetches from its operator's
 * network, so a stranger must not be able to turn it into a crawler: a few requests at a time overall, fewer per
 * host, and a per-host budget over time. Distinct URLs on one host share the budget, so a list of query strings
 * cannot be used to hammer someone else's server.
 */
import { HttpError } from './errors.ts';
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
}

interface Bucket {
  tokens: number;
  updated: number;
  active: number;
}

export class OutboundLimiter {
  private readonly gate: Gate;
  private readonly hosts = new Map<string, Bucket>();
  private readonly perHostConcurrency: number;
  private readonly perHostPerMinute: number;

  constructor(options: OutboundOptions = {}) {
    this.gate = new Gate({
      concurrency: options.concurrency ?? 3,
      maxQueue: 64,
      maxQueuedPerClient: 16,
      maxWaitMs: 15_000,
    });
    this.perHostConcurrency = options.perHostConcurrency ?? 2;
    this.perHostPerMinute = options.perHostPerMinute ?? 60;
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
      throw new HttpError(400, 'Invalid URL');
    }
    const b = this.bucket(host);
    if (b.active >= this.perHostConcurrency || b.tokens < 1) {
      throw new HttpError(
        429,
        `This server is already loading a lot from ${host}; it will try again on the next refresh`,
      );
    }
    b.tokens -= 1;
    b.active++;
    try {
      return await this.gate.run(client, task);
    } finally {
      b.active--;
    }
  }
}
