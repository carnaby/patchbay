import { describe, expect, it } from 'vitest';
import {
  BindError,
  bindDataset,
  bindDoc,
  bindExpression,
  bindUrl,
  type DashboardDoc,
  DatasetSchema,
  type DateRange,
  emptyDashboard,
  MAX_BOUND_EXPRESSION,
  type Node,
  type ParameterValue,
  type ParameterValues,
  parse,
} from './index.ts';

const period: DateRange = {
  from: '2026-01-01',
  to: '2026-01-31',
  start: Date.UTC(2026, 0, 1),
  end: Date.UTC(2026, 1, 1),
};
const values: ParameterValues = {
  region: 'eu',
  none: null,
  n: -2.5,
  big: 1e21,
  q: 'say "hi" \\ there',
  period,
};

describe('binding expressions', () => {
  it('replaces references by literals and leaves strings and backticks alone', () => {
    expect(bindExpression('region == $param.region || $param.none == null', values)).toBe(
      'region == "eu" || null == null',
    );
    expect(bindExpression('x > $param.n', values)).toBe('x > (-2.5)');
    expect(bindExpression('t >= $param.period.start && d <= $param.period.to', values)).toBe(
      `t >= ${Date.UTC(2026, 0, 1)} && d <= "2026-01-31"`,
    );
    expect(bindExpression('"$param.region" == `$param.region`', values)).toBe(
      '"$param.region" == `$param.region`',
    );
    expect(bindExpression('contains(t, $param.q)', values)).toBe('contains(t, "say \\"hi\\" \\\\ there")');
    expect(bindExpression('x == $param.big', values)).toBe('x == 1e+21');
    const same = 'a > 1';
    expect(bindExpression(same, values)).toBe(same);
  });

  it('fails clearly on unknown filters, missing or extra parts, and very long results', () => {
    expect(() => bindExpression('$param.nope == 1', values)).toThrow(BindError);
    expect(() => bindExpression('$param.nope == 1', values)).toThrow('Unknown filter "nope"');
    expect(() => bindExpression('$param.constructor == 1', values)).toThrow('Unknown filter "constructor"');
    expect(() => bindExpression('$param.period == 1', values)).toThrow(
      'Filter "period" is a date range: use .from, .to, .start or .end',
    );
    expect(() => bindExpression('$param.region.from == 1', values)).toThrow(
      'Filter "region" has no part .from',
    );
    // A template that can be saved (under 2,000 characters and 400 nodes), with a 100-character value escaping doubles.
    expect(() => bindExpression(`${'$param.q + '.repeat(99)}$param.q`, { q: '"'.repeat(100) })).toThrow(
      'The filter values make this expression longer than 20,000 characters',
    );
  });

  it('refuses a malformed reference before replacing anything', () => {
    expect(() => bindExpression('$param.region(1) == 1', values)).toThrow(BindError);
    expect(() => bindExpression('$param.region(1) == 1', values)).toThrow('Unexpected trailing input');
    expect(() => bindExpression('$param.Region == 1', values)).toThrow('is not a filter reference');
  });

  it('never changes the shape of an expression, whatever the values (property test)', () => {
    const TEMPLATES = [
      'region == $param.a',
      '$param.a == null || contains(title, $param.a)',
      'x > $param.b && x < $param.b * 2',
      '-$param.b ^ 2 + $param.b',
      'if($param.a == "", 1, len($param.a))',
      '$param.p.start <= t && t < $param.p.end',
      'concat($param.a, "-", $param.p.from) == label ? $param.b : -1',
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const ALPHABET = [
      'a',
      'Z',
      '0',
      ' ',
      '"',
      "'",
      '`',
      '\\',
      '$',
      '.',
      '(',
      ')',
      '|',
      '&',
      '\n',
      'é',
      '$param.a',
    ];
    const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
    const randomText = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(ALPHABET)).join('');
    const randomNumber = () => pick([0, 1, -1, 2.5, -1e-7, 1e21, 123_456_789, -0.5]);
    /** The template's tree with each reference read as its value; a negative number reads as minus a literal. */
    const substituted = (node: Node, v: ParameterValues): Node => {
      switch (node.k) {
        case 'param': {
          const raw = v[node.id] as ParameterValue;
          const value = node.part ? (raw as DateRange)[node.part] : (raw as string | number | null);
          return typeof value === 'number' && value < 0
            ? { k: 'unary', op: '-', arg: { k: 'lit', v: -value } }
            : { k: 'lit', v: value };
        }
        case 'unary':
          return { ...node, arg: substituted(node.arg, v) };
        case 'binary':
          return { ...node, left: substituted(node.left, v), right: substituted(node.right, v) };
        case 'cond': {
          const then = substituted(node.then, v);
          return { ...node, test: substituted(node.test, v), then, else: substituted(node.else, v) };
        }
        case 'call':
          return { ...node, args: node.args.map((a) => substituted(a, v)) };
        default:
          return node;
      }
    };
    for (let i = 0; i < 300; i++) {
      const v: ParameterValues = {
        a: rnd() < 0.15 ? null : rnd() < 0.5 ? randomText() : randomNumber(),
        b: randomNumber(),
        p: period,
      };
      for (const template of TEMPLATES) {
        const bound = bindExpression(template, v);
        expect(
          parse(bound, { maxLength: MAX_BOUND_EXPRESSION }),
          `${template} with ${JSON.stringify(v)}`,
        ).toEqual(substituted(parse(template), v));
      }
    }
  });
});

