import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyDashboard,
  inferTable,
  OpError,
  type SoundRuleInput,
  SoundRuleSchema,
  type SoundState,
  soundDecision,
  soundRuleMissingColumns,
  WidgetSchema,
} from './index.ts';

const rule = (input: SoundRuleInput) => SoundRuleSchema.parse(input);
const orders = (...ids: number[]) => inferTable(ids.map((id) => ({ order_id: id, total: id * 10 })));
const prices = (...values: number[]) => inferTable(values.map((price, i) => ({ t: i, price })));

/** Feeds results one by one, `stepMs` apart, and returns which ones played. */
function run(r: SoundRuleInput, tables: ReturnType<typeof inferTable>[], stepMs = 60_000) {
  const parsed = rule(r);
  let state: SoundState | null = null;
  return tables.map((t, i) => {
    const d = soundDecision(parsed, t, state, i * stepMs);
    state = d.state;
    return d.play;
  });
}

describe('sound rule schema', () => {
  it('fills defaults and stays strict', () => {
    expect(rule({ trigger: { kind: 'newRows' } })).toEqual({
      trigger: { kind: 'newRows' },
      sound: 'bell',
      volume: 0.7,
      cooldownSec: 10,
    });
    expect(SoundRuleSchema.safeParse({ trigger: { kind: 'newRows' }, colour: 'red' }).success).toBe(false);
    expect(SoundRuleSchema.safeParse({ trigger: { kind: 'newRows' }, sound: 'airhorn' }).success).toBe(false);
    expect(SoundRuleSchema.safeParse({ trigger: { kind: 'newRows' }, volume: 1.5 }).success).toBe(false);
    expect(SoundRuleSchema.safeParse({ trigger: { kind: 'newRows' }, cooldownSec: 4000 }).success).toBe(
      false,
    );
  });

  it('validates the condition with the expression parser', () => {
    expect(
      SoundRuleSchema.safeParse({ trigger: { kind: 'condition', expr: 'price > 100000' } }).success,
    ).toBe(true);
    const bad = SoundRuleSchema.safeParse({ trigger: { kind: 'condition', expr: 'price >' } });
    expect(bad.success).toBe(false);
    expect(SoundRuleSchema.safeParse({ trigger: { kind: 'condition', expr: 'alert(1)' } }).success).toBe(
      false,
    );
  });

  it('is only allowed on data-bound widgets', () => {
    const sound = { trigger: { kind: 'newRows' } };
    expect(
      WidgetSchema.safeParse({ id: 'k', type: 'kpi', datasetId: 'd', config: { field: 'x' }, sound }).success,
    ).toBe(true);
    expect(WidgetSchema.safeParse({ id: 't', type: 'text', config: { markdown: 'hi' }, sound }).success).toBe(
      false,
    );
  });
});

describe('updateWidget with sound', () => {
  const base = applyOps(emptyDashboard(), [
    { op: 'addDataset', dataset: { id: 'orders', name: 'Orders', source: { kind: 'inline', rows: [] } } },
    { op: 'addWidget', widget: { id: 'tbl', type: 'table', datasetId: 'orders', config: {} } },
  ]).doc;

  it('sets the sound (the example from the reference) and removes it with null', () => {
    const set = applyOps(base, [
      {
        op: 'updateWidget',
        id: 'tbl',
        set: { sound: { trigger: { kind: 'newRows', key: 'order_id' }, sound: 'bell' } },
      },
    ]).doc;
    expect(set.widgets[0]).toMatchObject({ sound: { sound: 'bell', volume: 0.7, cooldownSec: 10 } });
    const removed = applyOps(set, [{ op: 'updateWidget', id: 'tbl', set: { sound: null } }]).doc;
    expect(removed.widgets[0]).not.toHaveProperty('sound');
  });

  it('spells out sound cues in the change log', () => {
    const rule = { trigger: { kind: 'condition', expr: 'value > 5' }, sound: 'alert', cooldownSec: 30 };
    const added = applyOps(base, [
      {
        op: 'addWidget',
        widget: {
          id: 'loud',
          type: 'kpi',
          title: 'Loud',
          datasetId: 'orders',
          config: { field: 'v' },
          sound: rule,
        },
      },
    ]);
    expect(added.changes).toEqual([
      'Added kpi widget "Loud"; sound cue: "alert" when `value > 5` becomes true on the last row (volume 0.7, cooldown 30 s)',
    ]);
    const updated = applyOps(base, [
      {
        op: 'updateWidget',
        id: 'tbl',
        set: { title: 'Orders', sound: { trigger: { kind: 'newRows', key: 'id' } } },
      },
      { op: 'updateWidget', id: 'tbl', set: { sound: { trigger: { kind: 'newRows' }, sound: 'cash' } } },
    ]);
    expect(updated.changes).toEqual([
      'Updated widget "tbl" (title); sound cue set to "bell" when rows with a new "id" appear (volume 0.7, cooldown 10 s)',
      'Widget "Orders": sound cue set to "cash" when the row count grows (volume 0.7, cooldown 10 s)',
    ]);
    const removed = applyOps(updated.doc, [
      { op: 'updateWidget', id: 'tbl', set: { sound: null } },
      { op: 'updateWidget', id: 'tbl', set: { sound: null } },
    ]);
    expect(removed.changes).toEqual([
      'Widget "Orders": sound cue removed',
      'Widget "Orders": no sound cue to remove',
    ]);
    expect(
      applyOps(added.doc, [
        { op: 'replaceWidget', widget: { id: 'loud', type: 'table', datasetId: 'orders', config: {} } },
      ]).changes,
    ).toEqual(['Replaced widget "loud" with a table; its sound cue was removed']);
    expect(applyOps(added.doc, [{ op: 'removeWidget', id: 'loud' }]).changes).toEqual([
      'Removed widget "Loud" and its sound cue',
    ]);
    expect(applyOps(added.doc, [{ op: 'removeDataset', id: 'orders', cascade: true }]).changes).toEqual([
      'Removed dataset "Orders" and 2 widget(s) (1 with a sound cue)',
    ]);
  });

  it('rejects an invalid condition as a failing operation', () => {
    expect(() =>
      applyOps(base, [
        { op: 'updateWidget', id: 'tbl', set: { sound: { trigger: { kind: 'condition', expr: '1 +' } } } },
      ]),
    ).toThrow(OpError);
  });
});

