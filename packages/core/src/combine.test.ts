import { describe, expect, it } from 'vitest';
import { type DataTable, inferTable } from './table.ts';
import {
  joinedColumns,
  PIPELINE_LIMITS,
  type PipelineInputs,
  runPipeline,
  type Transform,
  TransformSchema,
  unionColumns,
} from './transforms.ts';

const steps = (list: unknown[]) => list.map((s) => TransformSchema.parse(s)) as Transform[];
const inputs = (
  tables: Record<string, DataTable>,
  self = { id: 'orders', name: 'Orders' },
): PipelineInputs => ({
  tables: Object.fromEntries(
    Object.entries(tables).map(([id, table]) => [
      id,
      { name: `${id[0]!.toUpperCase()}${id.slice(1)}`, table },
    ]),
  ),
  self,
});

const orders = inferTable([
  { id: 1, country: 'SK', total: 10 },
  { id: 2, country: 'CZ', total: 20 },
  { id: 3, country: 'XX', total: 5 },
  { id: 4, country: null, total: 7 },
]);
const countries = inferTable([
  { country: 'SK', region: 'Central', total: 99 },
  { country: 'CZ', region: 'Central', total: 98 },
]);

describe('join', () => {
  it('defaults to a left join, keeps rows without a match and suffixes clashing columns', () => {
    const step = TransformSchema.parse({ type: 'join', with: 'countries', on: ['country'] });
    expect(step).toMatchObject({ how: 'left' });
    const { table } = runPipeline(orders, [step as Transform], inputs({ countries }));
    expect(table.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'id:number',
      'country:string',
      'total:number',
      'region:string',
      'total_countries:number',
    ]);
    expect(table.rows).toEqual([
      { id: 1, country: 'SK', total: 10, region: 'Central', total_countries: 99 },
      { id: 2, country: 'CZ', total: 20, region: 'Central', total_countries: 98 },
      { id: 3, country: 'XX', total: 5, region: null, total_countries: null },
      // A null key never matches, as in SQL: nulls are unknown values, not a shared value.
      { id: 4, country: null, total: 7, region: null, total_countries: null },
    ]);
  });

  it('keeps only matching rows when inner, and only the asked fields', () => {
    const { table } = runPipeline(
      orders,
      steps([{ type: 'join', with: 'countries', on: ['country'], how: 'inner', fields: ['region'] }]),
      inputs({ countries }),
    );
    expect(table.rows).toEqual([
      { id: 1, country: 'SK', total: 10, region: 'Central' },
      { id: 2, country: 'CZ', total: 20, region: 'Central' },
    ]);
  });

  it('matches on several keys with different names on each side', () => {
    const sales = inferTable([
      { code: 'SK', year: 2025, sales: 5 },
      { code: 'SK', year: 2026, sales: 6 },
    ]);
    const population = inferTable([
      { iso: 'SK', year: 2025, people: 5.4 },
      { iso: 'SK', year: 2026, people: 5.3 },
    ]);
    const { table } = runPipeline(
      sales,
      steps([{ type: 'join', with: 'population', on: [{ left: 'code', right: 'iso' }, 'year'] }]),
      inputs({ population }),
    );
    expect(table.rows).toEqual([
      { code: 'SK', year: 2025, sales: 5, people: 5.4 },
      { code: 'SK', year: 2026, sales: 6, people: 5.3 },
    ]);
  });

  it('produces one row per match when a key repeats on the other side', () => {
    const two = inferTable([
      { country: 'SK', region: 'Central' },
      { country: 'SK', region: 'Danube' },
    ]);
    const { table } = runPipeline(
      orders,
      steps([{ type: 'join', with: 'regions', on: ['country'], how: 'inner' }]),
      inputs({ regions: two }),
    );
    expect(table.rows.map((r) => r.region)).toEqual(['Central', 'Danube']);
  });

  it('refuses keys of different types and says how to convert one side', () => {
    const sales = inferTable([{ year: 2025, sales: 1 }]);
    const population = inferTable([{ year: '2025', people: 5 }], { types: { year: 'string' } });
    expect(() =>
      runPipeline(sales, steps([{ type: 'join', with: 'population', on: ['year'] }]), inputs({ population })),
    ).toThrow(
      'Step 1: Key "year" is a number here and text in "population"; convert one side with derive number(year)',
    );
  });

  it('matches a time column with a text date once the text is converted with date()', () => {
    const day = Date.UTC(2026, 10, 1);
    const weather = inferTable([{ day, temp: 7 }], { types: { day: 'time' } });
    const visitsText = inferTable([{ day: '2026-11-01', visits: 120 }], { types: { day: 'string' } });
    expect(() =>
      runPipeline(
        weather,
        steps([{ type: 'join', with: 'visits', on: ['day'] }]),
        inputs({ visits: visitsText }),
      ),
    ).toThrow(
      'Step 1: Key "day" is a time here and text in "visits"; convert one side with derive date(day)',
    );
    // What the user does next, on the visits dataset: the converted column is a number, which matches a time.
    const visits = runPipeline(visitsText, steps([{ type: 'derive', as: 'day', expr: 'date(day)' }])).table;
    const { table } = runPipeline(
      weather,
      steps([{ type: 'join', with: 'visits', on: ['day'] }]),
      inputs({ visits }),
    );
    expect(table.rows).toEqual([{ day, temp: 7, visits: 120 }]);
    expect(table.columns.find((c) => c.name === 'day')?.type).toBe('time');
  });

  it('fails instead of truncating when the output passes maxRows', () => {
    expect(PIPELINE_LIMITS.maxRows).toBe(100_000);
    const left = inferTable(Array.from({ length: 300 }, (_, i) => ({ k: 1, i })));
    const right = inferTable(Array.from({ length: 400 }, (_, j) => ({ k: 1, j })));
    expect(() =>
      runPipeline(left, steps([{ type: 'join', with: 'right', on: ['k'] }]), inputs({ right })),
    ).toThrow(
      'Step 1: The join produced more than 100,000 rows: the keys repeat on both sides. Aggregate one side first.',
    );
  });

  it('names the problem when the other dataset or its column is missing', () => {
    expect(() => runPipeline(orders, steps([{ type: 'join', with: 'countries', on: ['country'] }]))).toThrow(
      'Step 1: Steps that read other datasets (join, union) only run inside their dashboard',
    );
    expect(() =>
      runPipeline(
        orders,
        steps([{ type: 'join', with: 'constructor', on: ['country'] }]),
        inputs({ countries }),
      ),
    ).toThrow('Step 1: Dataset "constructor" is not available here');
    expect(() =>
      runPipeline(orders, steps([{ type: 'join', with: 'countries', on: ['id'] }]), inputs({ countries })),
    ).toThrow('Step 1: Unknown column "id" in "countries". Available: country, region, total');
  });

  it('limits keys and fields in the schema', () => {
    expect(TransformSchema.safeParse({ type: 'join', with: 'x', on: [] }).success).toBe(false);
    expect(
      TransformSchema.safeParse({ type: 'join', with: 'x', on: ['a', 'b', 'c', 'd', 'e'] }).success,
    ).toBe(false);
    expect(TransformSchema.safeParse({ type: 'join', with: 'Not An Id', on: ['a'] }).success).toBe(false);
  });
});

