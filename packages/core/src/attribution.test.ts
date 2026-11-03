import { describe, expect, it } from 'vitest';
import { creditLine, widgetAttributions } from './attribution.ts';

const connector = (id: string, c: string) => ({
  id,
  source: { kind: 'connector' as const, connector: c, params: {} },
  transforms: [],
});
const widget = (datasetId: string) => ({ type: 'kpi' as const, datasetId });

describe('creditLine', () => {
  it('prefixes only the credits that do not already say they are data', () => {
    expect(creditLine(['Data provided by CoinGecko', 'U.S. Geological Survey'])).toBe(
      'Data provided by CoinGecko · Data: U.S. Geological Survey',
    );
    expect(creditLine([])).toBe('');
  });
});

describe('widgetAttributions', () => {
  const datasets = [
    connector('a', 'weather-now'),
    connector('b', 'weather-forecast'),
    connector('c', 'crypto'),
    { id: 'u', source: { kind: 'upload' as const, fileId: 'f' }, transforms: [] },
  ];
  const credits = { 'weather-now': 'Open-Meteo', 'weather-forecast': 'Open-Meteo', crypto: 'CoinGecko' };

  it('lists each source once, in widget order', () => {
    expect(widgetAttributions(datasets, [widget('c'), widget('a'), widget('b')], credits)).toEqual([
      'CoinGecko',
      'Open-Meteo',
    ]);
  });

  it('ignores uploads, widgets without data and unknown connectors', () => {
    expect(widgetAttributions(datasets, [widget('u'), { type: 'text' }, widget('zz')], credits)).toEqual([]);
    expect(widgetAttributions([connector('x', 'nope')], [widget('x')], credits)).toEqual([]);
  });
});

it('credits the connector behind a derived or combined dataset', () => {
  const datasets = [
    {
      id: 'w',
      source: { kind: 'connector' as const, connector: 'weather.forecast', params: {} },
      transforms: [],
    },
    { id: 'p', source: { kind: 'inline' as const, rows: [] }, transforms: [] },
    {
      id: 'mix',
      source: { kind: 'dataset' as const, id: 'p' },
      transforms: [{ type: 'join' as const, with: 'w', on: ['day'], how: 'left' as const }],
    },
  ];
  expect(
    widgetAttributions(datasets, [{ type: 'chart', datasetId: 'mix' } as never], {
      'weather.forecast': 'Open-Meteo',
    }),
  ).toEqual(['Open-Meteo']);
});
