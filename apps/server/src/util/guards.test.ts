import { inferTable } from '@patchbay/core';
import { describe, expect, it, vi } from 'vitest';
import {
  jsonUploadProblem,
  parseUpload,
  UPLOAD_MAX_COLUMN_NAME,
  UPLOAD_MAX_COLUMNS,
  UploadError,
} from '../services/upload-parse.ts';
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

  /** A metrics API answer in columns: an ISO time, a number with a gap, a status. */
  const METRICS = {
    timestamps: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', '2026-11-01T02:00:00Z'],
    values: [12.5, null, 14],
    status: ['ok', 'warn', 'ok'],
  };
  const NESTED_FILE = {
    meta: { source: 'probe', count: 5 },
    data: {
      items: [
        { city: 'Oslo', n: 1 },
        { city: 'Rome', n: 2 },
      ],
    },
    metrics: METRICS,
  };

  it('reads a JSON file at a path, turns column-shaped data into rows, and names a missing path', () => {
    const content = JSON.stringify(NESTED_FILE);
    const json = (path?: string) => parseUpload({ content, format: 'json', maxCells: 1000, path });
    expect(json('data.items').rows).toEqual([
      { city: 'Oslo', n: 1 },
      { city: 'Rome', n: 2 },
    ]);
    expect(json('metrics').columns.map((c) => c.name)).toEqual(['timestamps', 'values', 'status']);
    expect(json('metrics').rows).toHaveLength(3);
    expect(json('meta.count').rows).toEqual([{ value: 5 }]);
    expect(json().rows).toHaveLength(1);
    expect(() => json('data.rows')).toThrow(UploadError);
    expect(() => json('data.rows')).toThrow('Path "data.rows" not found in the file (stopped at "rows")');
  });

  it('reads a column-shaped file without a path, and anything looser as before', () => {
    const json = (value: unknown) =>
      parseUpload({ content: JSON.stringify(value), format: 'json', maxCells: 1000 });
    expect(json(METRICS).columns.map((c) => c.name)).toEqual(['timestamps', 'values', 'status']);
    expect(json(METRICS).rows[1]).toEqual({
      timestamps: Date.parse('2026-11-01T01:00:00Z'),
      values: null,
      status: 'warn',
    });
    expect(json({ values: [1, 2, 3] }).rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(json({ timestamps: [1, 2, 3], values: [5, 6] }).rows).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
    expect(json({ timestamps: [1, 2], values: [{ v: 5 }, { v: 6 }] }).rows).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(json(7).rows).toEqual([{ value: 7 }]);
  });

  it('refuses a column-shaped file over the cell limit, naming its rows and columns', () => {
    const columns = (count: number, length: number) =>
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, c) => [`c${c}`, Array.from({ length }, (_, i) => i)]),
        ),
      );
    const json = (content: string) => () => parseUpload({ content, format: 'json', maxCells: 100 });
    // Few enough values for the check before parsing, too many cells once read as columns.
    expect(json(columns(5, 50))).toThrow(UploadError);
    expect(json(columns(5, 50))).toThrow(
      'The file has 50 rows × 5 columns; this dashboard accepts files of up to 100 cells',
    );
    // More positions than the limit has cells: still every column counted, not one.
    expect(json(columns(2, 140))).toThrow('The file has 140 rows × 2 columns;');
    expect(json(columns(5, 20))()).toMatchObject({ rows: { length: 20 } });
  });

  it('keeps a "__proto__" key as a column in JSON records, column-shaped JSON and CSV', () => {
    const proto = '__proto__';
    const upload = (content: string, format: 'json' | 'csv') =>
      parseUpload({ content, format, maxCells: 100 });
    for (const table of [
      upload('[{"__proto__": 1, "b": 2}, {"__proto__": 3, "b": 4}]', 'json'),
      upload('{"__proto__": [1, 3], "b": [2, 4]}', 'json'),
      upload('__proto__,b\n1,2\n3,4\n', 'csv'),
    ]) {
      expect(table.columns.map((c) => c.name)).toEqual(['__proto__', 'b']);
      expect(table.rows.map((r) => [Object.hasOwn(r, proto), r[proto], r.b])).toEqual([
        [true, 1, 2],
        [true, 3, 4],
      ]);
      expect(Object.getPrototypeOf(table.rows[0]!)).toBe(Object.prototype);
    }
  });

  it('gives a repeated "__proto__" CSV header a free name, never one the file already uses', () => {
    const csv = (content: string) => {
      const table = parseUpload({ content, format: 'csv', maxCells: 100 });
      return table.columns.map((c) => [c.name, table.rows[0]![c.name]]);
    };
    expect(csv('__proto___1,__proto__,__proto__\n1,2,3\n')).toEqual([
      ['__proto___1', 1],
      ['__proto__', 2],
      ['__proto___2', 3],
    ]);
    // Headers are trimmed, so a spaced one is the same name.
    expect(csv(' __proto__ ,b\n1,2\n')).toEqual([
      ['__proto__', 1],
      ['b', 2],
    ]);
  });

  it('refuses a header repeating "__proto__" past the column limit like any other name', () => {
    const header = (name: string) => `${Array.from({ length: 20_000 }, () => name).join(',')}\n1\n`;
    const upload = (name: string) => () =>
      parseUpload({ content: header(name), format: 'csv', maxCells: 100_000 });
    // Naming 20,000 repeated markers one by one took 47 s; the count is known from the header alone.
    expect(upload('a')).toThrow('The file has 20,000 columns; uploads are limited to 500');
    expect(upload('__proto__')).toThrow('The file has 20,000 columns; uploads are limited to 500');
  });

  it('ignores a path for CSV', () => {
    expect(
      parseUpload({ content: 'a,b\n1,2\n', format: 'csv', maxCells: 100, path: 'data.items' }).rows,
    ).toEqual([{ a: 1, b: 2 }]);
  });

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

  it('refuses long column names and too many columns, in CSV before reading rows and in JSON', () => {
    const long = 'n'.repeat(UPLOAD_MAX_COLUMN_NAME + 1);
    const longCsv = `id,${long}\n${'1,2\n'.repeat(10)}`;
    expect(() => parseUpload({ content: longCsv, format: 'csv', maxCells: 1000 })).toThrow(
      `Column names are limited to ${UPLOAD_MAX_COLUMN_NAME} characters`,
    );
    const longJson = JSON.stringify([{ id: 1, [long]: 2 }]);
    expect(() => parseUpload({ content: longJson, format: 'json', maxCells: 1000 })).toThrow(
      `limited to ${UPLOAD_MAX_COLUMN_NAME} characters`,
    );
    // Nested objects become dotted names, which count as a whole.
    const nested = JSON.stringify([{ a: { [long.slice(2)]: 1 }, b: 2 }]);
    expect(() => parseUpload({ content: nested, format: 'json', maxCells: 1000 })).toThrow(UploadError);
    const okName = 'n'.repeat(UPLOAD_MAX_COLUMN_NAME);
    expect(parseUpload({ content: `${okName}\n1\n`, format: 'csv', maxCells: 10 }).columns[0]!.name).toBe(
      okName,
    );
    const wide = csv(1, UPLOAD_MAX_COLUMNS + 1);
    expect(() => parseUpload({ content: wide, format: 'csv', maxCells: 100_000 })).toThrow(
      `uploads are limited to ${UPLOAD_MAX_COLUMNS}`,
    );
    expect(
      parseUpload({ content: csv(1, UPLOAD_MAX_COLUMNS), format: 'csv', maxCells: 100_000 }).columns,
    ).toHaveLength(UPLOAD_MAX_COLUMNS);
  });

  it('refuses deeply nested or value-heavy JSON before parsing it', () => {
    const bomb = '['.repeat(100_000) + ']'.repeat(100_000);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => parseUpload({ content: bomb, format: 'json', maxCells: 1000 })).toThrow(
        'nests deeper than 64',
      );
      const many = JSON.stringify(Array.from({ length: 3001 }, () => 0));
      const err = (() => {
        try {
          parseUpload({ content: many, format: 'json', maxCells: 1000 });
        } catch (e) {
          return e as UploadError;
        }
      })();
      expect(err?.message).toContain('more than 3,000 values');
      expect(err?.tooLarge).toBe(true);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(jsonUploadProblem(JSON.stringify([{ a: [1, 2, 3], b: { c: 'x' } }]), 10)).toBeNull();
  });

  it('holds the cell and column limits of JSON uploads whatever the order of wide and narrow records', () => {
    // Judging the width from the first 200 records let 200 empty ones hide a wide one: 450 million cells.
    const wideRecord = (keys: number) =>
      Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, 1]));
    const lateWide = (keys: number, tail: number) =>
      JSON.stringify([
        ...Array.from({ length: 200 }, () => ({})),
        wideRecord(keys),
        ...Array.from({ length: tail }, () => ({})),
      ]);
    const startedAt = Date.now();
    expect(() => parseUpload({ content: lateWide(400, 99_799), format: 'json', maxCells: 500_000 })).toThrow(
      /up to 500,000 cells/,
    );
    expect(() => parseUpload({ content: lateWide(4500, 10_000), format: 'json', maxCells: 500_000 })).toThrow(
      `uploads are limited to ${UPLOAD_MAX_COLUMNS}`,
    );
    // One record with more keys than the whole limit allows is refused without copying it.
    const entries = vi.spyOn(Object, 'entries');
    try {
      expect(() => parseUpload({ content: lateWide(150_000, 0), format: 'json', maxCells: 500_000 })).toThrow(
        `uploads are limited to ${UPLOAD_MAX_COLUMNS}`,
      );
      expect(entries).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
    }
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const fits = parseUpload({ content: lateWide(10, 100), format: 'json', maxCells: 5000 });
    expect(fits.columns).toHaveLength(10);
    expect(fits.rows).toHaveLength(301);
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
