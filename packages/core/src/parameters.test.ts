import { describe, expect, it } from 'vitest';
import {
  DATE_PRESETS,
  DashboardDocSchema,
  DocumentError,
  defaultText,
  describeParameterValue,
  emptyDashboard,
  isoDay,
  LIMITS,
  type Parameter,
  ParameterSchema,
  parameterSummary,
  parameterText,
  parseDashboard,
  presetRange,
  readParameterValues,
  readRef,
  viewQuery,
  writeParameterValues,
} from './index.ts';

const DAY = 86_400_000;
/** An afternoon in UTC, so a test means the same day on every machine. */
const at = (iso: string) => Date.parse(`${iso}T15:30:00Z`);
const region = ParameterSchema.parse({
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu', label: 'EU' }, { value: 'us', label: 'US' }, { value: 2026 }],
  all: 'All regions',
  default: null,
});
const q = ParameterSchema.parse({ id: 'q', label: 'Search', type: 'text' });
const period = ParameterSchema.parse({
  id: 'period',
  label: 'Period',
  type: 'dateRange',
  presets: ['last7d', 'last30d', 'thisMonth'],
  custom: true,
  min: '2025-01-01',
  maxDays: 90,
  default: 'last30d',
});
const parameters: Parameter[] = [region, q, period];
const read = (raw: Record<string, string>, now = at('2026-11-10')) =>
  readParameterValues(parameters, (id) => (Object.hasOwn(raw, id) ? raw[id] : undefined), now);

describe('filter declarations', () => {
  it('parses the three kinds with their defaults, and keeps documents without filters unchanged', () => {
    expect(q).toEqual({ id: 'q', label: 'Search', type: 'text', default: '' });
    expect(period).toMatchObject({ custom: true, maxDays: 90 });
    expect(
      ParameterSchema.parse({ id: 'p', label: 'P', type: 'dateRange', presets: ['today'], default: 'today' }),
    ).toMatchObject({ custom: false, maxDays: 366 });
    const text = JSON.stringify(emptyDashboard('t'));
    expect(JSON.stringify(parseDashboard(JSON.parse(text)))).toBe(text);
    expect(LIMITS.parameters).toBe(8);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...q, id: `q${i}` }));
    expect(DashboardDocSchema.safeParse({ ...emptyDashboard('t'), parameters: nine }).success).toBe(false);
  });

  it('refuses ids with hyphens or capitals, and dates that are not on the calendar', () => {
    for (const id of ['top-n', 'Region', '1st', '', 'a'.repeat(33)])
      expect(ParameterSchema.safeParse({ ...q, id }).success, id).toBe(false);
    expect(ParameterSchema.safeParse({ ...q, id: 'a'.repeat(32) }).success).toBe(true);
    expect(isoDay('2026-02-29')).toBeNull();
    expect(isoDay('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
    expect(isoDay('2026-1-01')).toBeNull();
    expect(ParameterSchema.safeParse({ ...period, min: '2026-02-30' }).success).toBe(false);
  });

  it('reads the text form of a reference', () => {
    expect(readRef('region')).toBeNull();
    expect(readRef('$param.region')).toEqual({ id: 'region', part: null });
    expect(readRef('$param.period.start')).toEqual({ id: 'period', part: 'start' });
    expect(readRef('$param.Region')).toEqual({
      problem: expect.stringContaining('filter ids are 1-32 chars'),
    });
    expect(readRef('$param.period.month')).toEqual({
      problem: expect.stringContaining('has no part "month"'),
    });
    expect(readRef('$param.')).toEqual({ problem: expect.stringContaining('is not a filter reference') });
  });
});

