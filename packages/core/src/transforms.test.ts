import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compile,
  type DataTable,
  ExprError,
  inferTable,
  MAX_STRING,
  PIPELINE_LIMITS,
  type PipelineInputs,
  runPipeline,
  StatusConfigSchema,
  statusModel,
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

describe('rename', () => {
  const t = inferTable([{ a: 1, b: 'x' }]);
  it('refuses a rename onto an existing column', () => {
    expect(() => runPipeline(t, steps([{ type: 'rename', map: { a: 'b' } }]))).toThrow(
      /Step 1: Column "b" already exists/,
    );
  });
  it('refuses two columns renamed to one name', () => {
    expect(() => runPipeline(t, steps([{ type: 'rename', map: { a: 'x', b: 'x' } }]))).toThrow(
      'Columns "a" and "b" would both be named "x"; pick another name',
    );
    expect(() => runPipeline(t, steps([{ type: 'rename', map: { a: 'b' } }]))).toThrow(
      'Column "b" already exists; rename it too or pick another name',
    );
  });
  it('allows a swap', () => {
    const out = runPipeline(t, steps([{ type: 'rename', map: { a: 'b', b: 'a' } }])).table;
    expect(out.columns.map((c) => c.name)).toEqual(['b', 'a']);
    expect(out.rows[0]).toEqual({ b: 1, a: 'x' });
  });
});

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
    // The early stop is proven by the step number above; this bound only catches running all the steps.
    expect(ms).toBeLessThan(10_000);
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
    expect(ms).toBeLessThan(10_000);
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

  it('stops the whole-table values of an expression at the time limit, before any row is evaluated', () => {
    const columns = ['a', 'b', 'c', 'd', 'e'];
    const input = inferTable([Object.fromEntries(columns.map((c, i) => [c, i]))]);
    const fns = ['col_sum', 'col_avg', 'col_min', 'col_max', 'col_median', 'col_stddev', 'col_count'];
    const calls = fns.flatMap((fn) => columns.map((c) => `${fn}(${c})`));
    let now = 0;
    // One row, so only computing the 35 different whole-table values can use up the 3 s.
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 100));
    const { error } = failure(() =>
      runPipeline(input, steps([{ type: 'filter', expr: `${calls.join(' + ')} > 0` }])),
    );
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

