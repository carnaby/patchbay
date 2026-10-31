/**
 * A short-lived cache of rendered snapshots.
 *
 * Social previews and embeds fetch the same image again and again, and the response is `private` so no CDN absorbs
 * the repeats. Keyed by dashboard version, so an edit is visible at once; data that changes underneath is at most
 * `ttlMs` old, the same age the response's max-age already allows a browser to show. Requests arriving while the
 * image is being drawn wait for that one render instead of starting their own.
 */
export interface SnapshotCacheOptions {
  ttlMs?: number;
  /** Total size of the kept images; the oldest go first. */
  maxBytes?: number;
  now?: () => number;
}

interface Entry {
  png: Promise<Buffer>;
  bytes: number;
  expires: number;
}

export class SnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private bytes = 0;

  constructor(options: SnapshotCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  static key(parts: { id: string; version: number; theme: string; widget?: string | undefined }) {
    return JSON.stringify([parts.id, parts.version, parts.theme, parts.widget ?? null]);
  }

  get(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.png;
    if (hit) this.drop(key);
    const entry: Entry = { png: render(), bytes: 0, expires: this.now() + this.ttlMs };
    this.entries.set(key, entry);
    entry.png.then(
      (png) => {
        if (this.entries.get(key) !== entry) return;
        entry.bytes = png.length;
        this.bytes += png.length;
        this.evict();
      },
      // A failed render (busy, rate limited, broken data) is not remembered: the next request tries again. One that
      // ran out of time or memory would only do so again, at the same cost, so it is answered from here until expiry.
      (err: unknown) => {
        if (this.entries.get(key) === entry && !(err as { lasting?: unknown })?.lasting)
          this.entries.delete(key);
      },
    );
    return entry.png;
  }

  size(): number {
    return this.entries.size;
  }

  private drop(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  private evict() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.drop(key);
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      // Renders still in flight hold no bytes yet; keeping them lets their waiters share the result.
      if (entry.bytes > 0) this.drop(key);
    }
  }
}

export const snapshotCache = new SnapshotCache();
