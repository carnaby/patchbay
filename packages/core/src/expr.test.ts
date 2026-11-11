import { describe, expect, it } from 'vitest';
import {
  compile,
  compileFor,
  ExprError,
  fieldRef,
  inferTable,
  MAX_BOUND_EXPRESSION,
  paramNodes,
  paramSpans,
  parse,
  referencedFields,
  runPipeline,
  TABLE_FUNCTIONS,
  type Transform,
  TransformSchema,
} from './index.ts';

const close = (actual: unknown, expected: number, digits = 9) => {
  expect(typeof actual).toBe('number');
  expect(actual as number).toBeCloseTo(expected, digits);
};

describe('trigonometry', () => {
  it('evaluates the basic functions in radians', () => {
    close(compile('pi()')({}), Math.PI);
    close(compile('sin(pi() / 2)')({}), 1);
    close(compile('cos(0)')({}), 1);
    close(compile('tan(pi() / 4)')({}), 1);
    close(compile('asin(1)')({}), Math.PI / 2);
    close(compile('acos(1)')({}), 0);
    close(compile('atan(1)')({}), Math.PI / 4);
    close(compile('atan2(1, -1)')({}), (3 * Math.PI) / 4);
  });

  it('converts between degrees and radians', () => {
    close(compile('radians(180)')({}), Math.PI);
    close(compile('degrees(pi())')({}), 180);
    close(compile('degrees(atan2(lat, lon))')({ lat: 1, lon: 1 }), 45);
  });

  it('returns null for missing or out-of-domain input instead of NaN', () => {
    expect(compile('sin(x)')({ x: null })).toBeNull();
    expect(compile('asin(2)')({})).toBeNull();
    expect(compile('sin("abc")')({})).toBeNull();
  });

  it('stays sandboxed: no bare constant leaks in, and unknown functions still fail', () => {
    // A bare `pi` is a field reference, so a column named "pi" keeps working.
    expect(compile('pi')({ pi: 7 })).toBe(7);
    expect(() => parse('Math.sin(1)')).toThrow(ExprError);
  });
});

describe('distance', () => {
  it('gives the great-circle distance between two known cities in km', () => {
    // London to Paris is about 344 km; Bratislava to Vienna about 55 km.
    const km = compile('distance(51.5074, -0.1278, 48.8566, 2.3522)')({});
    expect(km as number).toBeGreaterThan(341);
    expect(km as number).toBeLessThan(346);
    const near = compile('distance(lat, lon, 48.2082, 16.3738)')({ lat: 48.1486, lon: 17.1077 });
    expect(near as number).toBeGreaterThan(53);
    expect(near as number).toBeLessThan(57);
  });

  it('is zero for the same point, symmetric, and bounded for antipodes', () => {
    expect(compile('distance(10, 20, 10, 20)')({})).toBe(0);
    const ab = compile('distance(40.7128, -74.006, 35.6762, 139.6503)')({});
    const ba = compile('distance(35.6762, 139.6503, 40.7128, -74.006)')({});
    close(ab, ba as number, 6);
    // New York to Tokyo is about 10 850 km.
    expect(ab as number).toBeGreaterThan(10_800);
    expect(ab as number).toBeLessThan(10_900);
    close(compile('distance(0, 0, 0, 180)')({}), Math.PI * 6371.0088, 3);
  });

  it('returns null when a coordinate is missing', () => {
    expect(compile('distance(lat, lon, 0, 0)')({ lat: 1, lon: null })).toBeNull();
  });
});

