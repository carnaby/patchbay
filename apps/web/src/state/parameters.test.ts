import {
  type DashboardDoc,
  DashboardDocSchema,
  type DatasetResult,
  inferTable,
  type Parameter,
  ParameterSchema,
} from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  applyValue,
  choicesOfResult,
  dataPickProblem,
  dataValueReady,
  guardAction,
  heldDataValue,
  normalizeRaw,
  optionsRefresh,
  pendingDataValue,
  pickRaw,
  rawFromSearch,
  rawQuery,
  resumed,
  searchWith,
  staleDataValue,
  summaryOf,
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

describe('describing a view', () => {
  it('says what a screen shows, or only what differs from the defaults for a link', () => {
    expect(summaryOf(parameters, { region: 'eu' })).toBe('Region: EU · Period: Last 7 days');
    expect(summaryOf(parameters, { region: 'eu', q: 'shoes' }, true)).toBe('Region: EU · Search: "shoes"');
    expect(summaryOf(parameters, {}, true)).toBe('');
    expect(summaryOf(undefined, {})).toBe('');
  });
});

describe('choices from data in the browser', () => {
  const country = ParameterSchema.parse({
    id: 'country',
    label: 'Country',
    type: 'select',
    optionsFrom: { dataset: 'countries', field: 'code' },
    all: 'All',
    default: null,
  });

  it('keeps a value until the choices are loaded, then knows whether it went stale', () => {
    expect(normalizeRaw([country], { country: 'AT' }, NOW).raw).toEqual({ country: 'AT' });
    expect(staleDataValue(country, { country: 'AT' }, null)).toBe(false);
    expect(staleDataValue(country, { country: 'AT' }, ['AT', 'SK'])).toBe(false);
    expect(staleDataValue(country, { country: 'DE' }, ['AT', 'SK'])).toBe(true);
    expect(staleDataValue(country, {}, ['AT'])).toBe(false);
    expect(staleDataValue(region, { region: 'eu' }, ['AT'])).toBe(false);
  });

  it('keeps a pinned value when a refresh returns no choices at all', () => {
    expect(staleDataValue(country, { country: 'AT' }, [])).toBe(false);
  });

  it('reads the choices of a result, and knows when they can never arrive', () => {
    const table = inferTable([{ code: 'SK' }, { code: 'AT' }, { code: 'SK' }]);
    const result: DatasetResult = {
      datasetId: 'countries',
      table,
      fetchedAt: '',
      hash: '',
      truncated: false,
    };
    expect(choicesOfResult('code', result, false)).toEqual({ options: ['AT', 'SK'], failed: false });
    // The same result twice gives the same list: a store selector reading it must stay stable.
    expect(choicesOfResult('code', result, false).options).toBe(
      choicesOfResult('code', result, false).options,
    );
    expect(choicesOfResult('code', undefined, false)).toEqual({ options: null, failed: false });
    expect(choicesOfResult('code', undefined, true)).toEqual({ options: null, failed: true });
    expect(choicesOfResult('code', { ...result, error: 'Upstream answered 500' }, false)).toEqual({
      options: null,
      failed: true,
    });
  });

  it('shows the value a link holds while the choices load, after they failed, or when they lack it', () => {
    const loading = { options: null, failed: false };
    const failed = { options: null, failed: true };
    expect(heldDataValue(country, { country: 'AT' }, loading)).toBe('AT');
    expect(heldDataValue(country, { country: 'AT' }, failed)).toBe('AT');
    expect(heldDataValue(country, { country: 'AT' }, { options: [], failed: false })).toBe('AT');
    expect(heldDataValue(country, { country: 'AT' }, { options: ['AT'], failed: false })).toBeNull();
    expect(heldDataValue(country, {}, failed)).toBeNull();
    expect(heldDataValue(region, { region: 'eu' }, failed)).toBeNull();
  });

  it('refuses a click on a data-driven select whose choices failed or lack the value', () => {
    const loaded = { options: ['AT', 'SK'], failed: false };
    expect(dataPickProblem(country, 'AT', { options: null, failed: true })).toBe(
      'The Country choices could not be loaded',
    );
    expect(dataPickProblem(country, 'DE', loaded)).toBe('DE is not one of the Country choices');
    expect(dataPickProblem(country, 'AT', loaded)).toBeNull();
    // While loading the server decides; a reset is always allowed; a fixed list is checked by the store.
    expect(dataPickProblem(country, 'DE', { options: null, failed: false })).toBeNull();
    expect(dataPickProblem(country, null, { options: null, failed: true })).toBeNull();
    expect(dataPickProblem(region, 'xx', { options: null, failed: true })).toBeNull();
    expect(dataPickProblem(undefined, 'xx', loaded)).toBeNull();
  });

  it('lets a request carry a data-driven value once the choices hold it or failed, never before', () => {
    const at = { country: 'AT' };
    expect(dataValueReady(country, at, { options: null, failed: false })).toBe(false);
    expect(dataValueReady(country, at, { options: ['AT'], failed: false })).toBe(true);
    // Not a choice: the guard resets it before any request.
    expect(dataValueReady(country, { country: 'Mars' }, { options: ['AT'], failed: false })).toBe(false);
    // Failed, or a refresh with no rows that the guard keeps: the server answers.
    expect(dataValueReady(country, at, { options: null, failed: true })).toBe(true);
    expect(dataValueReady(country, at, { options: [], failed: false })).toBe(true);
    expect(dataValueReady(country, {}, { options: null, failed: false })).toBe(true);
    expect(dataValueReady(region, { region: 'eu' }, { options: null, failed: false })).toBe(true);
  });

  describe('a pinned data-driven value on a wall screen', () => {
    it('resets outside presentation, holds while presenting on a live list, resets on a static list', () => {
      expect(guardAction(true, false, true)).toBe('reset');
      expect(guardAction(true, true, true)).toBe('hold');
      expect(guardAction(true, true, false)).toBe('reset');
      expect(guardAction(false, true, true)).toBeNull();
    });
    it('never resets or holds for an empty list, also while presenting', () => {
      expect(guardAction(staleDataValue(country, { country: 'AT' }, []), true, true)).toBeNull();
      expect(guardAction(staleDataValue(country, { country: 'AT' }, []), false, true)).toBeNull();
    });
    it('names the pending value only once a loaded list that can bring it back lacks it', () => {
      expect(
        pendingDataValue(country, { country: 'DE' }, { options: ['AT', 'SK'], failed: false }, true),
      ).toBe('DE');
      // A static list cannot bring the value back: the guard resets it, so nothing is held, not even for a frame.
      expect(
        pendingDataValue(country, { country: 'DE' }, { options: ['AT', 'SK'], failed: false }, false),
      ).toBeNull();
      expect(
        pendingDataValue(country, { country: 'AT' }, { options: ['AT', 'SK'], failed: false }, true),
      ).toBeNull();
      expect(pendingDataValue(country, { country: 'DE' }, { options: null, failed: false }, true)).toBeNull(); // loading
      expect(pendingDataValue(country, { country: 'DE' }, { options: null, failed: true }, true)).toBeNull(); // failed
      expect(pendingDataValue(country, { country: 'DE' }, { options: [], failed: false }, true)).toBeNull(); // empty
    });
    it('resumes: the same value is ready again once the list holds it', () => {
      expect(dataValueReady(country, { country: 'DE' }, { options: ['AT'], failed: false })).toBe(false);
      expect(dataValueReady(country, { country: 'DE' }, { options: ['AT', 'DE'], failed: false })).toBe(true);
    });
    it('refetches once, when a hold ends', () => {
      expect(resumed(true, false)).toBe(true);
      expect(resumed(true, true)).toBe(false);
      expect(resumed(false, false)).toBe(false);
      expect(resumed(false, true)).toBe(false);
    });

    const connector = { kind: 'connector', connector: 'weather.forecast', params: {} };
    const inline = { kind: 'inline', rows: [{ code: 'AT' }] };
    const docOf = (...datasets: Record<string, unknown>[]): DashboardDoc =>
      DashboardDocSchema.parse({
        schemaVersion: 1,
        title: 't',
        datasets: datasets.map((d) => ({ name: String(d.id), ...d })),
      });
    it('holds only for a list that refreshes from a source that can change', () => {
      expect(optionsRefresh(docOf({ id: 'countries', source: connector, refreshSec: 60 }), 'countries')).toBe(
        true,
      );
      expect(optionsRefresh(docOf({ id: 'countries', source: connector, refreshSec: 0 }), 'countries')).toBe(
        false,
      );
      // Inline rows never change on a timer, whatever refreshSec says.
      expect(optionsRefresh(docOf({ id: 'countries', source: inline, refreshSec: 60 }), 'countries')).toBe(
        false,
      );
      const derived = { id: 'countries', source: { kind: 'dataset', id: 'raw' } };
      expect(
        optionsRefresh(docOf({ id: 'raw', source: connector, refreshSec: 60 }, derived), 'countries'),
      ).toBe(true);
      expect(optionsRefresh(docOf({ id: 'raw', source: inline, refreshSec: 60 }, derived), 'countries')).toBe(
        false,
      );
      expect(optionsRefresh(docOf({ id: 'raw', source: connector, refreshSec: 60 }), 'gone')).toBe(false);
    });
  });
});
