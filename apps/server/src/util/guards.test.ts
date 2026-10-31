import { inferTable } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { parseUpload, UploadError } from '../services/upload-parse.ts';
import { BusyError, Gate } from './gate.ts';
import { approxTableBytes, ByteLru } from './lru.ts';
import { OutboundLimiter } from './outbound.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('Gate', () => {
  it('runs a bounded number of tasks, queues a bounded number and refuses the rest as busy', async () => {
    const gate = new Gate({ concurrency: 1, maxQueue: 1 });
    const first = deferred();
    const running = gate.run('a', () => first.promise);
    const queued = gate.run('b', async () => 'second');
    await expect(gate.run('c', async () => 'third')).rejects.toBeInstanceOf(BusyError);
    expect(gate.stats()).toEqual({ active: 1, waiting: 1 });
    first.resolve();
    await running;
    expect(await queued).toBe('second');
    expect(gate.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('limits how much of the queue one client may hold', async () => {
    const gate = new Gate({ concurrency: 1, maxQueue: 10, maxQueuedPerClient: 1 });
    const first = deferred();
    const running = gate.run('a', () => first.promise);
    const waiting = gate.run('a', async () => 1);
    await expect(gate.run('a', async () => 2)).rejects.toBeInstanceOf(BusyError);
    const other = gate.run('b', async () => 3);
    first.resolve();
    expect(await Promise.all([running, waiting, other])).toEqual([undefined, 1, 3]);
  });

  it('gives up on a task that waited too long', async () => {
    const gate = new Gate({ concurrency: 1, maxQueue: 5, maxWaitMs: 20 });
    const first = deferred();
    const running = gate.run('a', () => first.promise);
    const err = await gate.run('b', async () => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).status).toBe(503);
    expect((err as BusyError).retryAfterSec).toBeGreaterThan(0);
    first.resolve();
    await running;
    expect(gate.stats()).toEqual({ active: 0, waiting: 0 });
  });
});

describe('ByteLru', () => {
  it('evicts the least recently used entries by bytes, not by count', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'a', 40);
    lru.set('b', 'b', 40);
    lru.get('a');
    lru.set('c', 'c', 40);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('a');
    expect(lru.get('c')).toBe('c');
    expect(lru.bytes).toBe(80);
  });

  it('never keeps a value larger than the budget, and drops expired entries', async () => {
    const lru = new ByteLru<string>(100);
    lru.set('keep', 'k', 10);
    lru.set('huge', 'h', 1000);
    expect(lru.get('huge')).toBeUndefined();
    expect(lru.get('keep')).toBe('k');
    lru.set('brief', 'b', 10, 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(lru.get('brief')).toBeUndefined();
    expect(lru.bytes).toBe(10);
  });

  it('estimates tables by their cells', () => {
    const narrow = inferTable(Array.from({ length: 1000 }, (_, i) => ({ a: i })));
    const wide = inferTable(Array.from({ length: 1000 }, (_, i) => ({ a: i, b: i, c: `text ${i}`, d: i })));
    expect(approxTableBytes(wide)).toBeGreaterThan(approxTableBytes(narrow) * 2);
    expect(approxTableBytes(narrow)).toBeGreaterThan(1000 * 16);
  });
});

describe('parseUpload', () => {
  const csv = (rows: number, cols: number) =>
    [
      Array.from({ length: cols }, (_, i) => `c${i}`).join(','),
      ...Array.from({ length: rows }, () => Array.from({ length: cols }, (_, i) => i % 10).join(',')),
    ].join('\n');

  it('accepts files up to the cell limit', () => {
    const table = parseUpload({ content: csv(50, 20), format: 'csv', maxCells: 1000 });
    expect(table.rows).toHaveLength(50);
    expect(table.columns).toHaveLength(20);
  });

  it('stops reading a CSV as soon as it passes the limit', () => {
    const err = (() => {
      try {
        parseUpload({ content: csv(100_000, 20), format: 'csv', maxCells: 1000 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).tooLarge).toBe(true);
    expect((err as Error).message).toContain('more than 50 rows × 20 columns');
    expect((err as Error).message).toContain('1,000 cells');
  });

  it('refuses oversized JSON before flattening every record', () => {
    const records = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ a: i, b: i, c: i })));
    expect(() => parseUpload({ content: records, format: 'json', maxCells: 1000 })).toThrow(
      /500 rows × 3 columns/,
    );
    expect(parseUpload({ content: records, format: 'json', maxCells: 1500 }).rows).toHaveLength(500);
  });

  it('keeps the old parsing rules: BOM, trimmed headers, invalid JSON', () => {
    const table = parseUpload({ content: '﻿ a , b \n1,2\n', format: 'csv', maxCells: 100 });
    expect(table.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(() => parseUpload({ content: '{nope', format: 'json', maxCells: 100 })).toThrow(/not valid JSON/);
    expect(() => parseUpload({ content: '', format: 'csv', maxCells: 100 })).toThrow(UploadError);
  });
});

describe('OutboundLimiter', () => {
  it('limits requests in flight per host and per minute', async () => {
    const limiter = new OutboundLimiter({ perHostConcurrency: 1, perHostPerMinute: 3 });
    const slow = deferred();
    const first = limiter.run('a', 'https://one.example/a', () => slow.promise);
    await expect(limiter.run('a', 'https://ONE.example/b', async () => 1)).rejects.toMatchObject({
      status: 429,
    });
    expect(await limiter.run('a', 'https://two.example/', async () => 2)).toBe(2);
    slow.resolve();
    await first;
    // The refused request did not spend the budget; two more fit, the next does not.
    expect(await limiter.run('a', 'https://one.example/c', async () => 3)).toBe(3);
    expect(await limiter.run('a', 'https://one.example/d', async () => 4)).toBe(4);
    await expect(limiter.run('a', 'https://one.example/e', async () => 5)).rejects.toMatchObject({
      status: 429,
    });
  });
});
