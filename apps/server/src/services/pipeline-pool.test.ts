import { inferTable, runPipeline, type Transform, TransformSchema } from '@patchbay/core';
import { afterAll, describe, expect, it } from 'vitest';
import { runAsClient } from '../util/request-context.ts';
import { runsInline, WorkerPool } from './pipeline-pool.ts';
import { UploadError } from './upload-parse.ts';

const steps = (list: unknown[]) => list.map((s) => TransformSchema.parse(s)) as Transform[];

const big = inferTable(
  Array.from({ length: 60_000 }, (_, i) => ({
    a: (i * 7919) % 10_007,
    b: (i * 104_729) % 977,
    g: `g${i % 13}`,
  })),
);
const medium = inferTable(Array.from({ length: 2000 }, (_, i) => ({ a: i })));
const heavy = steps([
  ...Array.from({ length: 12 }, (_, k) => ({
    type: 'derive',
    as: `d${k}`,
    expr: `round(sqrt(a * b + ${k}) + log(a + 1), 3)`,
  })),
  { type: 'aggregate', groupBy: ['g'], metrics: [{ op: 'avg', field: 'd11', as: 'avg' }, { op: 'count' }] },
  { type: 'sort', by: [{ field: 'g' }] },
]);

describe('worker pool', () => {
  const pool = new WorkerPool({ size: 2, timeoutMs: 20_000, inlineBelowCells: 1000 });
  afterAll(() => pool.close());

  it('computes exactly what the inline pipeline computes', async () => {
    const viaWorker = await pool.run(big, heavy);
    expect(viaWorker).toEqual(runPipeline(big, heavy));
  });

  it('keeps the main thread responsive during heavy processing', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    await Promise.all([pool.run(big, heavy), pool.run(big, heavy)]);
    const elapsed = Date.now() - started;
    clearInterval(timer);
    // If the work ran on this thread, the interval could not fire at all meanwhile.
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 10 / 4));
  });

  it('reports pipeline errors without losing the worker', async () => {
    await expect(pool.run(big, steps([{ type: 'select', fields: ['nope'] }]))).rejects.toThrow(
      /Unknown column "nope"/,
    );
    expect((await pool.run(big, steps([{ type: 'limit', n: 3 }]))).table.rows).toHaveLength(3);
  });

  it('stops a job that runs too long and replaces the worker', async () => {
    const strict = new WorkerPool({ size: 1, timeoutMs: 30, inlineBelowCells: 1000 });
    await expect(strict.run(big, heavy)).rejects.toThrow(/longer than/);
    expect(strict.busy()).toBe(0);
    // The replacement worker serves the next (small) job. The limit includes copying
    // the table to the worker, so this one is kept well below it.
    expect((await strict.run(medium, steps([{ type: 'limit', n: 2 }]))).table.rows).toHaveLength(2);
    await strict.close();
  });

  it('runs small inputs inline and rejects work beyond the queue limit', async () => {
    const tiny = inferTable([{ a: 1 }, { a: 2 }]);
    expect((await pool.run(tiny, steps([{ type: 'filter', expr: 'a > 1' }]))).table.rows).toEqual([{ a: 2 }]);
    const busy = new WorkerPool({ size: 1, timeoutMs: 20_000, inlineBelowCells: 1000, maxQueue: 1 });
    await busy.run(medium, steps([{ type: 'limit', n: 1 }])); // warm up: worker started
    // One job runs, one waits in the queue, the third is turned away.
    const results = await Promise.allSettled([
      busy.run(big, heavy),
      busy.run(big, heavy),
      busy.run(big, heavy),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await busy.close();
  });
});

describe('worker pool guards', () => {
  it('sends expression and window steps to a worker even for tiny inputs', () => {
    const tiny = inferTable([{ a: 1 }]);
    expect(runsInline(tiny, steps([{ type: 'limit', n: 1 }]), 20_000)).toBe(true);
    expect(runsInline(tiny, steps([{ type: 'derive', as: 'b', expr: 'a + 1' }]), 20_000)).toBe(false);
    expect(runsInline(tiny, steps([{ type: 'filter', expr: 'a > 0' }]), 20_000)).toBe(false);
    expect(runsInline(tiny, steps([{ type: 'window', op: 'cumsum', field: 'a' }]), 20_000)).toBe(false);
    const many = steps(Array.from({ length: 5 }, () => ({ type: 'limit', n: 1 })));
    expect(runsInline(tiny, many, 20_000)).toBe(false);
    expect(runsInline(big, steps([{ type: 'limit', n: 1 }]), 20_000)).toBe(false);
  });

  it('lets one client hold only its share of the queue, and serves clients in turn', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 20_000, inlineBelowCells: 1, maxQueuedPerClient: 2 });
    try {
      await pool.run(medium, steps([{ type: 'limit', n: 1 }])); // worker started
      const order: string[] = [];
      const job = (client: string) =>
        runAsClient(client, () => pool.run(big, heavy)).then(
          () => order.push(client),
          (e: Error) => order.push(`${client}:${e.constructor.name}`),
        );
      // The first job of "a" runs at once and two more wait; the fourth is over its share.
      const fromA = [job('a'), job('a'), job('a'), job('a')];
      const fromB = job('b');
      await Promise.all([...fromA, fromB]);
      expect(order.filter((o) => o === 'a:BusyError')).toHaveLength(1);
      // "b" was queued after two waiting jobs of "a", yet ran before the last of them.
      expect(order.indexOf('b')).toBeLessThan(order.lastIndexOf('a'));
    } finally {
      await pool.close();
    }
  });

  it('fails a job that exceeds the worker heap limit without losing the pool', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 20_000, inlineBelowCells: 1, workerMemoryMb: 32 });
    try {
      const text = inferTable(Array.from({ length: 200 }, () => ({ s0: 'x'.repeat(1000) })));
      const doubling = steps(
        Array.from({ length: 24 }, (_, i) => ({
          type: 'derive',
          as: `s${i + 1}`,
          expr: `concat(s${i}, s${i})`,
        })),
      );
      await expect(pool.run(text, doubling)).rejects.toThrow();
      expect((await pool.run(medium, steps([{ type: 'limit', n: 2 }]))).table.rows).toHaveLength(2);
    } finally {
      await pool.close();
    }
  });

  it('parses uploads in a worker, with the uploader-facing errors intact', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 20_000 });
    try {
      const table = await pool.parseUpload({ content: 'a,b\n1,x\n2,y\n', format: 'csv', maxCells: 100 });
      expect(table.rows).toEqual([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ]);
      const err = await pool
        .parseUpload({ content: `a,b\n${'1,2\n'.repeat(100)}`, format: 'csv', maxCells: 50 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadError);
      expect((err as UploadError).tooLarge).toBe(true);
    } finally {
      await pool.close();
    }
  });
});