describe('date presets', () => {
  const r = (preset: (typeof DATE_PRESETS)[number], iso: string) => {
    const v = presetRange(preset, at(iso));
    return `${v.from}..${v.to}`;
  };

  it('resolves every preset in UTC, around month and year ends', () => {
    expect(r('today', '2026-11-10')).toBe('2026-11-10..2026-11-10');
    expect(r('yesterday', '2026-01-01')).toBe('2025-12-31..2025-12-31');
    expect(r('last7d', '2026-03-03')).toBe('2026-02-25..2026-03-03');
    expect(r('last30d', '2026-11-10')).toBe('2026-10-12..2026-11-10');
    expect(r('last90d', '2026-01-15')).toBe('2025-10-18..2026-01-15');
    expect(r('thisMonth', '2026-11-10')).toBe('2026-11-01..2026-11-10');
    expect(r('lastMonth', '2026-03-31')).toBe('2026-02-01..2026-02-28');
    expect(r('lastMonth', '2026-01-10')).toBe('2025-12-01..2025-12-31');
    expect(r('thisYear', '2026-11-10')).toBe('2026-01-01..2026-11-10');
    expect(r('last12m', '2026-03-31')).toBe('2025-04-01..2026-03-31');
    expect(r('last12m', '2026-01-01')).toBe('2025-01-02..2026-01-01');
    // A leap day has no twin a year earlier: the range starts the day after the last day of February.
    expect(r('last12m', '2028-02-29')).toBe('2027-03-01..2028-02-29');
    expect(r('last12m', '2028-02-28')).toBe('2027-03-01..2028-02-28');
    expect(r('last12m', '2029-02-28')).toBe('2028-02-29..2029-02-28');
  });

  it('turns at midnight UTC whatever the zone of the machine, and gives epoch ms with an exclusive end', () => {
    expect(presetRange('today', Date.parse('2026-11-10T23:59:59Z')).to).toBe('2026-11-10');
    expect(presetRange('today', Date.parse('2026-11-11T00:00:00Z')).to).toBe('2026-11-11');
    expect(presetRange('last7d', at('2026-11-10'))).toEqual({
      from: '2026-11-04',
      to: '2026-11-10',
      start: Date.UTC(2026, 10, 4),
      end: Date.UTC(2026, 10, 11),
      preset: 'last7d',
    });
    for (const preset of DATE_PRESETS) {
      const v = presetRange(preset, at('2026-11-10'));
      expect(v.end - v.start, preset).toBeGreaterThanOrEqual(DAY);
      expect(v.from <= v.to, preset).toBe(true);
    }
  });
});

describe('filter values', () => {
  it('reads link values: missing takes the default, numbers as text, * for all, unknown ids ignored', () => {
    const { values, problems } = read({ region: '2026', q: '  shoes  ', period: '2026-01-01..2026-01-31' });
    expect(problems).toEqual([]);
    expect(values.region).toBe(2026);
    expect(values.q).toBe('shoes');
    expect(values.period).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 1, 1),
    });
    const defaults = read({}).values;
    expect(defaults.region).toBeNull();
    expect(defaults.q).toBe('');
    expect(defaults.period).toMatchObject({ preset: 'last30d', to: '2026-11-10' });
    expect(read({ region: '*' }).values.region).toBeNull();
    expect(read({ region: 'eu', unknown: 'x' }).problems).toEqual([]);
  });

  it('names each invalid value and falls back to the default', () => {
    const cases: [Record<string, string>, string][] = [
      [{ region: 'xx' }, 'Filter "region" has no value "xx"; choose one of eu, us, 2026, or * for all'],
      [{ q: 'x'.repeat(101) }, 'Filter "q" takes at most 100 characters'],
      [
        { period: 'last90d' },
        'Filter "period" has no value "last90d"; choose one of last7d, last30d, thisMonth, or a range like 2026-01-01..2026-01-31',
      ],
      [
        { period: '2026-03-01..2026-01-01' },
        'Filter "period": the range 2026-03-01..2026-01-01 ends before it starts',
      ],
      [
        { period: '2024-12-01..2025-01-10' },
        'Filter "period": the range 2024-12-01..2025-01-10 must lie between 2025-01-01 and any date',
      ],
      [
        { period: '2026-01-01..2026-04-30' },
        'Filter "period": the range 2026-01-01..2026-04-30 is 120 days long; at most 90',
      ],
      [
        { period: '2026-02-30..2026-03-01' },
        'Filter "period": the range 2026-02-30..2026-03-01 has a day that is not on the calendar',
      ],
    ];
    for (const [raw, message] of cases) {
      expect(read(raw).problems, message).toEqual([{ id: Object.keys(raw)[0], message }]);
    }
    expect(read({ region: 'xx' }).values.region).toBeNull();
    const fixed = ParameterSchema.parse({
      id: 'period',
      label: 'Period',
      type: 'dateRange',
      presets: ['last7d'],
      default: 'last7d',
    });
    expect(readParameterValues([fixed], () => '2026-01-01..2026-01-02', at('2026-11-10')).problems).toEqual([
      { id: 'period', message: 'Filter "period" takes only its presets (last7d), not a range' },
    ]);
    const noAll = ParameterSchema.parse({
      id: 'region',
      label: 'Region',
      type: 'select',
      options: [{ value: 'eu' }],
      default: 'eu',
    });
    expect(readParameterValues([noAll], () => '*', 0).problems).toEqual([
      { id: 'region', message: 'Filter "region" has no value "*"; choose one of eu' },
    ]);
    // A long hand-edited value is cut in the message, which goes back to whoever sent it.
    expect(read({ region: 'y'.repeat(300) }).problems[0]!.message).toContain(`"${'y'.repeat(40)}…"`);
  });

  it('writes only values that differ from their default, and a canonical view', () => {
    const values = read({ region: 'eu', period: 'last7d' }).values;
    expect(writeParameterValues(parameters, values)).toEqual({ 'p.region': 'eu', 'p.period': 'last7d' });
    expect(writeParameterValues(parameters, read({}).values)).toEqual({});
    expect(viewQuery(parameters, read({ q: 'a&b=c', region: 'eu' }).values)).toBe(
      'p.q=a%26b%3Dc&p.region=eu',
    );
    expect(viewQuery(parameters, read({ region: '*' }).values)).toBe('');
    expect(viewQuery(undefined, {})).toBe('');
    expect(parameterText(period, read({ period: '2026-01-01..2026-01-31' }).values.period!)).toBe(
      '2026-01-01..2026-01-31',
    );
    expect(defaultText(region)).toBe('*');
    expect(defaultText(q)).toBe('');
    expect(defaultText(period)).toBe('last30d');
  });

  it('describes values for people', () => {
    const values = read({ region: 'eu', period: 'last7d' }).values;
    expect(describeParameterValue(region, values.region!)).toBe('EU');
    expect(describeParameterValue(region, null)).toBe('All regions');
    expect(describeParameterValue(region, 2026)).toBe('2026');
    expect(describeParameterValue(period, values.period!)).toBe('Last 7 days');
    expect(describeParameterValue(period, read({ period: '2026-01-01..2026-01-31' }).values.period!)).toBe(
      '2026-01-01 – 2026-01-31',
    );
    expect(parameterSummary(parameters, values)).toBe('Region: EU · Period: Last 7 days');
    expect(parameterSummary(parameters, read({ q: 'shoes' }).values)).toBe(
      'Region: All regions · Search: "shoes" · Period: Last 30 days',
    );
  });
});

