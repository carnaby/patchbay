export interface RateLimiterOptions {
  /** Hard cap on tracked keys; the least recently used are dropped beyond it. */
  maxEntries?: number;
  /** How often idle buckets are swept, so memory follows the number of active clients. */
  sweepEveryMs?: number;
}

/** In-memory token bucket. Good enough for a single-process deployment. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxEntries: number;
  private readonly sweepEveryMs: number;
  private lastSweep = Date.now();

  constructor(capacity: number, perMinute: number, options: RateLimiterOptions = {}) {
    this.capacity = capacity;
    this.refillPerSec = perMinute / 60;
    this.maxEntries = options.maxEntries ?? 100_000;
    this.sweepEveryMs = options.sweepEveryMs ?? 60_000;
  }

  /** Number of tracked keys (for tests and diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    if (now - this.lastSweep >= this.sweepEveryMs) this.sweep(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    bucket.tokens = this.level(bucket, now);
    bucket.updated = now;
    const ok = bucket.tokens >= cost;
    if (ok) bucket.tokens -= cost;
    // Re-inserting keeps the map in least-recently-used order, so eviction below drops idle keys first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxEntries) {
      this.sweep(now);
      for (const oldest of this.buckets.keys()) {
        if (this.buckets.size <= this.maxEntries) break;
        this.buckets.delete(oldest);
      }
    }
    return ok;
  }

  private level(bucket: { tokens: number; updated: number }, now: number): number {
    return Math.min(this.capacity, bucket.tokens + ((now - bucket.updated) / 1000) * this.refillPerSec);
  }

  /** A bucket that has refilled completely is indistinguishable from a new one, so dropping it loses nothing. */
  private sweep(now: number) {
    this.lastSweep = now;
    for (const [key, b] of this.buckets) if (this.level(b, now) >= this.capacity) this.buckets.delete(key);
  }
}