describe('whole-table functions', () => {
  const sales = inferTable([
    { region: 'EU', sales: 10 },
    { region: 'EU', sales: 30 },
    { region: 'US', sales: 60 },
    { region: 'US', sales: null },
  ]);
  const all = (src: string) => sales.rows.map(compileFor(src, sales));

  it('computes shares and deviations over the table or per group, skipping nulls', () => {
    expect(all('round(sales / col_sum(sales) * 100, 1)')).toEqual([10, 30, 60, null]);
    expect(all('sales / col_sum(sales, region)')).toEqual([0.25, 0.75, 1, null]);
    expect(all('sales - col_avg(sales, region)')).toEqual([-10, 10, 0, null]);
    expect(all('col_count(sales)')[0]).toBe(3);
    expect(all('col_count(sales, region)')[3]).toBe(1);
    expect(all('col_min(sales)')[0]).toBe(10);
    expect(all('col_max(sales)')[0]).toBe(60);
    expect(all('col_median(sales)')[0]).toBe(30);
    expect(all('col_stddev(sales)')[0]).toBeCloseTo(20.548, 3);
    expect(all('col_first(sales)')[0]).toBe(10);
    expect(all('col_last(sales)')[0]).toBe(60);
    expect(all('if(sales > col_avg(sales), "above", "below")')).toEqual(['below', 'below', 'above', 'below']);
  });

  it('computes identical whole-table calls once, under the clock of the run that asks', () => {
    let ticks = 0;
    const count = () => {
      ticks++;
    };
    compileFor('col_sum(sales, region)', sales, count);
    const once = ticks;
    ticks = 0;
    const same = compileFor(Array(10).fill('col_sum(sales, region)').join(' + '), sales, count);
    expect(once).toBeGreaterThan(0);
    expect(ticks).toBe(once);
    expect(sales.rows.map(same)).toEqual([400, 400, 600, 600]);
    const late = () => {
      throw new Error('Too late');
    };
    expect(() => compileFor('col_median(sales)', sales, late)).toThrow('Too late');
  });

  it('reads backticked columns and lists every function', () => {
    const t = inferTable([{ 'wind speed': 2 }, { 'wind speed': 4 }]);
    expect(t.rows.map(compileFor('`wind speed` / col_sum(`wind speed`)', t))).toEqual([1 / 3, 2 / 3]);
    expect(Object.keys(TABLE_FUNCTIONS)).toEqual([
      'col_sum',
      'col_avg',
      'col_min',
      'col_max',
      'col_median',
      'col_stddev',
      'col_count',
      'col_first',
      'col_last',
    ]);
  });

  it('accepts only column references, at save time', () => {
    for (const src of ['col_sum(1)', 'col_sum(a + b)', 'col_sum()', 'col_sum(a, b, c)']) {
      expect(() => parse(src)).toThrow(ExprError);
      expect(() => parse(src)).toThrow(
        /col_sum needs a column: col_sum\(price\) or col_sum\(price, region\)/,
      );
    }
    expect(() => parse('col_avg(price, region)')).not.toThrow();
  });

  it('is refused where only one row is known', () => {
    expect(() => compile('x / col_sum(x)')).toThrow(
      'col_sum() needs the whole table: use it in a filter or derive step',
    );
  });

  it('works in filter and derive on the rows at that point of the pipeline', () => {
    const steps = [
      { type: 'filter', expr: 'region == "EU"' },
      { type: 'derive', as: 'share', expr: 'round(sales / col_sum(sales) * 100)' },
      { type: 'filter', expr: 'sales > col_avg(sales)' },
    ].map((s) => TransformSchema.parse(s)) as Transform[];
    expect(runPipeline(sales, steps).table.rows).toEqual([{ region: 'EU', sales: 30, share: 75 }]);
  });
});

describe('filter references in expressions', () => {
  it('parses $param references with parts, and leaves strings and backticked columns alone', () => {
    expect(parse('region == $param.region')).toEqual({
      k: 'binary',
      op: '==',
      left: { k: 'field', name: 'region' },
      right: { k: 'param', id: 'region', part: null },
    });
    expect(parse('time >= $param.period.start')).toMatchObject({
      right: { k: 'param', id: 'period', part: 'start' },
    });
    expect(parse('"$param.region"')).toEqual({ k: 'lit', v: '$param.region' });
    expect(parse('`$param.region`')).toEqual({ k: 'field', name: '$param.region' });
    expect([...referencedFields(parse('$param.q == "" || contains(title, $param.q)'))]).toEqual(['title']);
    expect(paramNodes(parse('a > $param.x && $param.y.from != b'))).toEqual([
      { k: 'param', id: 'x', part: null },
      { k: 'param', id: 'y', part: 'from' },
    ]);
  });

  it('refuses references that are not filter ids or parts, when the step is saved', () => {
    expect(() => parse('$param.Region')).toThrow(/not a filter reference: filter ids are/);
    expect(() => parse('$param.period.month')).toThrow(/has no part "month"/);
    expect(() => parse('$param.a.from.x')).toThrow(/has no part "from.x"/);
    expect(() => parse('$param.')).toThrow(/not a filter reference/);
    expect(TransformSchema.safeParse({ type: 'filter', expr: 'x == $param.Region' }).success).toBe(false);
  });

  it('refuses malformed reference syntax and finds references in nested positions', () => {
    expect(() => parse('$param.x(')).toThrow('Unexpected trailing input');
    expect(() => parse('$param.x .y')).toThrow('Unexpected character "."');
    expect(paramNodes(parse('-$param.a > 0 ? round($param.b, 1) : !$param.c.from')).map((n) => n.id)).toEqual(
      ['a', 'b', 'c'],
    );
  });

  it('never evaluates an unbound reference', () => {
    expect(() => compile('$param.region == "eu"')({})).toThrow('Filter "region" has no value here');
  });

  it('lists references with their place in the text, not inside strings or backticks', () => {
    expect(paramSpans('a == $param.r || "$param.s" == `$param.t` || $param.p.to')).toEqual([
      { start: 5, end: 13, text: '$param.r' },
      { start: 45, end: 56, text: '$param.p.to' },
    ]);
    expect(paramSpans('a > 1')).toEqual([]);
  });

  it('keeps a column named like a reference reachable, in backticks', () => {
    expect(fieldRef('$param.region')).toBe('`$param.region`');
    expect(fieldRef('region')).toBe('region');
  });

  it('lets filter and derive steps run bound expressions longer than the authored limit', () => {
    const long = `x == "${'a'.repeat(2500)}"`;
    expect(() => parse(long)).toThrow('Expression longer than 2000 characters');
    expect(() => parse(long, { maxLength: MAX_BOUND_EXPRESSION })).not.toThrow();
    const table = inferTable([{ x: 'a'.repeat(2500) }, { x: 'b' }]);
    expect(runPipeline(table, [{ type: 'filter', expr: long }]).table.rows).toHaveLength(1);
    expect(runPipeline(table, [{ type: 'derive', as: 'same', expr: long }]).table.rows[0]!.same).toBe(true);
  });
});