describe('declaration checks', () => {
  const issues = (list: unknown[]) => {
    try {
      parseDashboard({ ...emptyDashboard('t'), parameters: list });
      return [];
    } catch (e) {
      if (e instanceof DocumentError) return e.issues;
      throw e;
    }
  };

  it('accepts sound declarations and names every broken one', () => {
    expect(issues([region, q, period])).toEqual([]);
    expect(issues([region, { ...q, id: 'region' }])).toEqual([
      'Filter ids must be unique: "region" appears twice',
    ]);
    expect(issues([{ ...region, options: [{ value: 'eu' }, { value: 'eu', label: 'Again' }] }])).toContain(
      'Filter "region": option "eu" appears twice',
    );
    expect(issues([{ ...region, options: [{ value: 1 }, { value: '1' }] }])).toContain(
      'Filter "region": option "1" appears twice',
    );
    expect(issues([{ ...region, options: [{ value: '*' }] }])).toContain(
      'Filter "region": "*" stands for "All" in links; use another option value',
    );
    expect(issues([{ ...region, options: [{ value: '$param.x' }] }])).toContain(
      'Filter "region": an option value cannot start with "$param."',
    );
    expect(issues([{ ...region, default: 'xx' }])).toEqual([
      'Filter "region": the default "xx" is not one of its options',
    ]);
    // A lone surrogate is not text: it cannot be part of an address, and a link could not carry it.
    expect(issues([{ ...region, options: [{ value: 'eu' }, { value: 'a\uD800b' }] }])).toEqual([
      'Filter "region": an option value holds a broken character (a lone UTF-16 surrogate)',
    ]);
    expect(issues([{ ...region, default: '\uDC00' }])).toEqual([
      'Filter "region": the default holds a broken character (a lone UTF-16 surrogate)',
    ]);
    expect(issues([{ ...q, default: 'x\uD83D' }])).toEqual([
      'Filter "q": the default holds a broken character (a lone UTF-16 surrogate)',
    ]);
    expect(issues([{ ...region, options: [{ value: 'eu' }, { value: '🇪🇺' }] }])).toEqual([]);
    const { all: _all, ...withoutAll } = region as Extract<Parameter, { type: 'select' }>;
    expect(issues([withoutAll])).toEqual([
      'Filter "region": the default is "All" (null), but the filter offers no "All"; set all to its label',
    ]);
    expect(issues([{ ...period, default: 'today' }])).toEqual([
      'Filter "period": the default "today" is not one of its presets',
    ]);
    expect(issues([{ ...period, custom: false, default: { from: '2026-01-01', to: '2026-01-31' } }])).toEqual(
      ['Filter "period": a range as default needs custom: true'],
    );
    expect(issues([{ ...period, default: { from: '2026-02-01', to: '2026-01-01' } }])).toEqual([
      'Filter "period": the default range ends before it starts',
    ]);
    expect(issues([{ ...period, default: { from: '2026-01-01', to: '2026-06-30' } }])).toEqual([
      'Filter "period": the default range is 181 days long; at most 90',
    ]);
    expect(issues([{ ...period, min: '2026-02-01', max: '2026-01-01' }])).toContain(
      'Filter "period": min is after max',
    );
  });
});
