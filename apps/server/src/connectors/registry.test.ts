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
