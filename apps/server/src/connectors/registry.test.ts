import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundLimiter } from '../util/outbound.ts';

const fetchMock = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock('../util/safe-fetch.ts', async (original) => ({
  ...(await original<typeof import('../util/safe-fetch.ts')>()),
  fetchJson: (url: string) => fetchMock(url),
}));

const { ConnectorService } = await import('./registry.ts');

describe('upstream limits', () => {
  afterEach(() => fetchMock.mockReset());

  it('limits connector loads for distinct params like http loads, per connector', async () => {
    const pending: ((v: unknown) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((r) => pending.push(r)));
    const service = new ConnectorService({
      offline: false,
      outbound: new OutboundLimiter({ perHostConcurrency: 2, perHostPerMinute: 60 }),
    });
    const quakes = (minMagnitude: string) =>
      service.load('earthquakes', { period: 'day', minMagnitude }).then(
        (r) => r.table.rows.length,
        (e: Error) => e.message,
      );
    // Every filter value is a new set of params: only two loads at a time reach the upstream.
    const loads = ['all', '1.0', '2.5', '4.5'].map(quakes);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await loads[2]).toBe(
      'This server is already loading a lot from the Earthquakes connector; it will try again on the next refresh',
    );
    expect(await loads[3]).toMatch(/already loading a lot/);
    for (const finish of pending) finish({ features: [] });
    expect(await Promise.all(loads.slice(0, 2))).toEqual([0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A refusal is not remembered: the next load goes out.
    fetchMock.mockResolvedValue({ features: [] });
    expect(await quakes('4.5')).toBe(0);
  });

  it('spends its budget per load, so a connector that fans out still loads', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('topstories.json') ? [1, 2, 3, 4, 5, 6] : { id: 1, title: 'Story', time: 0 },
    );
    const service = new ConnectorService({
      offline: false,
      outbound: new OutboundLimiter({ perHostConcurrency: 1, perHostPerMinute: 2 }),
    });
    const stories = await service.load('hackernews.stories', { list: 'top', limit: 6 });
    expect(stories.table.rows).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('never limits offline samples', async () => {
    const service = new ConnectorService({
      offline: true,
      outbound: new OutboundLimiter({ perHostConcurrency: 1, perHostPerMinute: 1 }),
    });
    const loads = await Promise.all(
      ['all', '1.0', '2.5', '4.5'].map((m) =>
        service.load('earthquakes', { period: 'day', minMagnitude: m }),
      ),
    );
    expect(loads.every((r) => r.table.rows.length > 0)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
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
