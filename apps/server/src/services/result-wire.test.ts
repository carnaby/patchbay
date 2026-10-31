import type { DatasetResult, DataTable, LiveEvent } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { ByteBudget } from '../util/byte-budget.ts';
import { BusyError } from '../util/gate.ts';
import { runAsClient } from '../util/request-context.ts';
import { MAX_RESULT_BYTES, ResultWire, streamBody } from './result-wire.ts';

const result = (table: DataTable, datasetId = 'd'): DatasetResult => ({
  datasetId,
  table,
  fetchedAt: '2026-10-31T00:00:00.000Z',
  hash: 'h',
  truncated: false,
});

/** `rows` rows of `columns` numeric columns whose names are `nameLength` characters long. */
function table(
  rows: number,
  columns: number,
  nameLength: number,
  value: (r: number) => unknown = (r) => r % 10,
) {
  const cols = Array.from({ length: columns }, (_, i) => ({
    name: `c${i}_${'n'.repeat(nameLength)}`,
    type: 'number' as const,
  }));
  return {
    columns: cols,
    rows: Array.from({ length: rows }, (_, r) => Object.fromEntries(cols.map((c) => [c.name, value(r)]))),
  } as DataTable;
}

const text = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString();

async function read(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString();
    chunks.push(value);
  }
}

const budget = (maxBytes = 1_000_000) =>
  new ByteBudget({
    maxBytes,
    maxBytesPerClient: maxBytes,
    maxQueue: 4,
    maxQueuedPerClient: 4,
    maxWaitMs: 200,
    retryAfterSec: 3,
  });

