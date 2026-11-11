import { applyOps, emptyDashboard } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  deleteBlocker,
  derivedDraft,
  refreshLine,
  secretsTooltip,
  sourceCandidates,
} from './dataset-lineage.ts';

const doc = applyOps(emptyDashboard('t'), [
  {
    op: 'addDataset',
    dataset: {
      id: 'orders',
      name: 'Orders API',
      source: { kind: 'http', url: 'https://api.example.com/orders', secrets: ['sec_AAAAAAAAAAAAAAAA'] },
    },
  },
  {
    op: 'addDataset',
    dataset: {
      id: 'ba',
      name: 'Weather Bratislava',
      source: { kind: 'connector', connector: 'weather.forecast', params: {} },
      refreshSec: 30,
    },
  },
  {
    op: 'addDataset',
    dataset: {
      id: 'both',
      name: 'Temps (both cities)',
      source: { kind: 'dataset', id: 'ba' },
      transforms: [{ type: 'union', with: ['orders'] }],
    },
  },
  { op: 'addDataset', dataset: { id: 'hum', name: 'Humidity', source: { kind: 'dataset', id: 'ba' } } },
  { op: 'addDataset', dataset: { id: 'deep', name: 'Deep', source: { kind: 'dataset', id: 'hum' } } },
]).doc;

describe('dataset editor helpers', () => {
  it('offers every dataset except the edited one and what is built on it', () => {
    expect(sourceCandidates(doc, 'hum').map((d) => d.id)).toEqual(['orders', 'ba', 'both']);
    expect(sourceCandidates(doc, null).map((d) => d.id)).toEqual(['orders', 'ba', 'both', 'hum', 'deep']);
  });

  it('names the datasets that block a delete', () => {
    expect(deleteBlocker(doc, 'ba')).toBe(
      'Used by Temps (both cities), Humidity. Delete or re-point those first.',
    );
    expect(deleteBlocker(doc, 'deep')).toBeNull();
  });

  it('blocks deleting a dataset a filter takes its choices from', () => {
    const filter = {
      id: 'reg',
      label: 'Region',
      type: 'select',
      optionsFrom: { dataset: 'deep', field: 'r' },
      all: 'All',
      default: null,
    } as const;
    const withFilter = applyOps(doc, [{ op: 'addParameter', parameter: filter }]).doc;
    expect(deleteBlocker(withFilter, 'deep')).toBe('Used by filter Region. Delete or re-point those first.');
    const both = applyOps(doc, [
      { op: 'addParameter', parameter: { ...filter, optionsFrom: { dataset: 'ba', field: 'r' } } },
    ]).doc;
    expect(deleteBlocker(both, 'ba')).toBe(
      'Used by Temps (both cities), Humidity, filter Region. Delete or re-point those first.',
    );
  });

  it('says where secrets come from and when derived data refreshes', () => {
    expect(secretsTooltip(doc, 'orders')).toBe('Uses secrets');
    expect(secretsTooltip(doc, 'both')).toBe('Uses secrets via Orders API');
    expect(secretsTooltip(doc, 'hum')).toBeNull();
    expect(refreshLine(doc, 'ba')).toBe('Refreshes with Weather Bratislava (every 30 s)');
    expect(refreshLine(doc, 'orders')).toBe('Loads once');
  });

  it('drafts a derived dataset with a free id and no interval of its own', () => {
    expect(derivedDraft(doc, 'ba')).toEqual({
      id: 'weather-bratislava-derived',
      name: 'Weather Bratislava (derived)',
      source: { kind: 'dataset', id: 'ba' },
      transforms: [],
      refreshSec: 0,
      accumulate: 0,
    });
  });
});
