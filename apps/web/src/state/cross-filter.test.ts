import { ChartConfigSchema, type Parameter, ParameterSchema, WidgetSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { chartPatch, crossFilterClick } from './cross-filter.ts';
import { useParameters } from './parameters.ts';

const region = ParameterSchema.parse({
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [{ value: 'eu' }, { value: 'us' }],
  all: 'All',
  default: null,
});
const parameters: Parameter[] = [region];
const bars = WidgetSchema.parse({
  id: 'b',
  type: 'chart',
  datasetId: 's',
  config: { kind: 'bar', x: 'region', y: ['v'], crossFilter: { parameter: 'region', field: 'region' } },
});

describe('clicks that set a filter', () => {
  it('sets the clicked value, resets on the selected one, and does nothing while presenting', () => {
    expect(crossFilterClick(bars, parameters, {}, 'eu', false)).toEqual({ id: 'region', text: 'eu' });
    expect(crossFilterClick(bars, parameters, { region: 'eu' }, 'eu', false)).toEqual({
      id: 'region',
      text: null,
    });
    expect(crossFilterClick(bars, parameters, { region: 'eu' }, 'us', false)).toEqual({
      id: 'region',
      text: 'us',
    });
    // An unattended screen: a tap changes nothing, says nothing.
    expect(crossFilterClick(bars, parameters, {}, 'eu', true)).toBeNull();
    expect(crossFilterClick(bars, parameters, {}, 'EU-West', false)).toEqual({
      problem: 'EU-West is not one of the Region choices',
    });
    expect(crossFilterClick(bars, [], {}, 'eu', false)).toBeNull();
    const plain = WidgetSchema.parse({
      id: 'p',
      type: 'chart',
      datasetId: 's',
      config: { kind: 'bar', x: 'region', y: ['v'] },
    });
    expect(crossFilterClick(plain, parameters, {}, 'eu', false)).toBeNull();
  });

  it('pushes a history entry per click, so Back undoes it', () => {
    useParameters.setState({ dashboardId: 'd', raw: {}, history: 'replace' });
    const result = crossFilterClick(bars, parameters, useParameters.getState().raw, 'eu', false);
    expect(result).toEqual({ id: 'region', text: 'eu' });
    const { id, text } = result as { id: string; text: string | null };
    expect(useParameters.getState().set(id, text, parameters, 'push')).toBeNull();
    expect(useParameters.getState()).toMatchObject({ raw: { region: 'eu' }, history: 'push' });
  });

  it('keeps a chart cross-filter valid when its kind, x or series change', () => {
    const config = ChartConfigSchema.parse({
      kind: 'bar',
      x: 'region',
      y: ['v'],
      series: 'kind',
      crossFilter: { parameter: 'region', field: 'region' },
    });
    expect(chartPatch(config, { x: 'country' })).toEqual({
      x: 'country',
      crossFilter: { parameter: 'region', field: 'country' },
    });
    expect(chartPatch(config, { kind: 'heatmap' })).toEqual({ kind: 'heatmap', crossFilter: undefined });
    expect(chartPatch(config, { kind: 'pie' })).toEqual({ kind: 'pie' });
    const bySeries = { ...config, crossFilter: { parameter: 'region', field: 'kind' } };
    expect(chartPatch(bySeries, { series: undefined })).toEqual({
      series: undefined,
      crossFilter: undefined,
    });
    expect(chartPatch(bySeries, { kind: 'donut' })).toEqual({ kind: 'donut', crossFilter: undefined });
    expect(chartPatch(ChartConfigSchema.parse({ kind: 'bar', x: 'a', y: ['v'] }), { x: 'b' })).toEqual({
      x: 'b',
    });
  });
});
