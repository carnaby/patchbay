import { applyOps, emptyDashboard, type Parameter, ParameterSchema, parse } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  chosenOrFirst,
  filterPreset,
  filtersTooltip,
  insertAt,
  refChoices,
  urlPlaceAt,
  wholeRef,
} from './parameter-refs.ts';

const region = ParameterSchema.parse({
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu' }, { value: 'us' }],
  all: 'All',
  default: null,
});
const city = ParameterSchema.parse({
  id: 'city',
  label: 'City',
  type: 'select',
  options: [{ value: 'ba' }],
  default: 'ba',
});
const q = ParameterSchema.parse({ id: 'q', label: 'Search', type: 'text' });
const period = ParameterSchema.parse({
  id: 'period',
  label: 'Period',
  type: 'dateRange',
  presets: ['last7d'],
  default: 'last7d',
});
const parameters: Parameter[] = [region, city, q, period];
const texts = (place: Parameters<typeof refChoices>[1], secrets = false) =>
  refChoices(parameters, place, { secrets }).map((c) => c.text);

describe('inserting filter references', () => {
  it('offers only the references validation accepts at the place', () => {
    expect(texts('filter')).toEqual([
      '$param.region',
      '$param.city',
      '$param.q',
      '$param.period.from',
      '$param.period.to',
      '$param.period.start',
      '$param.period.end',
    ]);
    expect(texts('urlQuery')).toEqual([
      '$param.region',
      '$param.city',
      '$param.period.from',
      '$param.period.to',
      '$param.period.start',
      '$param.period.end',
    ]);
    expect(texts('urlPath')).toEqual(['$param.city']);
    expect(texts('urlPath', true)).toEqual([]);
    expect(refChoices([period], 'body', { secrets: false })[0]).toEqual({
      text: '$param.period.from',
      label: 'Period (first day)',
    });
  });

  it('knows where a caret in a URL can take a reference', () => {
    const url = 'https://api.example.com/v1/?region=&x=1';
    expect(urlPlaceAt(url, url.indexOf('/?') + 1)).toBe('urlPath');
    expect(urlPlaceAt(url, url.indexOf('=') + 1)).toBe('urlQuery');
    expect(urlPlaceAt(url, 10)).toBeNull();
    expect(urlPlaceAt('https://a.example/v1/sales', 'https://a.example/v1/'.length)).toBeNull();
    expect(urlPlaceAt(url, url.length)).toBeNull();
  });

  it('inserts at the caret and says where the caret goes', () => {
    expect(insertAt('a ==  && b', 5, 5, '$param.q')).toEqual({ value: 'a == $param.q && b', caret: 13 });
  });

  it('writes the "Match a filter" expression for each kind', () => {
    expect(filterPreset(region, 'region')).toBe('$param.region == null || region == $param.region');
    expect(filterPreset(city, 'city')).toBe('city == $param.city');
    expect(filterPreset(q, 'title')).toBe('$param.q == "" || contains(title, $param.q)');
    expect(filterPreset(period, 'order date')).toBe(
      '`order date` >= $param.period.start && `order date` < $param.period.end',
    );
    for (const p of parameters) expect(() => parse(filterPreset(p, 'x'))).not.toThrow();
  });

  it('names the filters a dataset changes with, and recognises a whole reference', () => {
    const doc = applyOps(emptyDashboard('t'), [
      { op: 'addParameter', parameter: region },
      { op: 'addParameter', parameter: period },
      {
        op: 'addDataset',
        dataset: {
          id: 's',
          name: 'S',
          source: { kind: 'http', url: 'https://a.example/x?r=$param.region&f=$param.period.from' },
        },
      },
      { op: 'addDataset', dataset: { id: 'n', name: 'N', source: { kind: 'inline', rows: [] } } },
    ]).doc;
    expect(filtersTooltip(doc, 's')).toBe('Changes with Region, Period');
    expect(filtersTooltip(doc, 'n')).toBeNull();
    expect(wholeRef('$param.city')).toBe('$param.city');
    expect(wholeRef('city')).toBeNull();
    expect(wholeRef('$param.Bad')).toBeNull();
    expect(wholeRef(3)).toBeNull();
  });

  it('shows and uses the first choice until one that exists is picked', () => {
    // Match a filter on a slow API: no columns when the step is added, then the columns arrive.
    expect(chosenOrFirst('', [])).toBe('');
    expect(chosenOrFirst('', ['date', 'region'])).toBe('date');
    expect(chosenOrFirst('region', ['date', 'region'])).toBe('region');
    expect(chosenOrFirst('gone', ['date', 'region'])).toBe('date');
  });
});
