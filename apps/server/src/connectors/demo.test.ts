import { SoundRuleSchema, soundDecision } from '@patchbay/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoSales } from './demo.ts';
import { column } from './fake-upstream.ts';
import { ConnectorService } from './registry.ts';

describe('demo.sales live orders', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the daily default unchanged', () => {
    const table = demoSales.sample({ days: 30, live: false });
    expect(table.columns.map((c) => c.name)).toEqual([
      'date',
      'region',
      'product',
      'channel',
      'units',
      'revenue',
    ]);
  });

  it('returns single orders with an order_id and per-second times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.400Z'));
    const table = demoSales.sample({ live: true });
    expect(table.columns.map((c) => c.name)).toEqual([
      'time',
      'order_id',
      'region',
      'product',
      'channel',
      'units',
      'revenue',
    ]);
    expect(table.columns.find((c) => c.name === 'time')?.type).toBe('time');
    // About one order every eight seconds over 30 minutes.
    expect(table.rows.length).toBeGreaterThan(150);
    expect(table.rows.length).toBeLessThan(300);
    const ids = column(table, 'order_id');
    expect(new Set(ids).size).toBe(ids.length);
    const times = column(table, 'time') as number[];
    expect(times.every((t) => t % 1000 === 0)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBeLessThanOrEqual(Date.parse('2026-10-27T12:00:00Z'));
  });

  it('makes the reference sound example (newRows keyed by order_id) play on refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
    // The same path a live dataset takes: validated params and the shared connector cache.
    const service = new ConnectorService({ offline: true });
    const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows', key: 'order_id' }, sound: 'bell' });
    const first = (await service.load('demo.sales', { live: true })).table;
    const baseline = soundDecision(rule, first, null, Date.now());
    expect(baseline.play).toBe(false);

    vi.setSystemTime(new Date('2026-10-27T12:01:00Z'));
    const next = (await service.load('demo.sales', { live: true })).table;
    const firstIds = new Set(column(first, 'order_id'));
    const nextIds = column(next, 'order_id');
    // Orders that are still in the window keep their id, and new ones arrived.
    expect(nextIds.filter((id) => firstIds.has(id)).length).toBeGreaterThan(100);
    expect(nextIds.some((id) => !firstIds.has(id))).toBe(true);
    for (const id of nextIds.filter((id) => firstIds.has(id)).slice(0, 20)) {
      const a = first.rows.find((r) => r.order_id === id);
      const b = next.rows.find((r) => r.order_id === id);
      expect(b).toEqual(a);
    }
    expect(soundDecision(rule, next, baseline.state, Date.now()).play).toBe(true);
  });
});
