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

const rule = SoundRuleSchema.parse({ trigger: { kind: 'newRows', key: 'id' } });
const result = (ids: string[], hash: string, error?: string) => ({
  datasetId: 'orders',
  table: inferTable(ids.map((id) => ({ id }))),
  fetchedAt: '',
  hash,
  truncated: false,
  ...(error ? { error } : {}),
});

/** One widget's decisions in order: `clientIso` is the arrival on the client, `window` what the server stated. */
const tracker = () => {
  const tracked = new Map<string, Tracked>();
  return (clientIso: string, ids: string[], hash: string, window?: string, epoch = 0, error?: string) => {
    const now = Date.parse(clientIso);
    const answer = window ? { calendar: { window, validForSec: 60 } } : undefined;
    return considerResult(
      tracked,
      'w',
      rule,
      soundIdentity(doc, rule, 'orders', {}, now, answer),
      epoch,
      result(ids, hash, error),
      now,
    );
  };
};

describe('considerResult', () => {
  it('stays silent for the first result of a new day and rings for a new row later that day', () => {
    // No stated window (an older server): the client clock decides the window.
    const step = tracker();
    expect(step('2026-11-10T10:00:00Z', ['a'], 'h1')).toBe(false); // page load: baseline
    expect(step('2026-11-10T12:00:00Z', ['a', 'b'], 'h2')).toBe(true); // ordinary refresh, new row: rings
    expect(step('2026-11-11T00:01:00Z', ['x', 'y'], 'h3')).toBe(false); // new window replaced every row: baseline
    expect(step('2026-11-11T00:20:00Z', ['x', 'y', 'z'], 'h4')).toBe(true); // same window, new row: rings
  });
});

describe("sound baselines at the server's window", () => {
  const nov9 = '2026-11-09..2026-11-09';
  const nov10 = '2026-11-10..2026-11-10';

  it('judges a result that arrives after midnight against the window it was computed for', () => {
    const step = tracker();
    expect(step('2026-11-10T10:00:00Z', ['a'], 'h1', nov9)).toBe(false); // baseline
    // Resolved at 23:59:59, landed at 00:00:00.4: still yesterday's rows, so a new one among them rings.
    expect(step('2026-11-11T00:00:00.400Z', ['a', 'b'], 'h2', nov9)).toBe(true);
    expect(step('2026-11-11T00:00:05Z', ['a', 'b'], 'h3', nov9)).toBe(false); // same window, no new row
  });

  it('takes the first result of a stated window as the baseline and rings for the next new row', () => {
    const step = tracker();
    expect(step('2026-11-11T08:00:00Z', ['x'], 'h1', nov10)).toBe(false);
    expect(step('2026-11-11T09:00:00Z', ['x', 'y'], 'h2', nov10)).toBe(true);
  });

  it("starts a new baseline at the server's midnight on a client whose clock is behind", () => {
    // Client 5 min behind: its 23:56 is the server's 00:01, and the result already covers the new day.
    const step = tracker();
    expect(step('2026-11-10T23:50:00Z', ['a'], 'h1', nov9)).toBe(false);
    expect(step('2026-11-10T23:56:00Z', ['x', 'y'], 'h2', nov10)).toBe(false); // new window: baseline
    expect(step('2026-11-10T23:57:00Z', ['x', 'y', 'z'], 'h3', nov10)).toBe(true);
  });

  it('takes the first result after a reconnect as the baseline within the same window', () => {
    const step = tracker();
    expect(step('2026-11-11T08:00:00Z', ['x'], 'h1', nov10, 0)).toBe(false);
    expect(step('2026-11-11T09:00:00Z', ['x', 'y'], 'h2', nov10, 1)).toBe(false); // missed while away: baseline
    expect(step('2026-11-11T09:01:00Z', ['x', 'y', 'z'], 'h3', nov10, 1)).toBe(true);
  });

  it('keeps the next good result of a new window as the baseline after an error result', () => {
    const step = tracker();
    expect(step('2026-11-10T10:00:00Z', ['a'], 'h1', nov9)).toBe(false);
    expect(step('2026-11-11T00:01:00Z', [], 'h2', nov10, 0, 'x')).toBe(false); // failed: no rows to judge
    // More rows than the old baseline, but the first rows of this window: baseline, not a ring.
    expect(step('2026-11-11T00:02:00Z', ['a', 'b', 'c'], 'h3', nov10)).toBe(false);
    expect(step('2026-11-11T00:03:00Z', ['a', 'b', 'c', 'd'], 'h4', nov10)).toBe(true);
  });
});