describe('soundDecision', () => {
  it('never plays for the first result (load, reconnect, refetch)', () => {
    expect(run({ trigger: { kind: 'newRows', key: 'order_id' } }, [orders(1, 2, 3)])).toEqual([false]);
    expect(run({ trigger: { kind: 'newRows' } }, [orders(1, 2, 3)])).toEqual([false]);
    // A condition that is already true on load is the baseline, not an event.
    expect(run({ trigger: { kind: 'condition', expr: 'price > 100' } }, [prices(150)])).toEqual([false]);
  });

  it('plays when a new key appears', () => {
    expect(run({ trigger: { kind: 'newRows', key: 'order_id' } }, [orders(1, 2), orders(1, 2, 3)])).toEqual([
      false,
      true,
    ]);
  });

  it('stays silent for an identical result', () => {
    expect(run({ trigger: { kind: 'newRows', key: 'order_id' } }, [orders(1, 2), orders(1, 2)])).toEqual([
      false,
      false,
    ]);
  });

  it('stays silent when a rolling window drops rows without new keys', () => {
    expect(
      run({ trigger: { kind: 'newRows', key: 'order_id' } }, [orders(1, 2, 3), orders(2, 3), orders(3)]),
    ).toEqual([false, false, false]);
  });

  it('plays for a new key in a rolling window even when the count stays the same', () => {
    expect(
      run({ trigger: { kind: 'newRows', key: 'order_id' } }, [orders(1, 2, 3), orders(2, 3, 4)]),
    ).toEqual([false, true]);
  });

  it('keeps 1 and "1" apart and ignores empty keys', () => {
    const a = inferTable([{ id: 1 }, { id: null }]);
    const b = inferTable([{ id: 1 }, { id: null }, { id: '' }]);
    expect(run({ trigger: { kind: 'newRows', key: 'id' } }, [a, b])).toEqual([false, false]);
  });

  it('without a key compares row counts and plays only when the count grew', () => {
    expect(
      run({ trigger: { kind: 'newRows' } }, [orders(1, 2), orders(1, 2, 3), orders(2, 3), orders(5, 6)]),
    ).toEqual([false, true, false, false]);
  });

  it('a condition plays on the edge false -> true only', () => {
    const r = { trigger: { kind: 'condition', expr: 'price > 100' } } as const;
    expect(run(r, [prices(90), prices(150), prices(160)])).toEqual([false, true, false]);
  });

  it('a condition plays again after it went false and true again', () => {
    const r = { trigger: { kind: 'condition', expr: 'price > 100' } } as const;
    expect(run(r, [prices(90), prices(150), prices(80), prices(120)])).toEqual([false, true, false, true]);
  });

  it('a condition looks at the last row (the newest reading)', () => {
    const r = { trigger: { kind: 'condition', expr: 'price > 100' } } as const;
    // An old high reading still in the window does not keep the condition true.
    expect(run(r, [prices(150, 90), prices(150, 90, 120)])).toEqual([false, true]);
    // An empty result counts as false.
    expect(run(r, [prices(120), prices(), prices(130)])).toEqual([false, false, true]);
  });

  it('respects the cooldown and consumes triggers inside it', () => {
    const r = { trigger: { kind: 'newRows', key: 'order_id' }, cooldownSec: 10 } as const;
    // One result per second: plays at 1s, silent at 2s..10s, plays again at 11s.
    const results = [orders(0)];
    for (let i = 1; i <= 12; i++) results.push(orders(...Array.from({ length: i + 1 }, (_, k) => k)));
    const played = run(r, results, 1000);
    expect(played.map((p, i) => (p ? i : -1)).filter((i) => i >= 0)).toEqual([1, 11]);
  });

  it('a condition edge inside the cooldown does not ring later', () => {
    const r = { trigger: { kind: 'condition', expr: 'price > 100' }, cooldownSec: 10 } as const;
    // 0s low, 1s high (plays), 2s low, 3s high (cooling, consumed), 4s..20s stays high: silent.
    const seq = [90, 150, 90, 150, 150, 150, 150].map((p) => prices(p));
    expect(run(r, seq, 1000)).toEqual([false, true, false, false, false, false, false]);
  });

  it('a cooldown of 0 plays every time', () => {
    expect(
      run({ trigger: { kind: 'newRows' }, cooldownSec: 0 }, [orders(1), orders(1, 2), orders(1, 2, 3)], 1),
    ).toEqual([false, true, true]);
  });
});

describe('soundRuleMissingColumns', () => {
  it('names columns the rule needs but the data lacks', () => {
    const t = orders(1);
    expect(soundRuleMissingColumns(rule({ trigger: { kind: 'newRows', key: 'order_id' } }), t)).toEqual([]);
    expect(soundRuleMissingColumns(rule({ trigger: { kind: 'newRows', key: 'orderid' } }), t)).toEqual([
      'orderid',
    ]);
    expect(
      soundRuleMissingColumns(rule({ trigger: { kind: 'condition', expr: 'total > 5 && price > 1' } }), t),
    ).toEqual(['price']);
  });
});