describe('binding URLs', () => {
  it('fills whole segments and query values, and keeps every other byte as saved', () => {
    const url =
      'https://api.example.com/v1/cities/$param.city/sales?region=$param.region&from=$param.period.from&to=$param.period.to&x=%7E1';
    expect(bindUrl(url, { ...values, city: 'Nové Zámky' })).toBe(
      'https://api.example.com/v1/cities/Nov%C3%A9%20Z%C3%A1mky/sales?region=eu&from=2026-01-01&to=2026-01-31&x=%7E1',
    );
    const plain = 'https://a.example/x?y=1&z=%41';
    expect(bindUrl(plain, values)).toBe(plain);
  });

  it('leaves out a query pair at "All", and the "?" with the last one', () => {
    expect(bindUrl('https://a.example/s?region=$param.none&x=1', values)).toBe('https://a.example/s?x=1');
    expect(bindUrl('https://a.example/s?region=$param.none', values)).toBe('https://a.example/s');
  });

  it('keeps every value one segment or one value, wherever it tries to go', () => {
    for (const city of ['a/b', 'a?b', 'a#b', '%2e%2e', 'a&b=c', '../x', '@evil.example']) {
      const bound = bindUrl('https://a.example/v1/$param.city/x?c=$param.city', { city });
      const u = new URL(bound);
      expect(u.origin, city).toBe('https://a.example');
      expect(u.pathname.split('/'), city).toHaveLength(4);
      expect(decodeURIComponent(u.pathname.split('/')[2]!), city).toBe(city);
      expect(u.searchParams.get('c'), city).toBe(city);
    }
  });

  it('refuses again every reference validation refuses, should one reach it unchecked', () => {
    const where = 'Filters cannot be part of the scheme, host, port, user name or fragment of an address';
    const city = { city: 'vienna' };
    const urls: [string, string][] = [
      // "$" cannot start a scheme, so the text has none: it reads as a segment with more than the reference.
      ['$param.city://a.example/x', '"$param.city:" puts a filter inside a longer text'],
      ['https://$param.city/x', where],
      ['https://a.example:$param.city/x', where],
      ['https://$param.city@a.example/x', where],
      ['https://u:$param.city@a.example/x', where],
      ['https://a.example/x#$param.city', where],
      ['https://a.example/x?$param.city=1', 'A query parameter name cannot be a filter'],
      [
        'https://a.example/sales-$param.city.json',
        '"sales-$param.city.json" puts a filter inside a longer text',
      ],
      ['https://a.example/x?q=in:$param.city', '"in:$param.city" puts a filter inside a longer text'],
    ];
    for (const [url, message] of urls) {
      expect(() => bindUrl(url, city), url).toThrow(BindError);
      expect(() => bindUrl(url, city), url).toThrow(message);
    }
    const posted = (body: unknown) =>
      DatasetSchema.parse({
        id: 'b',
        name: 'B',
        source: { kind: 'http', url: 'https://a.example/q', method: 'POST', body },
      });
    expect(() => bindDataset(posted({ q: 'where c = $param.city' }), city)).toThrow(
      '"where c = $param.city" puts a filter inside a longer text',
    );
    expect(() => bindDataset(posted({ vars: { '$param.city': 1 } }), city)).toThrow(
      'A key cannot be a filter',
    );
  });

  it('refuses a path value that would empty or leave its segment', () => {
    for (const city of ['', '.', '..'])
      expect(() => bindUrl('https://a.example/v1/$param.city/x', { city }), city).toThrow(
        `Filter "city" cannot be used as a path segment with the value "${city}"`,
      );
    expect(() => bindUrl('https://a.example/v1/$param.none/x', values)).toThrow(
      'Filter "none" cannot be used as a path segment with the value ""',
    );
  });
});