describe('ResultWire', () => {
  it('sends long column names once with rows as arrays, and refuses them as objects with a clear error', async () => {
    const wire = new ResultWire();
    // 10,000 rows, 20 columns of 100-character names: 22 MB as objects, as in the attack that ran out of memory.
    const big = result(table(10_000, 20, 100));
    const objects = await wire.dataBody(big, 'objects');
    const refused = JSON.parse(text(objects.chunks));
    expect(objects.bytes).toBeLessThan(10_000);
    expect(refused.table.rows).toEqual([]);
    expect(refused.table.columns).toHaveLength(20);
    expect(refused.error).toMatch(/too large to send: about 2\d(\.\d)? MB as JSON, more than the 4 MB/);
    expect(refused.error).toMatch(/limit rows.*aggregate.*select only the columns/);

    const arrays = await wire.dataBody(big, 'arrays');
    const sent = JSON.parse(text(arrays.chunks));
    expect(arrays.bytes).toBeLessThan(MAX_RESULT_BYTES / 4);
    expect(sent.table.rows).toHaveLength(10_000);
    expect(sent.table.rows[3]).toEqual(Array(20).fill(3));
    expect(sent).toMatchObject({ datasetId: 'd', hash: 'h', truncated: false });
    arrays.release();
  });

  it('counts escapes and multi-byte text exactly, not by the estimate', async () => {
    const wire = new ResultWire({ maxBytes: 100_000 });
    // 30,000 characters of estimate, about 6 bytes each once escaped.
    const quotes = result(table(30, 1, 1, () => '\u0001'.repeat(1000)));
    const body = JSON.parse(text((await wire.dataBody(quotes, 'arrays')).chunks));
    expect(body.error).toMatch(/too large to send/);
  });

  it('serialises a result once and shares the bytes between readers and live subscribers', async () => {
    const wire = new ResultWire();
    const shared = result(table(5_000, 5, 5));
    const a = await wire.dataBody(shared, 'arrays');
    const b = await wire.dataBody({ ...shared }, 'arrays');
    expect(a.chunks[1]).toBe(b.chunks[1]);
    expect(wire.budget.stats().bodies).toBe(1);
    a.release();
    b.release();
    expect(wire.budget.stats()).toMatchObject({ bytes: 0, bodies: 0 });

    const event: LiveEvent = { type: 'data', result: shared };
    const frame = wire.frame(event, 'arrays');
    expect(wire.frame(event, 'arrays')).toBe(frame);
    const sse = Buffer.from(frame).toString();
    expect(sse.startsWith('event: message\ndata: {"type":"data","result":{')).toBe(true);
    expect(sse.endsWith('}}\n\n')).toBe(true);
    expect(JSON.parse(sse.slice('event: message\ndata: '.length)).result.table.rows).toHaveLength(5_000);
    // Objects are a separate serialisation, still shared among those who ask for them.
    expect(wire.frame(event, 'objects')).not.toBe(frame);
    expect(wire.frame(event, 'objects')).toBe(wire.frame(event, 'objects'));
  });

  it('pushes a too large result as its error instead of the rows', () => {
    const wire = new ResultWire();
    const frame = Buffer.from(
      wire.frame({ type: 'data', result: result(table(10_000, 20, 100)) }, 'objects'),
    );
    expect(frame.byteLength).toBeLessThan(10_000);
    expect(JSON.parse(frame.toString().slice('event: message\ndata: '.length)).result.error).toMatch(
      /too large/,
    );
  });

  it('holds the budget until the body has been read, or the reader went away', async () => {
    const wire = new ResultWire();
    const body = await wire.dataBody(result(table(20_000, 3, 3)), 'arrays');
    expect(body.bytes).toBeGreaterThan(64 * 1024);
    expect(wire.budget.stats().bodies).toBe(1);
    const json = JSON.parse(await read(streamBody(body)));
    expect(json.table.rows).toHaveLength(20_000);
    expect(wire.budget.stats().bodies).toBe(0);

    const again = await wire.dataBody(result(table(20_000, 3, 4)), 'arrays');
    const reader = streamBody(again).getReader();
    await reader.read();
    expect(wire.budget.stats().bodies).toBe(1);
    await reader.cancel();
    expect(wire.budget.stats().bodies).toBe(0);
  });

  it('makes concurrent large reads of different results wait, then answers busy', async () => {
    const wire = new ResultWire({ budget: budget(1_000_000) });
    const results = Array.from({ length: 4 }, (_, i) => result(table(100_000, 1, 1, () => i)));
    const first = await wire.dataBody(results[0]!, 'arrays');
    const second = await wire.dataBody(results[1]!, 'arrays');
    expect(first.bytes + second.bytes).toBeGreaterThan(750_000);
    // The third does not fit next to them: it waits until one has been read.
    const third = wire.dataBody(results[2]!, 'arrays');
    let started = false;
    void third.then(() => {
      started = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    // Another reader of a body already on its way costs nothing and does not wait.
    (await wire.dataBody(results[0]!, 'arrays')).release();
    first.release();
    const running = await third;
    // Nobody gives room back now: the fourth gives up and says when to try again.
    const fourth = await wire.dataBody(results[3]!, 'arrays').catch((e) => e);
    expect(fourth).toBeInstanceOf(BusyError);
    expect(fourth.retryAfterSec).toBe(3);
    second.release();
    running.release();
    expect(wire.budget.stats()).toEqual({ bytes: 0, bodies: 0, waiting: 0, waitingBytes: 0 });
  });
});

describe('ByteBudget', () => {
  it('counts a body many readers share once', async () => {
    const b = budget(100);
    const releases = await Promise.all(Array.from({ length: 50 }, () => b.acquire('ip:a', 'k', 80)));
    expect(b.stats()).toEqual({ bytes: 80, bodies: 1, waiting: 0, waitingBytes: 0 });
    for (const r of releases) r();
    expect(b.stats().bytes).toBe(0);
  });

  it('refuses at once when the queue is full, and keeps one client to its share', async () => {
    const b = new ByteBudget({
      maxBytes: 100,
      maxBytesPerClient: 60,
      maxQueue: 2,
      maxQueuedPerClient: 1,
      maxWaitMs: 1_000,
      retryAfterSec: 1,
    });
    const mine = await b.acquire('ip:a', 'a1', 50);
    // Over its own share, the client waits, and may not queue more; other clients still get in.
    const waiting = b.acquire('ip:a', 'a2', 20);
    await expect(b.acquire('ip:a', 'a3', 20)).rejects.toBeInstanceOf(BusyError);
    const other = await b.acquire('ip:b', 'b1', 40);
    (await b.acquire('ip:c', 'c1', 10))();
    // The total is full: the next one queues, and with the queue full the one after that is refused at once.
    const queued = b.acquire('ip:d', 'd1', 30);
    await expect(b.acquire('ip:e', 'e1', 1)).rejects.toBeInstanceOf(BusyError);
    mine();
    other();
    (await queued)();
    (await waiting)();
  });

  it('bounds the bytes waiting, not only the number of waiters', async () => {
    const b = new ByteBudget({
      maxBytes: 100,
      maxBytesPerClient: 100,
      maxQueue: 10,
      maxQueuedPerClient: 10,
      maxQueuedBytes: 50,
      maxWaitMs: 1_000,
      retryAfterSec: 1,
    });
    const full = await b.acquire('ip:a', 'a', 100);
    // Waiting bodies are built already: 30 + 20 fit the waiting room, the next byte does not.
    const first = b.acquire('ip:b', 'b', 30);
    const second = b.acquire('ip:c', 'c', 20);
    await expect(b.acquire('ip:d', 'd', 1)).rejects.toBeInstanceOf(BusyError);
    expect(b.stats().waitingBytes).toBe(50);
    full();
    (await first)();
    (await second)();
    expect(b.stats()).toEqual({ bytes: 0, bodies: 0, waiting: 0, waitingBytes: 0 });
  });

  it('runs inside the request client', async () => {
    const wire = new ResultWire({ budget: budget(1_000_000) });
    const r = result(table(100_000, 1, 1));
    const a = await runAsClient('ip:a', () => wire.dataBody(r, 'arrays'));
    a.release();
    expect(wire.budget.stats().bytes).toBe(0);
  });
});