describe('a source that returned no rows', () => {
  // An open-incidents endpoint answers { "incidents": [] } most of the time: no rows, so no columns to check.
  const empty = inferTable([]);
  const incidents = inferTable([
    { name: 'API errors', status: 'investigating', impact: 'minor', created_at: '2026-11-12T08:00:00Z' },
  ]);
  const wall = steps([
    { type: 'filter', expr: 'status != "resolved"' },
    { type: 'derive', as: 'service', expr: '"GitHub"' },
    { type: 'derive', as: 'detail', expr: 'name' },
    { type: 'derive', as: 'since', expr: 'created_at' },
    { type: 'sort', by: [{ field: 'created_at', dir: 'desc' }] },
    { type: 'select', fields: ['service', 'detail', 'since', 'impact'] },
  ]);
  const inputs = (tables: Record<string, DataTable>): PipelineInputs => ({
    tables: Object.fromEntries(Object.entries(tables).map(([id, table]) => [id, { name: id, table }])),
    self: { id: 'self', name: 'Self' },
  });

  it('runs steps that read columns it does not have, and names them in the trace', () => {
    const { table, trace } = runPipeline(empty, wall);
    expect(table.rows).toEqual([]);
    expect(table.columns.map((c) => c.name)).toEqual(['service', 'detail', 'since', 'impact']);
    expect(trace.map((s) => s.unchecked ?? [])).toEqual([
      ['status'],
      [],
      ['name'],
      ['created_at'],
      ['created_at'],
      ['impact'],
    ]);
  });

  it('checks the same steps as strictly as before once the source has rows', () => {
    expect(runPipeline(incidents, wall).table.rows).toHaveLength(1);
    expect(runPipeline(incidents, wall).trace.every((s) => s.unchecked === undefined)).toBe(true);
    expect(() => runPipeline(incidents, steps([{ type: 'derive', as: 'link', expr: 'shortlink' }]))).toThrow(
      'Step 1: Unknown column "shortlink". Available: name, status, impact, created_at',
    );
  });

  it('keeps checking after a filter leaves no rows, because the columns are known', () => {
    expect(() =>
      runPipeline(
        incidents,
        steps([
          { type: 'filter', expr: 'status == "resolved"' },
          { type: 'derive', as: 'detail', expr: 'nmae' },
        ]),
      ),
    ).toThrow('Step 2: Unknown column "nmae"');
  });

  it('keeps checking in a dataset that reads one a filter emptied, and passes openness on from an empty source', () => {
    const emptied = runPipeline(incidents, steps([{ type: 'filter', expr: 'status == "resolved"' }]));
    expect(emptied.open).toBeUndefined();
    expect(() =>
      runPipeline(emptied.table, steps([{ type: 'derive', as: 'detail', expr: 'nmae' }]), undefined, {
        open: false,
      }),
    ).toThrow('Step 1: Unknown column "nmae"');
    const fromEmpty = runPipeline(empty, steps([{ type: 'derive', as: 'service', expr: '"GitHub"' }]));
    expect(fromEmpty.open).toBe(true);
    const next = runPipeline(
      fromEmpty.table,
      steps([{ type: 'derive', as: 'detail', expr: 'name' }]),
      undefined,
      {
        open: true,
      },
    );
    expect(next.trace[0]!.unchecked).toEqual(['name']);
    const regions = runPipeline(
      inferTable([{ code: 'SK', region: 'Central' }]),
      steps([{ type: 'filter', expr: 'code == "XX"' }]),
    ).table;
    expect(() =>
      runPipeline(
        inferTable([{ code: 'SK' }]),
        steps([{ type: 'join', with: 'regions', on: ['code'], fields: ['regoin'] }]),
        {
          tables: { regions: { name: 'regions', table: regions, open: false } },
          self: { id: 'self', name: 'Self' },
        },
      ),
    ).toThrow('Unknown column "regoin" in "regions"');
  });

  it('runs a time step and a join on a column made from a column it could not check', () => {
    // retype has no row to look at, so such a column is typed text; its type is a guess, not a mismatch.
    expect(
      runPipeline(
        empty,
        steps([
          { type: 'derive', as: 'since', expr: 'created_at' },
          { type: 'timeBucket', field: 'since', unit: 'day' },
        ]),
      ).table.rows,
    ).toEqual([]);
    const days = inferTable([{ day: '2026-11-12T00:00:00Z', n: 1 }]);
    expect(
      runPipeline(
        empty,
        steps([
          { type: 'derive', as: 'day', expr: 'created_at' },
          { type: 'join', with: 'days', on: ['day'] },
        ]),
        { tables: { days: { name: 'days', table: days } }, self: { id: 'self', name: 'Self' } },
      ).table.rows,
    ).toEqual([]);
  });

  it('runs every step kind that names columns, and counts zero rows as zero', () => {
    for (const step of steps([
      { type: 'rename', map: { a: 'b' } },
      { type: 'fillNull', fields: ['a'], value: 0 },
      { type: 'aggregate', groupBy: ['g'], metrics: [{ op: 'sum', field: 'v', as: 'total' }] },
      { type: 'timeBucket', field: 't', unit: 'day' },
      { type: 'window', op: 'cumsum', field: 'v', partitionBy: ['g'] },
    ])) {
      expect(runPipeline(empty, [step]).table.rows, step.type).toEqual([]);
    }
    const count = runPipeline(
      empty,
      steps([{ type: 'aggregate', groupBy: [], metrics: [{ op: 'count', as: 'n' }] }]),
    );
    expect(count.table.rows).toEqual([{ n: 0 }]);
    // One row now, with known columns: a later typo is an error again.
    expect(() =>
      runPipeline(
        empty,
        steps([
          { type: 'aggregate', groupBy: [], metrics: [{ op: 'count', as: 'n' }] },
          { type: 'derive', as: 'm', expr: 'nn' },
        ]),
      ),
    ).toThrow('Step 2: Unknown column "nn"');
  });

  it('keeps checking once the table had rows, also after a later step empties it again', () => {
    const counted = runPipeline(
      empty,
      steps([
        { type: 'aggregate', groupBy: [], metrics: [{ op: 'count', as: 'n' }] },
        { type: 'filter', expr: 'n > 5' },
      ]),
    );
    expect(counted.table.rows).toEqual([]);
    expect(counted.open).toBeUndefined();
    expect(() =>
      runPipeline(
        empty,
        steps([
          { type: 'aggregate', groupBy: [], metrics: [{ op: 'count', as: 'n' }] },
          { type: 'filter', expr: 'n > 5' },
          { type: 'derive', as: 'm', expr: 'nn' },
        ]),
      ),
    ).toThrow('Step 3: Unknown column "nn"');
    const components = inferTable([{ name: 'API', status: 'operational' }]);
    const unionSteps = steps([
      { type: 'union', with: ['components'] },
      { type: 'filter', expr: 'status != "operational"' },
    ]);
    const united = runPipeline(empty, unionSteps, inputs({ components }));
    expect(united.table.rows).toEqual([]);
    expect(united.open).toBeUndefined();
    expect(() =>
      runPipeline(
        empty,
        [...unionSteps, ...steps([{ type: 'derive', as: 'detail', expr: 'nmae' }])],
        inputs({ components }),
      ),
    ).toThrow('Step 3: Unknown column "nmae"');
  });

  it('joins an empty table, and joins with an empty one, without checking the empty side', () => {
    const regions = inferTable([{ code: 'SK', region: 'Central' }]);
    expect(
      runPipeline(empty, steps([{ type: 'join', with: 'regions', on: ['code'] }]), inputs({ regions })).table
        .rows,
    ).toEqual([]);
    const joined = runPipeline(
      regions,
      steps([{ type: 'join', with: 'none', on: ['code'], fields: ['name'] }]),
      inputs({ none: empty }),
    );
    expect(joined.table.rows).toEqual([{ code: 'SK', region: 'Central', name: null }]);
    expect(joined.trace[0]!.unchecked).toEqual(['none.code', 'none.name']);
  });

  it('keeps a column type in a union when the input that disagrees has no rows', () => {
    const components = inferTable([{ check: 'API', since: '2026-11-12T10:00:00Z' }]);
    const open = runPipeline(empty, steps([{ type: 'select', fields: ['check', 'since'] }])).table;
    const { table } = runPipeline(components, steps([{ type: 'union', with: ['open'] }]), inputs({ open }));
    expect(table.columns.find((c) => c.name === 'since')?.type).toBe('time');
    expect(table.rows[0]!.since).toBe(Date.parse('2026-11-12T10:00:00Z'));
  });
});

