import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from './registry.ts';

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
