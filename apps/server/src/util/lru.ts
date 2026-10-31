/**
 * A least-recently-used map bounded by the approximate memory of its values, not by their number: a hundred tiny
 * tables and three huge ones are very different amounts of memory.
 */
import type { DataTable } from '@patchbay/core';

interface Entry<V> {
  value: V;
  bytes: number;
  expires: number;
}

export class ByteLru<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxBytes: number;
  private total = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    // Re-insert to keep the Map in least-recently-used order.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** A value larger than the whole budget is not kept at all, rather than emptying the cache for it. */
  set(key: string, value: V, bytes: number, ttlMs = Number.POSITIVE_INFINITY) {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.map.set(key, { value, bytes, expires: Date.now() + ttlMs });
    this.total += bytes;
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (this.total <= this.maxBytes) break;
      if (k === key && e.expires > now) continue;
      this.delete(k);
    }
  }

  delete(key: string) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.bytes;
  }

  deleteWhere(test: (key: string) => boolean) {
    for (const key of [...this.map.keys()]) if (test(key)) this.delete(key);
  }

  clear() {
    this.map.clear();
    this.total = 0;
  }
}

/**
 * Roughly what a table costs on the V8 heap: a pointer per cell and per row, a boxed number or a string header plus
 * its characters. Precise enough to keep caches within budget; it overestimates small integers and shared strings.
 */
export function approxTableBytes(table: DataTable): number {
  const columns = table.columns.length;
  let bytes = 64 + columns * 64;
  // Sampling keeps this cheap on large tables; rows of one table are alike enough.
  const rows = table.rows;
  const step = Math.max(1, Math.floor(rows.length / 2000));
  let sampled = 0;
  let sampledBytes = 0;
  for (let i = 0; i < rows.length; i += step) {
    const row = rows[i]!;
    let b = 32 + columns * 8;
    for (const key in row) {
      const v = row[key];
      if (typeof v === 'string') b += 16 + v.length * 2;
      else if (typeof v === 'number') b += 16;
    }
    sampledBytes += b;
    sampled++;
  }
  if (sampled > 0) bytes += (sampledBytes / sampled) * rows.length;
  return Math.ceil(bytes);
}
