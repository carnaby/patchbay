import { applyOps, emptyDashboard, inferTable, SoundRuleSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { soundIdentity } from './dataset-keys.ts';
import { considerResult, type Tracked } from './sound-tracker.ts';

const doc = applyOps(emptyDashboard('t'), [
  {
    op: 'addParameter',
    parameter: {
      id: 'period',
      label: 'Period',
      type: 'dateRange',
      presets: ['yesterday', 'last7d'],
      custom: true,
      default: 'yesterday',
    },
  },
  {
    op: 'addDataset',
    dataset: {
      id: 'orders',
      name: 'Orders',
      source: { kind: 'inline', rows: [{ id: 'a', at: '2026-01-01' }] },
      transforms: [{ type: 'filter', expr: 'at >= $param.period.start' }],
    },
  },
]).doc;

describe('considerResult', () => {
  it('stays silent for the first result of a new day and rings for a new row later that day', () => {
    const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows', key: 'id' } });
    const tracked = new Map<string, Tracked>();
    const result = (ids: string[], hash: string) => ({
      datasetId: 'orders',
      table: inferTable(ids.map((id) => ({ id }))),
      fetchedAt: '',
      hash,
      truncated: false,
    });
    const step = (iso: string, ids: string[], hash: string) => {
      const now = Date.parse(iso);
      return considerResult(
        tracked,
        'w',
        rule,
        soundIdentity(doc, rule, 'orders', {}, now),
        0,
        result(ids, hash),
        now,
      );
    };
    expect(step('2026-11-10T10:00:00Z', ['a'], 'h1')).toBe(false); // page load: baseline
    expect(step('2026-11-10T12:00:00Z', ['a', 'b'], 'h2')).toBe(true); // ordinary refresh, new row: rings
    expect(step('2026-11-11T00:01:00Z', ['x', 'y'], 'h3')).toBe(false); // new window replaced every row: baseline
    expect(step('2026-11-11T00:20:00Z', ['x', 'y', 'z'], 'h4')).toBe(true); // same window, new row: rings
  });
});
