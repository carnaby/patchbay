import { applyOps, type DashboardDoc, emptyDashboard, SoundRuleSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { datasetInSync, datasetKey, lineageKey, refreshTiming, soundIdentity } from './dataset-keys.ts';

const saved: DashboardDoc = applyOps(emptyDashboard('t'), [
  {
    op: 'addDataset',
    dataset: {
      id: 'w',
      name: 'Weather',
      source: { kind: 'connector', connector: 'weather.forecast', params: {} },
      refreshSec: 900,
    },
  },
  { op: 'addDataset', dataset: { id: 'temps', name: 'Temps', source: { kind: 'dataset', id: 'w' } } },
  { op: 'addDataset', dataset: { id: 'other', name: 'Other', source: { kind: 'inline', rows: [{ a: 1 }] } } },
]).doc;
const parentEdited = applyOps(saved, [
  { op: 'addStep', datasetId: 'w', step: { type: 'filter', expr: 'temperature_2m > 0' } },
]).doc;
const otherEdited = applyOps(saved, [{ op: 'updateDataset', id: 'other', set: { name: 'Renamed' } }]).doc;

describe('dataset keys by lineage', () => {
  it('caches a key per document and follows each new document', () => {
    expect(lineageKey(saved, 'temps')).toBe(lineageKey(saved, 'temps'));
    expect(lineageKey(parentEdited, 'temps')).not.toBe(lineageKey(saved, 'temps'));
    expect(lineageKey(saved, 'missing')).toBe('[]');
  });

  it('changes a child key when its parent changes, and not for unrelated edits', () => {
    expect(datasetKey('d', parentEdited, 'temps')).not.toEqual(datasetKey('d', saved, 'temps'));
    expect(datasetKey('d', otherEdited, 'temps')).toEqual(datasetKey('d', saved, 'temps'));
  });

  it('does not fetch a child while its parent has unsaved edits', () => {
    expect(datasetInSync(saved, saved, 'temps')).toBe(true);
    expect(datasetInSync(saved, parentEdited, 'temps')).toBe(false);
    expect(datasetInSync(saved, otherEdited, 'temps')).toBe(true);
    expect(datasetInSync(null, saved, 'temps')).toBe(false);
  });

  it('takes a new sound baseline when the parent changes', () => {
    const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
    expect(soundIdentity(parentEdited, rule, 'temps')).not.toBe(soundIdentity(saved, rule, 'temps'));
    expect(soundIdentity(otherEdited, rule, 'temps')).toBe(soundIdentity(saved, rule, 'temps'));
    expect(soundIdentity(saved, rule, 'missing')).toBeNull();
  });

  it('polls only without the live channel, never faster than every 5 s', () => {
    expect(refreshTiming(900, true)).toEqual({ staleTime: 900_000, refetchInterval: false });
    expect(refreshTiming(1, false)).toEqual({ staleTime: 1000, refetchInterval: 5000 });
    expect(refreshTiming(0, false)).toEqual({ staleTime: 300_000, refetchInterval: false });
  });
});
