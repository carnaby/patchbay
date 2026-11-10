import { describe, expect, it } from 'vitest';
import {
  DashboardDocSchema,
  DatasetSchema,
  DocumentError,
  emptyDashboard,
  lineageParameters,
  type ParameterRef,
  parameterRefs,
  parameterUsage,
  parseDashboard,
  type Source,
} from './index.ts';

const region = {
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu' }, { value: 'us' }],
  all: 'All',
  default: null,
};
const city = {
  id: 'city',
  label: 'City',
  type: 'select',
  options: [{ value: 'bratislava' }, { value: 'vienna' }],
  default: 'bratislava',
};
const q = { id: 'q', label: 'Search', type: 'text' };
const period = {
  id: 'period',
  label: 'Period',
  type: 'dateRange',
  presets: ['last7d', 'last30d'],
  default: 'last7d',
};
const http = (url: string, extra: Record<string, unknown> = {}) => ({ kind: 'http', url, ...extra });
const ds = (id: string, source: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  source,
  ...extra,
});
const docOf = (...datasets: unknown[]) => ({
  ...emptyDashboard('t'),
  parameters: [region, city, q, period],
  datasets,
});
const issues = (doc: unknown) => {
  try {
    parseDashboard(doc);
    return [];
  } catch (e) {
    if (e instanceof DocumentError) return e.issues;
    throw e;
  }
};
const brief = (refs: ParameterRef[]) =>
  refs.map(({ id, part, place, problem }) => ({ id, part, place, ...(problem ? { problem } : {}) }));
const refsOf = (dataset: unknown) => brief(parameterRefs(DatasetSchema.parse(dataset)));
/** The problem of each reference in a URL, or its place when it has none. Not parsed: some are not valid sources. */
const urlProblems = (url: string) =>
  parameterRefs({ source: { kind: 'http', url } as Source, transforms: [] }).map((r) => r.problem ?? r.place);