describe('binding datasets and documents', () => {
  const posted = DatasetSchema.parse({
    id: 'd',
    name: 'D',
    source: {
      kind: 'http',
      url: 'https://a.example/x?r=$param.region',
      method: 'POST',
      body: {
        variables: {
          r: '$param.region',
          from: '$param.period.from',
          all: '$param.none',
          n: 1,
          list: ['$param.region', 'plain'],
        },
      },
    },
    transforms: [
      { id: 'f', type: 'filter', expr: 'r == $param.region' },
      { id: 's', type: 'sort', by: [{ field: 'r' }] },
    ],
  });
  const plain = DatasetSchema.parse({
    id: 'p',
    name: 'P',
    source: { kind: 'inline', rows: [{ note: '$param.region' }] },
    transforms: [{ type: 'filter', expr: '`$param.region` != ""' }],
  });

  it('binds the URL, the body as typed values and the steps, and keeps step ids', () => {
    const bound = bindDataset(posted, values);
    expect(bound.source).toEqual({
      kind: 'http',
      url: 'https://a.example/x?r=eu',
      method: 'POST',
      body: { variables: { r: 'eu', from: '2026-01-01', all: null, n: 1, list: ['eu', 'plain'] } },
    });
    expect(bound.transforms[0]).toEqual({ id: 'f', type: 'filter', expr: 'r == "eu"' });
    expect(bound.transforms[1]).toBe(posted.transforms[1]);
  });

  it('leaves a connector parameter out at "All", so the connector default applies', () => {
    const c = DatasetSchema.parse({
      id: 'c',
      name: 'C',
      source: {
        kind: 'connector',
        connector: 'weather.current',
        params: { city: '$param.none', units: 'metric', days: '$param.n' },
      },
    });
    expect(bindDataset(c, values).source).toEqual({
      kind: 'connector',
      connector: 'weather.current',
      params: { units: 'metric', days: -2.5 },
    });
  });

  it('returns the very same object for a dataset or document without references', () => {
    expect(bindDataset(plain, values)).toBe(plain);
    const doc: DashboardDoc = { ...emptyDashboard('t'), datasets: [plain] };
    expect(bindDoc(doc, values).doc).toBe(doc);
  });

  it('binds a document dataset by dataset and names the one that fails without failing the others', () => {
    const path = DatasetSchema.parse({
      id: 'path',
      name: 'Path',
      source: { kind: 'http', url: 'https://a.example/$param.city/x' },
    });
    const doc: DashboardDoc = { ...emptyDashboard('t'), datasets: [posted, path, plain] };
    const { doc: bound, errors } = bindDoc(doc, { ...values, city: '..' });
    expect(bound.datasets[0]!.source).toMatchObject({ url: 'https://a.example/x?r=eu' });
    expect(bound.datasets[1]).toBe(path);
    expect(bound.datasets[2]).toBe(plain);
    expect([...errors]).toEqual([
      ['path', 'Filter "city" cannot be used as a path segment with the value ".."'],
    ]);
  });

  it('names a dataset whose address cannot hold a value (a lone surrogate) and still binds the others', () => {
    const query = DatasetSchema.parse({
      id: 'q',
      name: 'Q',
      source: { kind: 'http', url: 'https://a.example/x?c=$param.city' },
    });
    const segment = DatasetSchema.parse({
      id: 's',
      name: 'S',
      source: { kind: 'http', url: 'https://a.example/$param.city/x' },
    });
    const local = DatasetSchema.parse({
      id: 'l',
      name: 'L',
      source: { kind: 'inline', rows: [{ c: 'a' }] },
      transforms: [{ type: 'filter', expr: 'c == $param.city' }],
    });
    const doc: DashboardDoc = { ...emptyDashboard('t'), datasets: [query, segment, local] };
    const { doc: bound, errors } = bindDoc(doc, { city: '\ud800' });
    expect(bound.datasets[0]).toBe(query);
    expect(bound.datasets[1]).toBe(segment);
    expect(bound.datasets[2]!.transforms[0]).toMatchObject({ expr: 'c == "\ud800"' });
    expect([...errors]).toEqual([
      ['q', 'Filter "city" has a value that cannot be part of an address'],
      ['s', 'Filter "city" has a value that cannot be part of an address'],
    ]);
  });
});
