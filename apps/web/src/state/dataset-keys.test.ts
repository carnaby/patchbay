import { applyOps, type DashboardDoc, emptyDashboard, SoundRuleSchema, soundWindow } from '@patchbay/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.ts';
import {
  behindCalendar,
  choiceChecks,
  datasetInSync,
  datasetKey,
  datasetKeyFor,
  draftParameterIds,
  draftView,
  followsCalendar,
  lastFetch,
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

    it('takes a new sound baseline when a relative period moves to a new day, and keeps the data key', () => {
      const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
      const before = soundIdentity(filtered, rule, 'recent', {}, Date.parse('2026-11-10T23:59:59Z'));
      const after = soundIdentity(filtered, rule, 'recent', {}, Date.parse('2026-11-11T00:01:00Z'));
      const later = soundIdentity(filtered, rule, 'recent', {}, Date.parse('2026-11-11T18:00:00Z'));
      expect(after).not.toBe(before);
      expect(later).toBe(after);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
      const viewBefore = viewKey(filtered, 'recent', {});
      vi.setSystemTime(new Date('2026-11-11T00:01:00Z'));
      expect(viewKey(filtered, 'recent', {})).toBe(viewBefore);
    });

    it("takes the sound window from the server's answer, and from the client clock only without one", () => {
      const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
      const now = Date.parse('2026-11-11T09:00:00Z');
      const stated = (at: number) => ({ calendar: { window: soundWindow(['last7d'], at), validForSec: 1 } });
      // A newer server's answer after an older one's, mid-deploy: the same window is no new baseline.
      expect(soundIdentity(filtered, rule, 'recent', {}, now, stated(now))).toBe(
        soundIdentity(filtered, rule, 'recent', {}, now),
      );
      expect(soundIdentity(filtered, rule, 'recent', {}, now, {})).toBe(
        soundIdentity(filtered, rule, 'recent', {}, now),
      );
      // A client clock a day off still follows the window the rows were computed for.
      const server = Date.parse('2026-11-10T09:00:00Z');
      expect(soundIdentity(filtered, rule, 'recent', {}, now, stated(server))).toBe(
        soundIdentity(filtered, rule, 'recent', {}, server),
      );
    });

    it('keeps the identity of a dataset without a relative period across midnight', () => {
      const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows' } });
      const night = Date.parse('2026-11-10T23:59:59Z');
      const morning = Date.parse('2026-11-11T00:01:00Z');
      expect(soundIdentity(filtered, rule, 'temps', {}, night)).toBe(
        soundIdentity(filtered, rule, 'temps', {}, morning),
      );
      const fixed = { period: '2026-01-01..2026-01-31' };
      expect(soundIdentity(filtered, rule, 'recent', fixed, night)).toBe(
        soundIdentity(filtered, rule, 'recent', fixed, morning),
      );
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

  it('aims at the coming 00:01 UTC, never at the one a day later', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextRefetch(false, true, at('2026-11-10T23:59:00Z'))).toBe(120_000);
    // Inside the first minute the 00:01 still ahead is today's, not tomorrow's.
    expect(nextRefetch(false, true, at('2026-11-11T00:00:00Z'))).toBe(60_000);
    expect(nextRefetch(false, true, at('2026-11-11T00:00:30Z'))).toBe(30_000);
    expect(nextRefetch(false, true, at('2026-11-11T00:01:00Z'))).toBe(86_400_000);
    expect(nextRefetch(false, true, at('2026-11-11T00:01:00.001Z'))).toBe(86_399_999);
    expect(nextRefetch(false, true, at('2026-11-11T12:00:00Z'))).toBe(12 * 3_600_000 + 60_000);
    expect(nextRefetch(45_000, true, at('2026-11-11T00:00:30Z'))).toBe(30_000);
  });

  it('retries a relative period every minute until it has today’s window', () => {
    const at = (iso: string) => Date.parse(iso);
    const yesterday = at('2026-11-10T10:00:00Z');
    // Before 00:01 yesterday's result is still current; after it, it is behind until a refetch succeeds.
    expect(behindCalendar(at('2026-11-11T00:00:30Z'), { updatedAt: yesterday, failed: false })).toBe(false);
    expect(behindCalendar(at('2026-11-11T00:01:00Z'), { updatedAt: yesterday, failed: false })).toBe(true);
    expect(behindCalendar(at('2026-11-11T00:01:30Z'), { updatedAt: yesterday, failed: false })).toBe(true);
    const fetched = at('2026-11-11T00:01:00Z');
    expect(behindCalendar(at('2026-11-11T00:01:30Z'), { updatedAt: fetched, failed: false })).toBe(false);
    expect(behindCalendar(at('2026-11-11T09:00:00Z'), { updatedAt: fetched, failed: true })).toBe(true);
    expect(behindCalendar(at('2026-11-11T00:05:00Z'), { updatedAt: 0, failed: false })).toBe(true);

    // A failed 00:01 refetch is retried in a minute, not a day later; a good one waits for the next 00:01.
    const after = at('2026-11-11T00:01:03Z');
    expect(nextRefetch(false, true, after, { updatedAt: yesterday, failed: true })).toBe(60_000);
    expect(nextRefetch(false, true, after, { updatedAt: yesterday, failed: false })).toBe(60_000);
    expect(nextRefetch(false, true, after, { updatedAt: fetched, failed: false })).toBe(86_397_000);
    // A regular refresh already comes back on its own. A dataset off the calendar that never refreshes retries its
    // failure too, though not because of the calendar (no spread: this literal has none).
    expect(nextRefetch(300_000, true, after, { updatedAt: yesterday, failed: true })).toBe(300_000);
    expect(nextRefetch(false, false, after, { updatedAt: yesterday, failed: true })).toBe(60_000);
  });

  it('counts a result that carries an upstream error as a failed refetch', () => {
    const at = (iso: string) => Date.parse(iso);
    const fetched = at('2026-11-11T00:01:00Z');
    const later = at('2026-11-11T00:01:30Z');
    // A failing upstream answers 200 with `error`: query-core calls it a success, fetched just now.
    const inBand = lastFetch(
      {
        dataUpdatedAt: fetched,
        status: 'success',
        data: { error: 'Upstream responded 502' },
      },
      () => 0,
    );
    expect(inBand).toEqual({ updatedAt: fetched, failed: true });
    expect(nextRefetch(false, true, later, inBand)).toBe(60_000);
    const good = lastFetch(
      { dataUpdatedAt: fetched, status: 'success', data: { error: undefined } },
      () => 0,
    );
    expect(good).toEqual({ updatedAt: fetched, failed: false });
    expect(nextRefetch(false, true, later, good)).toBe(86_370_000);
    expect(lastFetch({ dataUpdatedAt: 0, status: 'error' }, () => 0).failed).toBe(true);
    expect(lastFetch({ dataUpdatedAt: 0, status: 'pending' }, () => 0).failed).toBe(false);
  });

  it('retries a relative period after network errors, 5xx and 429, not after other 4xx', () => {
    const at = Date.parse('2026-11-11T12:00:00Z');
    const err = (error: unknown) => lastFetch({ dataUpdatedAt: at, status: 'error', error }, () => 0);
    expect(err(new ApiError(404, 'gone', {})).failed).toBe(false);
    expect(err(new ApiError(403, 'secret deleted', {})).failed).toBe(false);
    expect(err(new ApiError(503, 'busy', {})).failed).toBe(true);
    expect(err(new ApiError(429, 'slow down', {})).failed).toBe(true);
    expect(err(new ApiError(408, 'timeout', {})).failed).toBe(true);
    expect(err(new TypeError('Failed to fetch')).failed).toBe(true);
    expect(
      lastFetch({ dataUpdatedAt: at, status: 'success', data: { error: 'upstream 500' } }, () => 0).failed,
    ).toBe(true);
  });

  it('asks again soon after a result the server refused for its own limits', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const refused = lastFetch(
      {
        dataUpdatedAt: now,
        status: 'success',
        data: { error: 'busy', retryAfterSec: 10 },
      },
      () => 0,
    );
    expect(refused).toEqual({ updatedAt: now, failed: true, retryAfterSec: 10 });
    expect(nextRefetch(false, false, now, refused)).toBe(10_000); // a dataset that never refreshes
    expect(nextRefetch(60_000, false, now, refused)).toBe(10_000); // sooner than its interval
    expect(nextRefetch(5_000, false, now, refused)).toBe(5_000); // never later than its interval
    expect(nextRefetch(false, true, now, refused)).toBe(10_000); // a relative period too
    expect(nextRefetch(false, false, now, { ...refused, retryAfterSec: 1 })).toBe(5_000); // floor 5 s
    expect(
      nextRefetch(
        false,
        false,
        now,
        lastFetch({ dataUpdatedAt: now, status: 'success', data: {} }, () => 0),
      ),
    ).toBe(false);
  });

  it('retries a dataset that never refreshes every minute after a transient failure, every quarter hour after a lasting one', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const inBand = (data: Record<string, unknown>, random = () => 0) =>
      lastFetch({ dataUpdatedAt: now, status: 'success', data }, random);
    const thrown = (error: unknown) => lastFetch({ dataUpdatedAt: now, status: 'error', error }, () => 0);
    expect(nextRefetch(false, false, now, inBand({ error: 'Upstream responded 503' }))).toBe(60_000);
    expect(nextRefetch(false, false, now, inBand({ error: 'gone', lasting: true }))).toBe(900_000);
    expect(nextRefetch(false, false, now, thrown(new ApiError(503, 'busy', {})))).toBe(60_000);
    expect(nextRefetch(false, false, now, thrown(new TypeError('Failed to fetch')))).toBe(60_000);
    expect(nextRefetch(false, false, now, thrown(new ApiError(404, 'gone', {})))).toBe(false);
    expect(nextRefetch(false, false, now, inBand({}))).toBe(false); // a good result: as before
    expect(nextRefetch(false, false, now)).toBe(false); // nothing fetched yet
    expect(nextRefetch(30_000, false, now, inBand({ error: 'x' }))).toBe(30_000); // a regular refresh comes back anyway
    expect(nextRefetch(false, false, now, inBand({ error: 'busy', retryAfterSec: 10 }))).toBe(10_000); // the hint first
    // Spread like the calendar retries.
    expect(
      nextRefetch(
        false,
        false,
        now,
        inBand({ error: 'x' }, () => 0.5),
      ),
    ).toBe(65_000);
    expect(
      nextRefetch(
        false,
        false,
        now,
        inBand({ error: 'gone', lasting: true }, () => 0.5),
      ),
    ).toBe(905_000);
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

  it('names the choices a request must wait for: data-driven selects it uses that hold a value', () => {
    const fromData = applyOps(filtered, [
      {
        op: 'addParameter',
        parameter: {
          id: 'kind',
          label: 'Kind',
          type: 'select',
          optionsFrom: { dataset: 'other', field: 'a' },
          all: 'All',
          default: null,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'by-kind',
          name: 'By kind',
          source: { kind: 'dataset', id: 'eu' },
          transforms: [{ type: 'filter', expr: '$param.kind == null || kind == $param.kind' }],
        },
      },
    ]).doc;
    const checks = choiceChecks(fromData, 'by-kind', { kind: 'x', region: 'eu' });
    expect(JSON.parse(checks)).toEqual([['kind', ...datasetKey('d', fromData, 'other').slice(2)]]);
    // A primitive, so a store selector returning it stays stable.
    expect(choiceChecks(fromData, 'by-kind', { kind: 'x' })).toBe(checks);
    // At All, through a fixed list only, or in a dataset that does not use it: nothing to wait for.
    expect(choiceChecks(fromData, 'by-kind', { region: 'eu' })).toBe('');
    expect(choiceChecks(fromData, 'eu', { kind: 'x', region: 'eu' })).toBe('');
  });
});

