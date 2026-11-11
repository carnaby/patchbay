import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryLaterError } from '../util/errors.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import type { Connector } from './types.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  fetchJson: (url: string) => fetchMock(url),
}));

const { ConnectorService } = await import('./registry.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url: string) => new URL(url).hostname;

describe('upstream limits', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
  });
  const tight = () =>
    new OutboundLimiter({ connector: { perHostConcurrency: 2, perHostPerMinute: 60, maxWaitMs: 8000 } });

  it('queues distinct-param loads above the host limit and loads them all', async () => {
    const pending: ((v: unknown) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((r) => pending.push(r)));
    const service = new ConnectorService({ offline: false, outbound: tight() });
    const loads = ['all', '1.0', '2.5', '4.5'].map((m) =>
      service.load('earthquakes', { period: 'day', minMagnitude: m }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const finish of pending.splice(0)) finish({ features: [] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    for (const finish of pending.splice(0)) finish({ features: [] });
    expect((await Promise.all(loads)).map((r) => r.table.rows.length)).toEqual([0, 0, 0, 0]);
  });

  it('spends one place per load and host, so a fan-out load succeeds under a 1-at-a-time limit', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('topstories.json') ? [1, 2, 3, 4, 5, 6] : { id: 1, title: 'Story', time: 0 },
    );
    const service = new ConnectorService({
      offline: false,
      outbound: new OutboundLimiter({ connector: { perHostConcurrency: 1, perHostPerMinute: 1 } }),
    });
    expect((await service.load('hackernews.stories', { list: 'top', limit: 6 })).table.rows).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('shares the budget of the real host between connectors on it, and not with other hosts', async () => {
    // weather.forecast and weather.current both call api.open-meteo.com; earthquakes calls earthquake.usgs.gov.
    // Coordinates, not a city, so no geocoding request is involved.
    let finishForecast: ((v: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('hourly=')) return new Promise((r) => (finishForecast = r));
      if (url.includes('current=')) return { current: { time: 0, temperature_2m: 1 } };
      return { features: [] };
    });
    const service = new ConnectorService({
      offline: false,
      outbound: new OutboundLimiter({ connector: { perHostConcurrency: 1, perHostPerMinute: 60 } }),
    });
    const at = { latitude: 48.1, longitude: 17.1 };
    const forecast = service.load('weather.forecast', at);
    await vi.waitFor(() => expect(finishForecast).toBeTypeOf('function'));
    const current = service.load('weather.current', at);
    // Another host is not held up by the forecast's place...
    expect((await service.load('earthquakes', { period: 'day', minMagnitude: '4.5' })).table.rows).toEqual(
      [],
    );
    await sleep(20);
    // ...while the same host is: current waits for the forecast load to end.
    const asked = () => fetchMock.mock.calls.map(([url]) => url);
    expect(asked().filter((url) => url.includes('current='))).toEqual([]);
    finishForecast!({ hourly: { time: [] } });
    await forecast;
    expect((await current).table.rows).toHaveLength(1);
    expect(asked().filter((url) => hostOf(url) === 'api.open-meteo.com')).toHaveLength(2);
  });

  it('never delays demo connectors or offline samples, even with every bucket full', async () => {
    const outbound = new OutboundLimiter({
      connector: { perHostConcurrency: 0, perHostPerMinute: 0, maxWaitMs: 50 },
    });
    const acquire = vi.spyOn(outbound, 'acquireConnectorSlot');
    const online = new ConnectorService({ offline: false, outbound });
    const offline = new ConnectorService({ offline: true, outbound });
    for (const points of [10, 20, 30, 40, 50]) await online.load('demo.signal', { points });
    await offline.load('earthquakes', { period: 'day', minMagnitude: '4.5' });
    // The property under test: they never ask for a place (a limited load would merely fail after 50 ms).
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases a place granted after the load already failed, and sends no request with it', async () => {
    // No built-in connector asks two hosts in parallel (weather asks the geocoder before it can build the forecast
    // URL), so the race needs a fake connector through the test-only `connectors` seam.
    const twoHosts: Connector = {
      info: {
        id: 'test.two',
        name: 'Two hosts',
        category: 'Test',
        description: '',
        params: [],
        minRefreshSec: 60,
        docsUrl: 'https://example.com',
        attribution: '',
      },
      async fetch(_params, ctx) {
        await Promise.all([ctx.fetchJson('https://a.example/x'), ctx.fetchJson('https://b.example/y')]);
        return { columns: [], rows: [] };
      },
      sample: () => ({ columns: [], rows: [] }),
    };
    fetchMock.mockImplementation(async (url: string) => {
      throw new Error(`down: ${url}`);
    });
    const outbound = new OutboundLimiter({
      connector: { perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 8000 },
    });
    const holder = await outbound.acquireConnectorSlot('x', 'b.example'); // b.example's only place is taken
    const service = new ConnectorService({ offline: false, outbound, connectors: [twoHosts] });
    await expect(service.load('test.two', {})).rejects.toThrow(/down: https:\/\/a\.example/);
    holder(); // now the queued b.example place is granted, after the load ended
    const fresh = outbound.acquireConnectorSlot('y', 'b.example');
    await expect(
      Promise.race([fresh, new Promise((r) => setTimeout(() => r('blocked'), 50))]),
    ).resolves.toBeTypeOf('function');
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContainEqual(expect.stringContaining('b.example'));
    // a.example's place went back when the load ended.
    await expect(
      Promise.race([
        outbound.acquireConnectorSlot('y', 'a.example'),
        new Promise((r) => setTimeout(() => r('blocked'), 50)),
      ]),
    ).resolves.toBeTypeOf('function');
  });

  it('turns a wait timeout into a RetryLaterError, serves a recent copy if there is one, and does not cache it', async () => {
    const outbound = new OutboundLimiter({
      connector: { perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 30 },
    });
    const service = new ConnectorService({ offline: false, outbound });
    const params = { period: 'day', minMagnitude: '4.5' };
    const host = 'earthquake.usgs.gov';

    // 1) A cold key whose turn does not come is refused, with the hint the page retries after.
    const hold = await outbound.acquireConnectorSlot('x', host);
    const refused = service.load('earthquakes', params);
    await expect(refused).rejects.toBeInstanceOf(RetryLaterError);
    await expect(refused).rejects.toMatchObject({ status: 429, retryAfterSec: 10 });
    expect(fetchMock).not.toHaveBeenCalled();
    hold();

    // 2) The refusal is not remembered: the next load of the same key goes out.
    fetchMock.mockResolvedValue({ features: [] });
    const fresh = await service.load('earthquakes', params);
    expect(fresh.stale).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 3) A warm key past its TTL (60 s) whose refresh is refused serves the recent copy.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const hold2 = await outbound.acquireConnectorSlot('x', host);
    const stale = await service.load('earthquakes', params);
    expect(stale.fetchedAt).toBe(fresh.fetchedAt);
    expect(stale.stale).toMatch(/already loading a lot from earthquake\.usgs\.gov/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hold2();
  });

  it('cold-loads the compare-cities param sets without any error, also at the limit that failed in 0.3.1', async () => {
    const doc = JSON.parse(
      readFileSync(new URL('../../../../showcase/compare-cities/dashboard.json', import.meta.url), 'utf8'),
    ) as { datasets: { source: { kind: string; connector?: string; params?: Record<string, unknown> } }[] };
    const sources = doc.datasets
      .map((d) => d.source)
      .filter((s) => s.kind === 'connector')
      .map((s) => ({ connector: s.connector!, params: s.params ?? {} }));
    expect(sources.length).toBeGreaterThanOrEqual(4);

    const coldLoad = async (outbound: OutboundLimiter, suffix: string) => {
      fetchMock.mockReset();
      const open = new Map<string, number>();
      const peak = new Map<string, number>();
      let n = 0;
      fetchMock.mockImplementation(async (url: string) => {
        const host = hostOf(url);
        open.set(host, (open.get(host) ?? 0) + 1);
        peak.set(host, Math.max(peak.get(host) ?? 0, open.get(host)!));
        await sleep(50 + ((n++ * 37) % 100));
        open.set(host, open.get(host)! - 1);
        if (host === 'geocoding-api.open-meteo.com') {
          const name = new URL(url).searchParams.get('name');
          return { results: [{ latitude: 48.1, longitude: 17.1, name }] };
        }
        return {
          hourly: {
            time: [0, 3600],
            temperature_2m: [1, 2],
            precipitation: [0, 0.2],
            european_aqi: [20, 21],
          },
        };
      });
      const service = new ConnectorService({ offline: false, outbound });
      // geocodeCache (weather.ts) is module-level: other city names per run, so each run really geocodes.
      const results = await Promise.allSettled(
        sources.map((s) =>
          service.load(s.connector, {
            ...s.params,
            ...(s.params.city ? { city: `${s.params.city}${suffix}` } : {}),
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      for (const r of results) if (r.status === 'fulfilled') expect(r.value.table.rows).toHaveLength(2);
      const geocoded = fetchMock.mock.calls.filter(([url]) => hostOf(url) === 'geocoding-api.open-meteo.com');
      return { peak, geocoded: geocoded.length };
    };

    await coldLoad(new OutboundLimiter(), '');
    // The limit of 66da12c: four distinct loads geocode at once, so two of them have to wait their turn.
    const tightRun = await coldLoad(new OutboundLimiter({ connector: { perHostConcurrency: 2 } }), ' 2');
    expect(tightRun.geocoded).toBe(4);
    expect(Math.max(...tightRun.peak.values())).toBe(2);
  });
});

describe('ConnectorService cache', () => {
  afterEach(() => vi.useRealTimers());

  it('refreshes offline samples once the TTL has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const service = new ConnectorService({ offline: true });
    const first = await service.load('demo.signal', { points: 10 });
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    const second = await service.load('demo.signal', { points: 10 });
    expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt);
    expect(second.table.rows.at(-1)?.time).not.toBe(first.table.rows.at(-1)?.time);
  });

  it('serves the cached copy within the TTL', async () => {
    const service = new ConnectorService({ offline: true });
    const first = await service.load('demo.signal', { points: 10 });
    const second = await service.load('demo.signal', { points: 10 });
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });
});

describe('offline samples', () => {
  it('clamp their params exactly like the real fetch, so OFFLINE=1 cannot be asked for a billion rows', async () => {
    const service = new ConnectorService({ offline: true });
    const rows = async (id: string, params: Record<string, unknown>) =>
      (await service.load(id, params)).table.rows.length;
    const startedAt = Date.now();
    // 16 forecast days and 7 past days at most, hourly.
    expect(await rows('weather.forecast', { days: 1e9, pastDays: 1e9 })).toBe((16 + 7) * 24);
    expect(await rows('weather.forecast', { days: -5, pastDays: -5 })).toBe(24);
    // Years from 1960 to a few years ahead, per country.
    const years = new Date().getUTCFullYear() + 5 - 1960;
    expect(await rows('worldbank.indicator', { countries: 'SK', from: -1e9, to: 1e9 })).toBe(years);
    expect(await rows('worldbank.indicator', { countries: 'SK', from: 2020, to: 2000 })).toBe(0);
    expect(await rows('wikipedia.pageviews', { articles: 'A', days: 1e9 })).toBe(365);
    expect(await rows('wikipedia.pageviews', { articles: 'A', days: 0 })).toBe(1);
    expect(await rows('hackernews.stories', { limit: 1e9 })).toBeLessThanOrEqual(50);
    expect(await rows('crypto.history', { coin: 'bitcoin', days: 1e9 })).toBeLessThanOrEqual(366);
    expect(await rows('fx.rates', { symbols: 'USD', days: 1e9 })).toBeLessThanOrEqual(3651);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
