import { type Parameter, ParameterSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  applyValue,
  normalizeRaw,
  pickRaw,
  rawFromSearch,
  rawQuery,
  searchWith,
  useParameters,
} from './parameters.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const region = ParameterSchema.parse({
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [
    { value: 'eu', label: 'EU' },
    { value: 'us', label: 'US' },
  ],
  all: 'All regions',
  default: null,
});
const q = ParameterSchema.parse({ id: 'q', label: 'Search', type: 'text' });
const period = ParameterSchema.parse({
  id: 'period',
  label: 'Period',
  type: 'dateRange',
  presets: ['last7d', 'last30d'],
  custom: true,
  default: 'last7d',
});
const parameters: Parameter[] = [region, q, period];

describe('filter values in the page URL', () => {
  it('reads p.<id>, the first of each, without prototype surprises', () => {
    const raw = rawFromSearch(new URLSearchParams('present=1&p.region=eu&p.region=us&p.__proto__=x'));
    expect(Object.entries(raw)).toEqual([
      ['region', 'eu'],
      ['__proto__', 'x'],
    ]);
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
  });

  it('writes the filters sorted after everything else of the URL, which it keeps', () => {
    expect(
      searchWith(new URLSearchParams('present=1&p.old=1&edit=1'), {
        region: 'eu',
        period: 'last30d',
      }).toString(),
    ).toBe('present=1&edit=1&p.period=last30d&p.region=eu');
    expect(rawQuery({ q: 'a b&c', region: 'eu' })).toBe('p.q=a%20b%26c&p.region=eu');
    expect(rawQuery({})).toBe('');
    expect(pickRaw({ region: 'eu', q: 'x' }, ['region', 'period'])).toEqual({ region: 'eu' });
  });

  it('keeps valid values that differ from their default and names the invalid ones', () => {
    const { raw, problems } = normalizeRaw(
      parameters,
      { region: 'xx', q: '  shoes ', period: 'last7d', gone: '1' },
      NOW,
    );
    expect(raw).toEqual({ q: 'shoes' });
    expect(problems).toEqual([
      { id: 'region', message: 'Filter "region" has no value "xx"; choose one of eu, us, or * for all' },
    ]);
    expect(normalizeRaw(undefined, { region: 'eu' }, NOW)).toEqual({ raw: {}, problems: [] });
    expect(
      normalizeRaw(
        parameters,
        Object.fromEntries([
          ['constructor', 'x'],
          ['__proto__', 'y'],
        ]),
        NOW,
      ).raw,
    ).toEqual({});
  });

  it('resets a value whose option or filter an editor removed while the link was open', () => {
    const fewer = [ParameterSchema.parse({ ...region, options: [{ value: 'eu' }] }), q, period];
    expect(normalizeRaw(fewer, { region: 'us', q: 'x' }, NOW)).toEqual({
      raw: { q: 'x' },
      problems: [
        { id: 'region', message: 'Filter "region" has no value "us"; choose one of eu, or * for all' },
      ],
    });
    expect(normalizeRaw([region, period], { region: 'eu', q: 'x' }, NOW)).toEqual({
      raw: { region: 'eu' },
      problems: [],
    });
  });

  it('applies a change, drops a value back at its default, and refuses an invalid one', () => {
    expect(applyValue(parameters, {}, 'region', 'eu', NOW)).toEqual({ raw: { region: 'eu' } });
    expect(applyValue(parameters, { region: 'eu' }, 'region', '*', NOW)).toEqual({ raw: {} });
    expect(applyValue(parameters, { region: 'eu' }, 'region', null, NOW)).toEqual({ raw: {} });
    expect(applyValue(parameters, {}, 'q', '  hi  ', NOW)).toEqual({ raw: { q: 'hi' } });
    expect(applyValue(parameters, {}, 'period', '2026-01-01..2026-01-31', NOW)).toEqual({
      raw: { period: '2026-01-01..2026-01-31' },
    });
    expect(applyValue(parameters, {}, 'region', 'xx', NOW)).toEqual({
      problem: 'Filter "region" has no value "xx"; choose one of eu, us, or * for all',
    });
  });

  it('remembers whether the next URL change replaces the entry or pushes one', () => {
    useParameters.setState({ dashboardId: 'd', raw: {}, history: 'replace' });
    expect(useParameters.getState().set('region', 'eu', parameters, 'push')).toBeNull();
    expect(useParameters.getState()).toMatchObject({ raw: { region: 'eu' }, history: 'push' });
    // The same value again is no change and leaves the history mode alone.
    useParameters.getState().set('region', 'eu', parameters);
    expect(useParameters.getState().history).toBe('push');
    expect(useParameters.getState().set('region', 'xx', parameters)).toMatch(/has no value "xx"/);
    useParameters.getState().reset();
    expect(useParameters.getState()).toMatchObject({ raw: {}, history: 'replace' });
  });
});
