/** In-memory token bucket. Good enough for a single-process deployment. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, perMinute: number) {
    this.capacity = capacity;
    this.refillPerSec = perMinute / 60;
  }

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.updated) / 1000) * this.refillPerSec,
    );
    bucket.updated = now;
    const ok = bucket.tokens >= cost;
    if (ok) bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 50_000) this.sweep(now);
    return ok;
  }

  private sweep(now: number) {
    for (const [key, b] of this.buckets) if (now - b.updated > 3_600_000) this.buckets.delete(key);
  }
}
