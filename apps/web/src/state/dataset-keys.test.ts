import { applyOps, type DashboardDoc, emptyDashboard, SoundRuleSchema } from '@patchbay/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  datasetInSync,
  datasetKey,
  datasetKeyFor,
  draftParameterIds,
  draftView,
  followsCalendar,
  lineageKey,
  nextRefetch,
  queryOfView,
  refreshTiming,
  soundIdentity,
  viewKey,
} from './dataset-keys.ts';

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

describe('dataset keys by view', () => {
  const region = {
    id: 'region',
    label: 'Region',
    type: 'select' as const,
    options: [{ value: 'eu' }, { value: 'us' }, { value: 'a&b' }],
    all: 'All',
    default: null,
  };
  const period = {
    id: 'period',
    label: 'Period',
    type: 'dateRange' as const,
    presets: ['last7d' as const, 'last30d' as const],
    custom: true,
    default: 'last7d' as const,
  };
  const filtered = applyOps(saved, [
    { op: 'addParameter', parameter: region },
    { op: 'addParameter', parameter: period },
    {
      op: 'addDataset',
      dataset: {
        id: 'eu',
        name: 'EU',
        source: { kind: 'dataset', id: 'w' },
        transforms: [{ type: 'filter', expr: '$param.region == null || region == $param.region' }],
      },
    },
    {
      op: 'addDataset',
      dataset: {
        id: 'recent',
        name: 'Recent',
        source: { kind: 'dataset', id: 'w' },
        transforms: [{ type: 'filter', expr: 'time >= $param.period.start' }],
      },
    },
  ]).doc;

  it('changes the key of exactly the datasets that use a filter, and only by the filters they use', () => {
    expect(viewKey(filtered, 'temps', { region: 'eu' })).toBe('');
    expect(datasetKey('d', filtered, 'eu', { region: 'eu' })).not.toEqual(
      datasetKey('d', filtered, 'eu', {}),
    );
    expect(datasetKey('d', filtered, 'temps', { region: 'eu' })).toEqual(
      datasetKey('d', filtered, 'temps', {}),
    );
    expect(viewKey(filtered, 'eu', { region: 'eu', period: 'last30d' })).toBe(
      viewKey(filtered, 'eu', { region: 'eu' }),
    );
    expect(datasetKeyFor('d', 'eu', 'L', 'V')).toEqual(['data', 'd', 'eu', 'L', 'V']);
    expect(queryOfView(viewKey(filtered, 'eu', { region: 'a&b' }))).toBe('&p.region=a%26b');
    expect(queryOfView(viewKey(filtered, 'eu', {}))).toBe('');
    expect(queryOfView('')).toBe('');
  });

  it('keys and queries only values the current declarations accept, before the URL is normalised', () => {
    // Another tab removed the option this link holds: the new document arrives before the URL effect resets the store.
    const withoutUs = applyOps(filtered, [
      { op: 'updateParameter', id: 'region', set: { options: [{ value: 'eu' }] } },
    ]).doc;
    const stale = { region: 'us', period: 'last30d' };
    expect(queryOfView(viewKey(withoutUs, 'eu', stale))).toBe('');
    expect(viewKey(withoutUs, 'eu', stale)).toBe(viewKey(withoutUs, 'eu', {}));
    expect(datasetKey('d', withoutUs, 'eu', stale)).toEqual(datasetKey('d', withoutUs, 'eu', {}));
    // Hand-edited values, a value equal to the default, and a prototype name are never sent either.
    expect(queryOfView(viewKey(filtered, 'recent', { period: '2026-02-30..2026-03-01' }))).toBe('');
    expect(queryOfView(viewKey(filtered, 'recent', { period: 'last7d' }))).toBe('');
    expect(queryOfView(viewKey(filtered, 'recent', { period: 'last30d' }))).toBe('&p.period=last30d');
    expect(followsCalendar(filtered, 'recent', { period: '2026-02-30..2026-03-01' })).toBe(true);
    const proto = JSON.parse('{"__proto__":"x","region":"eu"}') as Record<string, string>;
    expect(queryOfView(viewKey(filtered, 'eu', proto))).toBe('&p.region=eu');
  });

  it('waits for the save of a changed declaration that a dataset uses', () => {
    const more = applyOps(filtered, [
      { op: 'updateParameter', id: 'region', set: { options: [...region.options, { value: 'apac' }] } },
    ]).doc;
    expect(datasetInSync(filtered, more, 'eu')).toBe(false);
    expect(datasetInSync(filtered, more, 'temps')).toBe(true);
    expect(datasetInSync(filtered, filtered, 'eu')).toBe(true);
  });

  it('takes a new sound baseline on every change of view, and none at midnight', () => {
    const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
    const eu = soundIdentity(filtered, rule, 'eu', { region: 'eu' });
    // The tracker keeps only the last identity, so going back to a value is a change as well.
    expect(soundIdentity(filtered, rule, 'eu', {})).not.toBe(eu);
    expect(soundIdentity(filtered, rule, 'eu', { region: 'eu' })).toBe(eu);
    expect(soundIdentity(filtered, rule, 'temps', { region: 'eu' })).toBe(
      soundIdentity(filtered, rule, 'temps'),
    );
  });

  describe('across midnight UTC', () => {
    afterEach(() => vi.useRealTimers());

    it('keeps the sound identity and the view of a relative period: an ordinary refresh, no baseline', () => {
      const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
      const before = soundIdentity(filtered, rule, 'recent', {});
      const viewBefore = viewKey(filtered, 'recent', {});
      vi.setSystemTime(new Date('2026-11-11T00:01:00Z'));
      expect(soundIdentity(filtered, rule, 'recent', {})).toBe(before);
      expect(viewKey(filtered, 'recent', {})).toBe(viewBefore);
    });
  });

  it('refetches a relative period right after midnight UTC, and nothing else on its account', () => {
    expect(followsCalendar(filtered, 'recent', {})).toBe(true);
    expect(followsCalendar(filtered, 'recent', { period: '2026-01-01..2026-01-31' })).toBe(false);
    expect(followsCalendar(filtered, 'eu', {})).toBe(false);
    const late = Date.parse('2026-11-10T23:59:00Z');
    expect(nextRefetch(false, true, late)).toBe(120_000);
    expect(nextRefetch(30_000, true, late)).toBe(30_000);
    expect(nextRefetch(5_000, false, late)).toBe(5_000);
    expect(nextRefetch(false, false, late)).toBe(false);
  });

  it('lists the filters a draft reads, its own and through its source', () => {
    expect(
      draftParameterIds(filtered, {
        source: { kind: 'dataset', id: 'eu' },
        transforms: [{ type: 'filter', expr: '$param.period.start < 1' }],
      }),
    ).toEqual(['period', 'region']);
    expect(draftParameterIds(null, { source: { kind: 'inline', rows: [] }, transforms: [] })).toEqual([]);
  });

  it('previews a draft with the saved declarations in its key and only values they accept', () => {
    const draft = {
      source: { kind: 'dataset' as const, id: 'w' },
      transforms: [{ type: 'filter' as const, expr: '$param.region == null || region == $param.region' }],
    };
    const view = draftView(filtered, filtered, draft, { region: 'eu' });
    expect(view.values).toEqual({ region: 'eu' });
    // A new default changes what the server answers for the same link: the preview asks again.
    const newDefault = applyOps(filtered, [
      { op: 'updateParameter', id: 'region', set: { default: 'us' } },
    ]).doc;
    expect(draftView(newDefault, newDefault, draft, { region: 'eu' }).key).not.toBe(view.key);
    // A value the saved declaration no longer has is not sent.
    const withoutEu = applyOps(filtered, [
      { op: 'updateParameter', id: 'region', set: { options: [{ value: 'us' }] } },
    ]).doc;
    expect(draftView(withoutEu, withoutEu, draft, { region: 'eu' }).values).toEqual({});
    // A filter the draft reads before it is declared, then once it is saved.
    const city = { ...draft, transforms: [{ type: 'filter' as const, expr: 'city == $param.city' }] };
    const declared = applyOps(filtered, [
      {
        op: 'addParameter',
        parameter: { id: 'city', label: 'City', type: 'text', default: '' },
      },
    ]).doc;
    expect(draftView(declared, declared, city, {}).key).not.toBe(draftView(filtered, filtered, city, {}).key);
    expect(draftView(null, filtered, city, { city: 'x' }).values).toEqual({});
  });
});