describe("the server's calendar window", () => {
  const at = (iso: string) => Date.parse(iso);
  const stated = (
    receivedAt: number,
    validForSec: number,
    extra: Record<string, unknown> = {},
    random: () => number = () => 0,
  ) =>
    lastFetch(
      {
        dataUpdatedAt: receivedAt,
        status: 'success',
        data: { calendar: { window: 'w', validForSec }, ...extra },
      },
      random,
    );

  it('refetches at the server midnight whatever the client clock says', () => {
    // Client 90 s ahead: received at client 23:59:00 = server 23:57:30, 150 s before the server's midnight.
    const ahead = stated(at('2026-11-10T23:59:00Z'), 150);
    expect(ahead.validUntil).toBe(at('2026-11-11T00:01:30Z'));
    expect(nextRefetch(false, true, at('2026-11-10T23:59:00Z'), ahead)).toBe(151_000); // client 00:01:31 = server 00:00:01
    expect(nextRefetch(false, true, at('2026-11-10T23:59:30Z'), ahead)).toBe(121_000); // re-asked later: same instant
    // Client 5 min behind: received at client 23:52:30 = server 23:57:30.
    const behind = stated(at('2026-11-10T23:52:30Z'), 150);
    expect(nextRefetch(false, true, at('2026-11-10T23:52:30Z'), behind)).toBe(151_000); // client 23:55:01 = server 00:00:01
    // The client's own 00:01 plays no part: 2 min after its midnight it still waits for the server's.
    expect(
      nextRefetch(false, true, at('2026-11-11T00:02:00Z'), stated(at('2026-11-11T00:01:00Z'), 600)),
    ).toBe(541_000);
  });

  it('asks again within 5 s for a result that expired before it arrived or while the tab slept', () => {
    // Resolved at server 23:59:59 (validForSec 1), received 3 s later: already spent on arrival.
    const late = stated(at('2026-11-11T00:00:04Z'), 1);
    expect(nextRefetch(false, true, at('2026-11-11T00:00:04Z'), late)).toBe(5_000); // floor, never 0 or negative
    expect(nextRefetch(false, true, at('2026-11-11T06:00:00Z'), late)).toBe(5_000); // a tab that slept
    expect(nextRefetch(false, true, at('2026-11-11T00:00:04Z'), stated(at('2026-11-11T00:00:04Z'), 10))).toBe(
      11_000,
    );
  });

  it('keeps a regular interval, and never waits longer than the window', () => {
    const s = stated(at('2026-11-10T23:59:00Z'), 60);
    expect(nextRefetch(30_000, true, at('2026-11-10T23:59:00Z'), s)).toBe(30_000);
    expect(nextRefetch(300_000, true, at('2026-11-10T23:59:00Z'), s)).toBe(61_000);
  });

  it('retries a transient error every minute, and a lasting one every quarter of an hour', () => {
    const now = at('2026-11-11T09:00:00Z');
    const transient = stated(now, 54_000, { error: 'Upstream responded 503' });
    expect(transient.failed).toBe(true);
    expect(nextRefetch(false, true, now, transient)).toBe(60_000);
    const lasting = stated(now, 54_000, {
      error: 'Credentials for this source are not available.',
      lasting: true,
    });
    expect(lasting).toMatchObject({ failed: false, lasting: true });
    expect(nextRefetch(false, true, now, lasting)).toBe(900_000);
    // Never later than the window: right before midnight the new window comes first.
    expect(nextRefetch(false, true, now, stated(now, 120, { error: 'x', lasting: true }))).toBe(121_000);
    // A regular refresh keeps its own pace, as before.
    expect(nextRefetch(30_000, true, now, lasting)).toBe(30_000);
  });

  it('ignores the window of the last good result after a thrown failure', () => {
    // After a thrown failure query-core keeps the last good data and its dataUpdatedAt; their window is long spent.
    const old = { calendar: { window: 'w', validForSec: 60 } };
    const now = at('2026-11-11T09:00:00Z');
    const thrown = (error: unknown) =>
      lastFetch({ dataUpdatedAt: at('2026-11-11T08:00:00Z'), status: 'error', error, data: old }, () => 0);
    expect(thrown(new ApiError(503, 'busy', {})).validUntil).toBeUndefined();
    expect(nextRefetch(false, true, now, thrown(new ApiError(503, 'busy', {})))).toBe(60_000); // as in 0.3.2
    expect(nextRefetch(false, true, now, thrown(new ApiError(404, 'gone', {})))).toBe(54_060_000); // next 00:01, as in 0.3.2
    expect(nextRefetch(30_000, true, now, thrown(new ApiError(503, 'busy', {})))).toBe(30_000);
    // Not the 5 s floor of an expired window, which would poll a down server three requests every 5 s.
    const lastingThenThrown = lastFetch(
      {
        dataUpdatedAt: at('2026-11-11T08:00:00Z'),
        status: 'error',
        error: new ApiError(404, 'gone', {}),
        data: { ...old, error: 'x', lasting: true },
      },
      () => 0,
    );
    expect(lastingThenThrown.lasting).toBeUndefined(); // read only from a delivered result, like the window
  });

  it('spreads the minute and quarter-hour retries over ten seconds, drawn once per result', () => {
    const now = at('2026-11-11T09:00:00Z');
    const half = () => 0.5;
    expect(nextRefetch(false, true, now, stated(now, 54_000, { error: 'x' }, half))).toBe(65_000);
    expect(nextRefetch(false, true, now, stated(now, 54_000, { error: 'x', lasting: true }, half))).toBe(
      905_000,
    );
    // The server's own retry hint is not spread.
    expect(
      nextRefetch(false, true, now, stated(now, 54_000, { error: 'busy', retryAfterSec: 10 }, half)),
    ).toBe(10_000);
    // One draw per query state: query-core asks again on every update, and the spread must not change each time.
    const state = { dataUpdatedAt: now, status: 'success', data: { error: 'x' } };
    const random = vi.fn(() => 0.3);
    expect(lastFetch(state, random).spreadMs).toBe(3_000);
    expect(lastFetch(state, () => 0.9).spreadMs).toBe(3_000);
    expect(random).toHaveBeenCalledTimes(1);
    // A good result draws nothing and has no spread.
    expect(lastFetch({ dataUpdatedAt: now, status: 'success', data: {} }, random).spreadMs).toBeUndefined();
  });

  it('keeps the refusal hint and the request-level rules', () => {
    const now = at('2026-11-11T09:00:00Z');
    const refused = stated(now, 54_000, { error: 'busy', retryAfterSec: 10 });
    expect(nextRefetch(false, true, now, refused)).toBe(10_000);
    expect(
      lastFetch({ dataUpdatedAt: now, status: 'error', error: new ApiError(403, 'gone', {}) }).failed,
    ).toBe(false);
    expect(
      lastFetch({ dataUpdatedAt: now, status: 'error', error: new ApiError(503, 'busy', {}) }).failed,
    ).toBe(true);
  });

  it('falls back to the client clock when the answer states no window (an older server)', () => {
    const plain = lastFetch({ dataUpdatedAt: at('2026-11-11T00:01:00Z'), status: 'success', data: {} });
    expect(plain.validUntil).toBeUndefined();
    expect(nextRefetch(false, true, at('2026-11-11T00:01:30Z'), plain)).toBe(86_370_000); // as before
  });
});