describe('filter references', () => {
  it('finds references in steps, URLs, bodies and connector parameters, each with its place', () => {
    expect(
      refsOf(
        ds(
          's',
          { kind: 'inline', rows: [] },
          {
            transforms: [
              { type: 'filter', expr: '$param.region == null || region == $param.region' },
              { type: 'derive', as: 'recent', expr: 'time >= $param.period.start' },
            ],
          },
        ),
      ),
    ).toEqual([
      { id: 'region', part: null, place: 'filter' },
      { id: 'region', part: null, place: 'filter' },
      { id: 'period', part: 'start', place: 'derive' },
    ]);
    expect(
      refsOf(
        ds(
          'h',
          http(
            'https://api.example.com/v1/cities/$param.city/sales?region=$param.region&from=$param.period.from&x=1',
          ),
        ),
      ),
    ).toEqual([
      { id: 'city', part: null, place: 'urlPath' },
      { id: 'region', part: null, place: 'urlQuery' },
      { id: 'period', part: 'from', place: 'urlQuery' },
    ]);
    expect(
      refsOf(
        ds(
          'p',
          http('https://api.example.com/graphql', {
            method: 'POST',
            body: {
              query: 'query($r: String) { sales(region: $r) { total } }',
              variables: { r: '$param.region', from: '$param.period.from' },
            },
          }),
        ),
      ),
    ).toEqual([
      { id: 'region', part: null, place: 'body' },
      { id: 'period', part: 'from', place: 'body' },
    ]);
    expect(
      refsOf(ds('c', { kind: 'connector', connector: 'weather.current', params: { city: '$param.city' } })),
    ).toEqual([{ id: 'city', part: null, place: 'connector' }]);
    expect(refsOf(ds('f', { kind: 'feed', url: 'https://news.example.com/$param.city/rss' }))).toEqual([
      { id: 'city', part: null, place: 'urlPath' },
    ]);
    expect(refsOf(ds('n', http('https://api.example.com/v1/all?x=1')))).toEqual([]);
  });

  it('marks references that stand where no value can go, with the fix in the message', () => {
    expect(urlProblems('https://$param.city.example.com/x')).toEqual([
      'Filters cannot be part of the scheme, host, port or user name of an address',
    ]);
    // WHATWG reads any run of slashes after a special scheme as the start of the host.
    expect(urlProblems('https:///$param.city/x')).toEqual([
      'Filters cannot be part of the scheme, host, port or user name of an address',
    ]);
    expect(urlProblems('https://api.example.com/x#$param.city')).toEqual([
      'Filters cannot be part of the fragment (#…) of an address',
    ]);
    expect(urlProblems('https://api.example.com/sales-$param.city.json')).toEqual([
      '"sales-$param.city.json" puts a filter inside a longer path segment; a filter must be a whole path segment, as in /regions/$param.region/sales',
    ]);
    expect(urlProblems('https://api.example.com/x?q=region:$param.region')).toEqual([
      '"region:$param.region" puts a filter inside a longer query value; a filter must be a whole query value, as in ?region=$param.region',
    ]);
    expect(urlProblems('https://api.example.com/x?$param.region=1')).toEqual([
      'A query parameter name cannot be a filter; use it as the value: ?region=$param.region',
    ]);
    expect(urlProblems('https://api.example.com/x/$param.Region')).toEqual([
      expect.stringMatching(/not a filter reference/),
    ]);
    // User info is part of the authority: a value there would change who the request goes to.
    expect(urlProblems('https://$param.city@a.example/x')).toEqual([
      'Filters cannot be part of the scheme, host, port or user name of an address',
    ]);
    expect(urlProblems('https://u:$param.city@a.example/x')).toEqual([
      'Filters cannot be part of the scheme, host, port or user name of an address',
    ]);
    // WHATWG reads a backslash as a slash in a special URL; split as saved, "\" and the reference are one segment.
    expect(urlProblems('https://a.example\\$param.city/x')).toEqual([
      '"\\$param.city" puts a filter inside a longer path segment; a filter must be a whole path segment, as in /regions/$param.region/sales',
    ]);
    const body = parameterRefs({
      source: {
        kind: 'http',
        url: 'https://a.example/q',
        method: 'POST',
        body: { query: 'select * where region = $param.region', $param_key: 1, '$param.k': 2 },
      },
      transforms: [],
    });
    expect(body.map((r) => r.problem)).toEqual([
      '"select * where region = $param.region" puts a filter inside a longer text; a filter must be the whole value, as in { "region": "$param.region" }; never put one into query text, pass it as a variable',
      'A key cannot be a filter; use it as a value',
    ]);
  });

  it('lists the filters a dataset depends on through everything it reads, and where each is used', () => {
    const doc = DashboardDocSchema.parse(
      docOf(
        ds('root', http('https://api.example.com/sales?region=$param.region')),
        ds(
          'kid',
          { kind: 'dataset', id: 'root' },
          { transforms: [{ type: 'filter', expr: 'contains(name, $param.q)' }] },
        ),
        ds('other', { kind: 'inline', rows: [{ a: 1 }] }),
        ds(
          'joined',
          { kind: 'dataset', id: 'other' },
          { transforms: [{ type: 'join', with: 'kid', on: ['a'] }] },
        ),
      ),
    );
    expect(lineageParameters(doc, 'root')).toEqual(['region']);
    expect(lineageParameters(doc, 'kid')).toEqual(['q', 'region']);
    expect(lineageParameters(doc, 'other')).toEqual([]);
    expect(lineageParameters(doc, 'joined')).toEqual(['q', 'region']);
    expect(parameterUsage(doc, 'region')).toEqual([{ id: 'root', name: 'ROOT', place: 'urlQuery' }]);
    expect(parameterUsage(doc, 'period')).toEqual([]);
  });
});