describe('derive and time columns', () => {
  const src = inferTable([{ name: 'API', updated_at: '2026-11-12T10:00:00Z', day: '2026-11-12' }]);

  it('makes a time column from a time column, date() or now(), and a number from arithmetic', () => {
    const { table } = runPipeline(
      src,
      steps([
        { type: 'derive', as: 'since', expr: 'updated_at' },
        { type: 'derive', as: 'parsed', expr: 'date(day)' },
        { type: 'derive', as: 'at', expr: 'now()' },
        { type: 'derive', as: 'updated_at', expr: 'updated_at' },
        { type: 'derive', as: 'year', expr: 'year(updated_at)' },
        { type: 'derive', as: 'later', expr: 'updated_at + 1000' },
      ]),
    );
    expect(Object.fromEntries(table.columns.map((c) => [c.name, c.type]))).toMatchObject({
      since: 'time',
      parsed: 'time',
      at: 'time',
      updated_at: 'time',
      year: 'number',
      later: 'number',
    });
  });

  it('makes a time column from epoch seconds with date(t * 1000), and a number from t * 1000 alone', () => {
    const { table } = runPipeline(
      inferTable([{ t: 1794407530 }]),
      steps([
        { type: 'derive', as: 'at', expr: 'date(t * 1000)' },
        { type: 'derive', as: 'ms', expr: 't * 1000' },
      ]),
    );
    expect(Object.fromEntries(table.columns.map((c) => [c.name, c.type]))).toMatchObject({
      at: 'time',
      ms: 'number',
    });
    expect(table.rows[0]!.at).toBe(Date.parse('2026-11-11T14:32:10Z'));
  });

  it('keeps a number for an age, a conditional with a date branch and a rounded value', () => {
    const { table } = runPipeline(
      src,
      steps([
        { type: 'derive', as: 'age', expr: 'now() - updated_at' },
        { type: 'derive', as: 'maybe', expr: 'name == "API" ? date(day) : 0' },
        { type: 'derive', as: 'rounded', expr: 'round(updated_at / 1000)' },
      ]),
    );
    expect(Object.fromEntries(table.columns.map((c) => [c.name, c.type]))).toMatchObject({
      age: 'number',
      maybe: 'number',
      rounded: 'number',
    });
  });

  it('lets a status widget show how long a problem from a derived column has lasted', () => {
    const { table } = runPipeline(
      src,
      steps([
        { type: 'derive', as: 'since', expr: 'updated_at' },
        { type: 'derive', as: 'state', expr: '"warn"' },
      ]),
    );
    const model = statusModel(
      table,
      StatusConfigSchema.parse({ entity: 'name', status: 'state', since: 'since' }),
    );
    expect(model.sections[0]!.tiles[0]!.problems[0]!.since).toBe(Date.parse('2026-11-12T10:00:00Z'));
  });

  it('types date() of a number as a time and keeps the type on a source without rows', () => {
    const numbers = inferTable([{ t: 1_700_000_000 }]);
    const a = runPipeline(numbers, steps([{ type: 'derive', as: 'ms', expr: 'date(t * 1000)' }])).table;
    expect(a.columns.find((c) => c.name === 'ms')?.type).toBe('time');
    const empty = { columns: src.columns, rows: [] };
    const b = runPipeline(
      empty,
      steps([
        { type: 'derive', as: 'since', expr: 'updated_at' },
        { type: 'derive', as: 'parsed', expr: 'date(day)' },
      ]),
    ).table;
    expect(b.columns.find((c) => c.name === 'since')?.type).toBe('time');
    expect(b.columns.find((c) => c.name === 'parsed')?.type).toBe('time');
  });
});
