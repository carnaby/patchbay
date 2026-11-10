import { applyOps, emptyDashboard, type Parameter, ParameterSchema, ParamIdSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  checkParameter,
  defaultOps,
  idFromLabel,
  newParameter,
  optionsText,
  parseOptions,
  updateOps,
  usageText,
} from './parameter-form.ts';

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
}) as Extract<Parameter, { type: 'select' }>;
const period = ParameterSchema.parse({
  id: 'period',
  label: 'Period',
  type: 'dateRange',
  presets: ['last7d', 'last30d'],
  custom: true,
  default: 'last7d',
});

describe('the Filters panel form', () => {
  it('derives valid, unique ids from labels', () => {
    expect(idFromLabel('Sales region', new Set())).toBe('sales_region');
    expect(idFromLabel('Nové Zámky', new Set())).toBe('nove_zamky');
    expect(idFromLabel('2026', new Set())).toBe('f_2026');
    expect(idFromLabel('', new Set())).toBe('f');
    expect(idFromLabel('Region', new Set(['region', 'region_2']))).toBe('region_3');
    expect(idFromLabel('x'.repeat(50), new Set())).toHaveLength(28);
    for (const label of ['Sales region', 'Nové Zámky', '2026', '', 'x'.repeat(50), '__a__', 'a_ _b'])
      expect(ParamIdSchema.safeParse(idFromLabel(label, new Set())).success, label).toBe(true);
  });

  it('starts each kind as a declaration that can be saved', () => {
    for (const type of ['select', 'text', 'dateRange'] as const) {
      const p = newParameter(type, new Set());
      expect(checkParameter(p, []), type).toEqual({ parameter: p });
    }
    expect(newParameter('select', new Set(['choice'])).id).toBe('choice_2');
  });

  it('reads and writes the options text, and keeps numbers an agent declared', () => {
    expect(parseOptions('eu | Europe\nus\n\n  apac  |  APAC ')).toEqual([
      { value: 'eu', label: 'Europe' },
      { value: 'us' },
      { value: 'apac', label: 'APAC' },
    ]);
    expect(parseOptions('2026\n2027', [{ value: 2026 }])).toEqual([{ value: 2026 }, { value: '2027' }]);
    expect(optionsText([{ value: 'eu', label: 'Europe' }, { value: 2026 }])).toBe('eu | Europe\n2026');
  });

  it('says why a declaration cannot be saved', () => {
    expect(checkParameter({ ...region, default: 'xx' }, [])).toEqual({
      error: 'Filter "region": the default "xx" is not one of its options',
    });
    expect(checkParameter({ ...region, id: 'Region' }, [])).toEqual({
      error: expect.stringContaining('Filter ids are 1-32 chars'),
    });
    expect(checkParameter(region, [region])).toEqual({
      error: 'Filter ids must be unique: "region" appears twice',
    });
  });

  it('sends only what changed, null for a removed field', () => {
    const { all: _all, ...noAll } = region;
    expect(updateOps(region, { ...noAll, default: 'eu' })).toEqual([
      { op: 'updateParameter', id: 'region', set: { all: null, default: 'eu' } },
    ]);
    expect(updateOps(region, region)).toEqual([]);
  });

  it('makes the current values the defaults, a period as its preset or its range', () => {
    expect(defaultOps([region, period], { region: 'us', period: '2026-01-01..2026-01-31' })).toEqual([
      { op: 'updateParameter', id: 'region', set: { default: 'us' } },
      { op: 'updateParameter', id: 'period', set: { default: { from: '2026-01-01', to: '2026-01-31' } } },
    ]);
    expect(defaultOps([period], { period: 'last30d' })).toEqual([
      { op: 'updateParameter', id: 'period', set: { default: 'last30d' } },
    ]);
    expect(defaultOps([region], { region: '*' })).toEqual([
      { op: 'updateParameter', id: 'region', set: { default: null } },
    ]);
    expect(defaultOps([region], {})).toEqual([]);
  });

  it('names what uses a filter, for the disabled Remove button', () => {
    const doc = applyOps(emptyDashboard('t'), [
      { op: 'addParameter', parameter: region },
      {
        op: 'addDataset',
        dataset: {
          id: 'sales',
          name: 'Sales',
          source: { kind: 'inline', rows: [] },
          transforms: [{ type: 'filter', expr: '$param.region == null || region == $param.region' }],
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'orders',
          name: 'Orders',
          source: { kind: 'http', url: 'https://api.example.com/o?r=$param.region' },
        },
      },
    ]).doc;
    expect(usageText(doc, 'region')).toBe('Used by Sales (filter step), Orders (URL query)');
    expect(usageText(doc, 'other')).toBeNull();
  });
});
