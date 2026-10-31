import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compile,
  ExprError,
  inferTable,
  MAX_STRING,
  PIPELINE_LIMITS,
  runPipeline,
  TransformError,
  type TransformInput,
  TransformSchema,
  tableSize,
} from './index.ts';

const steps = (list: TransformInput[]) => list.map((s) => TransformSchema.parse(s));
const text = (n: number) => 'A'.repeat(n);

/** Runs a pipeline expected to fail and reports how it failed. */
function failure(run: () => unknown) {
  const startedAt = Date.now();
  try {
    run();
  } catch (e) {
    return { error: e as Error, ms: Date.now() - startedAt };
  }
  throw new Error('Expected the pipeline to fail');
}

describe('pipeline size limit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops many derive steps of long text quickly, before the table reaches gigabytes', () => {
    // Few cells (2,000 rows x 41 columns) but, uncapped, close to a gigabyte of text: this used to kill the process.
    const half = Math.floor(MAX_STRING / 2) - 5;
    const input = inferTable(Array.from({ length: 2000 }, () => ({ x: text(half) })));
    const attack = steps([
      { type: 'derive', as: 'c0', expr: 'concat(x, x)' },
      ...Array.from({ length: 39 }, (_, i) => ({
        type: 'derive' as const,
        as: `c${i + 1}`,
        expr: `concat(c0, "${i + 1}")`,
      })),
    ]);
    const { error, ms } = failure(() => runPipeline(input, attack));
    expect(error).toBeInstanceOf(TransformError);
    expect(error.message).toMatch(/grew past 20 million characters/);
    expect(error.message).toMatch(/substr\(\)/);
    // Stops within the first few steps, long before 40 steps of 4 million characters each.
    expect((error as TransformError).step).toBeLessThan(10);
    expect(ms).toBeLessThan(1000);
  });

  it('counts values copied by reference too, since each copy is repeated in the JSON', () => {
    const input = inferTable(Array.from({ length: 1000 }, () => ({ x: text(MAX_STRING) })));
    const copies = steps(Array.from({ length: 40 }, (_, i) => ({ type: 'derive', as: `c${i}`, expr: 'x' })));
    expect(() => runPipeline(input, copies)).toThrow(/Step \d+: The data grew past/);
  });

  it('refuses a source that is already over the limit', () => {
    const input = inferTable(Array.from({ length: 2000 }, () => ({ x: text(11_000) })));
    expect(tableSize(input)).toBeGreaterThan(PIPELINE_LIMITS.maxSize);
    expect(() => runPipeline(input, steps([{ type: 'limit', n: 10 }]))).toThrow(
      /Step 1: The source data is larger than 20 million characters/,
    );
    // Without steps nothing is processed, so nothing is refused.
    expect(runPipeline(input, []).table).toBe(input);
  });

  it('charges aggregate metrics one by one', () => {
    const input = inferTable(Array.from({ length: 2000 }, (_, i) => ({ id: i, note: text(500) })));
    const metrics = Array.from({ length: 1000 }, (_, i) => ({
      op: 'first' as const,
      field: 'note',
      as: `m${i}`,
    }));
    const { error, ms } = failure(() =>
      runPipeline(input, steps([{ type: 'aggregate', groupBy: ['id'], metrics }])),
    );
    expect(error.message).toMatch(/Step 1: The data grew past/);
    expect(ms).toBeLessThan(1000);
  });

  it('charges a long fillNull value for every row it fills', () => {
    const input = inferTable(Array.from({ length: 20_000 }, (_, i) => ({ id: i, v: null })));
    const fill = steps([{ type: 'fillNull', fields: ['v'], value: text(5000) }]);
    expect(() => runPipeline(input, fill)).toThrow(/grew past/);
  });

  it('measures shrinking steps, so later steps get the room back', () => {
    // 18 million characters in: one more long column would not fit, but after a limit it does.
    const input = inferTable(Array.from({ length: 9000 }, (_, i) => ({ id: i, x: text(MAX_STRING) })));
    expect(() => runPipeline(input, steps([{ type: 'derive', as: 'y', expr: 'x' }]))).toThrow(/grew past/);
    const { table } = runPipeline(
      input,
      steps([
        { type: 'filter', expr: 'id < 100' },
        { type: 'derive', as: 'y', expr: 'concat(substr(x, 0, 10), "!")' },
      ]),
    );
    expect(table.rows).toHaveLength(100);
    expect(table.rows[0]!.y).toBe('AAAAAAAAAA!');
  });

  it('leaves realistic pipelines alone', () => {
    // 100,000 rows like a large upload: a number, a time, a short category and a few derived columns.
    const input = inferTable(
      Array.from({ length: 100_000 }, (_, i) => ({
        time: 1_700_000_000_000 + i * 60_000,
        city: `City ${i % 50}`,
        temp: (i % 400) / 10,
        rain: i % 7,
      })),
    );
    const { table } = runPipeline(
      input,
      steps([
        { type: 'derive', as: 'label', expr: 'concat(city, ": ", string(round(temp, 1)), " °C")' },
        { type: 'derive', as: 'wet', expr: 'rain > 3' },
        { type: 'sort', by: [{ field: 'time', dir: 'desc' }] },
        { type: 'window', op: 'rolling_avg', field: 'temp', size: 24, partitionBy: ['city'] },
        { type: 'timeBucket', field: 'time', unit: 'day', as: 'day' },
        {
          type: 'aggregate',
          groupBy: ['day', 'city'],
          metrics: [
            { op: 'avg', field: 'temp' },
            { op: 'sum', field: 'rain' },
          ],
        },
      ]),
    );
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it('stops a single slow step at the time limit instead of finishing it', () => {
    const input = inferTable(Array.from({ length: 10_000 }, (_, i) => ({ v: i })));
    let now = 0;
    // Every clock reading jumps 10 ms ahead, so the deadline passes partway through the first step.
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
    const { error } = failure(() => runPipeline(input, steps([{ type: 'derive', as: 'w', expr: 'v * 2' }])));
    expect(error.message).toMatch(/Step 1: Processing took longer than 3 s/);
  });
});

describe('text limits in expressions', () => {
  it('refuses text over the limit before building it', () => {
    const long = text(MAX_STRING - 10);
    expect(() => compile('concat(x, x, x, x, x, x, x, x)')({ x: long })).toThrow(ExprError);
    expect(() => compile('x + x')({ x: long })).toThrow(/limited to 2,000 characters/);
    expect(compile('concat(x, "0123456789")')({ x: long })).toHaveLength(MAX_STRING);
    expect(compile('concat(a, " ", b)')({ a: 'Hello', b: 'world' })).toBe('Hello world');
  });

  it('parses dates as before but skips text far longer than any date', () => {
    expect(compile('date(s)')({ s: '2026-10-31T12:00:00Z' })).toBe(Date.UTC(2026, 9, 31, 12));
    expect(
      compile('year(s)')({ s: 'Sat Oct 31 2026 12:00:00 GMT+0100 (Central European Standard Time)' }),
    ).toBe(2026);
    expect(compile('date(s)')({ s: `2026-10-31${' '.repeat(5000)}` })).toBeNull();
  });
});