describe('union', () => {
  const ba = inferTable([{ time: 1, temp: 12, wind: 3 }], { types: { time: 'time' } });
  const brno = inferTable([{ time: 1, temp: 10 }], { types: { time: 'time' } });
  const self = { id: 'ba', name: 'Bratislava' };

  it('appends rows by column name and names their origin', () => {
    const { table } = runPipeline(
      ba,
      steps([{ type: 'union', with: ['brno'], origin: 'city' }]),
      inputs({ brno }, self),
    );
    expect(table.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'time:time',
      'temp:number',
      'wind:number',
      'city:string',
    ]);
    expect(table.rows).toEqual([
      { time: 1, temp: 12, wind: 3, city: 'Bratislava' },
      { time: 1, temp: 10, wind: null, city: 'Brno' },
    ]);
  });

  it('uses explicit labels by dataset id, and no origin column without origin', () => {
    const labelled = runPipeline(
      ba,
      steps([{ type: 'union', with: ['brno'], origin: 'city', labels: { ba: 'BA', brno: 'BRN' } }]),
      inputs({ brno }, self),
    ).table;
    expect(labelled.rows.map((r) => r.city)).toEqual(['BA', 'BRN']);
    const plain = runPipeline(ba, steps([{ type: 'union', with: ['brno'] }]), inputs({ brno }, self)).table;
    expect(plain.columns.map((c) => c.name)).toEqual(['time', 'temp', 'wind']);
  });

  it('turns conflicting types into text, writing times as ISO dates so date() reads them back', () => {
    const text = inferTable([{ time: '2026-11-01', temp: 'n/a' }], {
      types: { time: 'string', temp: 'string' },
    });
    const { table } = runPipeline(ba, steps([{ type: 'union', with: ['text'] }]), inputs({ text }, self));
    expect(table.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'time:string',
      'temp:string',
      'wind:number',
    ]);
    expect(table.rows[0]!.time).toBe('1970-01-01T00:00:00.001Z');
    expect(table.rows[1]!.time).toBe('2026-11-01');
  });

  it('refuses an origin column that already exists, and more than maxRows rows', () => {
    expect(() =>
      runPipeline(ba, steps([{ type: 'union', with: ['brno'], origin: 'temp' }]), inputs({ brno }, self)),
    ).toThrow('Step 1: Column "temp" already exists; name the origin column differently');
    const big = inferTable(Array.from({ length: 60_000 }, (_, i) => ({ i })));
    expect(() =>
      runPipeline(big, steps([{ type: 'union', with: ['other'] }]), inputs({ other: big }, self)),
    ).toThrow('Step 1: The union produced more than 100,000 rows; filter or aggregate the datasets first.');
  });

  it('accepts one to four datasets', () => {
    expect(TransformSchema.safeParse({ type: 'union', with: [] }).success).toBe(false);
    expect(TransformSchema.safeParse({ type: 'union', with: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
  });
});

describe('column helpers', () => {
  it('lists joined and unioned columns the way the steps build them', () => {
    expect(
      joinedColumns(['id', 'country', 'total'], ['country', 'region', 'total'], {
        with: 'c',
        on: ['country'],
      }),
    ).toEqual([
      { name: 'region', from: 'region' },
      { name: 'total_c', from: 'total' },
    ]);
    expect(
      unionColumns(
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        'src',
      ),
    ).toEqual(['a', 'b', 'c', 'src']);
  });
});