describe('reference checks on every write', () => {
  it('accepts references a filter can fill', () => {
    expect(
      issues(
        docOf(
          ds(
            'ok',
            http(
              'https://api.example.com/v1/cities/$param.city/sales?region=$param.region&from=$param.period.from',
            ),
            {
              transforms: [{ type: 'filter', expr: 'contains(title, $param.q) && time < $param.period.end' }],
            },
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('accepts filters in the query and the body of a source with secrets', () => {
    expect(
      issues(
        docOf(
          ds(
            'secret',
            http('https://api.example.com/v1/sales?r=$param.city', {
              secrets: ['sec_AAAAAAAAAAAAAAAA'],
              method: 'POST',
              body: { c: '$param.city' },
            }),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('refuses every reference a filter cannot fill', () => {
    const one = (dataset: unknown) => issues(docOf(dataset));
    expect(
      one(
        ds(
          'a',
          { kind: 'inline', rows: [] },
          { transforms: [{ type: 'filter', expr: '$param.regoin == null' }] },
        ),
      ),
    ).toEqual([
      'Dataset "a" (filter step): unknown filter "regoin"; declared filters: region, city, q, period',
    ]);
    expect(one(ds('b', http('https://api.example.com/x?q=$param.q')))).toEqual([
      'Dataset "b" (URL query): text filters work in filter and derive steps only, never in a request (filter "q")',
    ]);
    expect(one(ds('c', http('https://api.example.com/$param.region/x')))).toEqual([
      'Dataset "c" (URL path): filter "region" offers "All", which no path segment can mean; use it in the query string',
    ]);
    expect(one(ds('d', http('https://api.example.com/$param.period.from/x')))).toEqual([
      'Dataset "d" (URL path): only a select filter can be a path segment (filter "period")',
    ]);
    expect(one(ds('e', http('https://api.example.com/x?from=$param.period')))).toEqual([
      'Dataset "e" (URL query): filter "period" is a date range: use .from, .to (YYYY-MM-DD) or .start, .end (epoch ms)',
    ]);
    expect(one(ds('f', http('https://api.example.com/x?c=$param.city.from')))).toEqual([
      'Dataset "f" (URL query): filter "city" has no part .from; only date ranges have parts',
    ]);
    expect(
      one(ds('g', http('https://api.example.com/v1/$param.city/x', { secrets: ['sec_AAAAAAAAAAAAAAAA'] }))),
    ).toEqual([
      'Dataset "g" (URL path): a source with secrets takes filters only in query values and the body, never in the path (filter "city")',
    ]);
    expect(one(ds('h', http('https://api.example.com/x#$param.city')))).toEqual([
      'Dataset "h" (URL): Filters cannot be part of the fragment (#…) of an address',
    ]);
  });

  it('refuses a history over a source that uses filters, not over steps that do', () => {
    const one = (dataset: unknown) => issues(docOf(dataset));
    expect(one(ds('h', http('https://api.example.com/x?r=$param.region'), { accumulate: 10 }))).toEqual([
      'Dataset "h" keeps a history (accumulate) and its source uses filters, so every view would restart it; accumulate a dataset without filters and filter in a dataset derived from it',
    ]);
    expect(
      one(
        ds('i', http('https://api.example.com/x'), {
          accumulate: 10,
          transforms: [{ type: 'filter', expr: '$param.region == null || region == $param.region' }],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses filters in table rules and sound conditions', () => {
    const doc = {
      ...docOf(ds('s', { kind: 'inline', rows: [{ a: 1 }] })),
      widgets: [
        {
          id: 't',
          type: 'table',
          datasetId: 's',
          config: { rules: [{ when: 'a == $param.region', color: 'negative' }] },
        },
        {
          id: 'k',
          type: 'kpi',
          datasetId: 's',
          config: { field: 'a' },
          sound: { trigger: { kind: 'condition', expr: 'a > $param.city' } },
        },
      ],
      layout: [
        { i: 't', x: 0, y: 0, w: 6, h: 4 },
        { i: 'k', x: 6, y: 0, w: 3, h: 2 },
      ],
    };
    expect(issues(doc)).toEqual([
      'Widget "t": filters ($param) work in datasets only, not in table rules',
      'Widget "k": filters ($param) work in datasets only, not in sound conditions',
    ]);
  });

  it('names no filters when none are declared', () => {
    const doc = {
      ...emptyDashboard('t'),
      datasets: [ds('a', http('https://api.example.com/x?r=$param.region'))],
    };
    expect(issues(doc)).toEqual([
      'Dataset "a" (URL query): unknown filter "region"; no filters are declared',
    ]);
  });
});
