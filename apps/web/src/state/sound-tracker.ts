/**
 * The per-widget decision step of the sound cues, kept free of React and the stores so it can be tested as a pure
 * function (sound-cues.ts wires it to the query cache).
 */
import { type DatasetResult, type SoundRule, type SoundState, soundDecision } from '@patchbay/core';

export interface Tracked {
  /** Rule, lineage, view and calendar window of its dataset; a change means a new baseline. */
  identity: string;
  epoch: number;
  hash: string | null;
  state: SoundState | null;
}

/** Whether this result rings for the widget. A new identity or live epoch makes it only the baseline. */
export function considerResult(
  tracked: Map<string, Tracked>,
  widgetId: string,
  rule: SoundRule,
  identity: string | null,
  epoch: number,
  result: DatasetResult,
  now: number,
): boolean {
  if (!identity) return false;
  let entry = tracked.get(widgetId);
  if (!entry || entry.identity !== identity || entry.epoch !== epoch) {
    entry = { identity, epoch, hash: null, state: null };
    tracked.set(widgetId, entry);
  }
  // A failed result has no rows to judge. A warning still carries real rows: a capped source keeps its rules
  // working, and a cached copy is the last real reading (the connector cache is shared across dashboards), so it
  // rings only for rows this viewer has not seen yet.
  if (result.error || result.hash === entry.hash) return false;
  const decision = soundDecision(rule, result.table, entry.state, now);
  entry.hash = result.hash;
  entry.state = decision.state;
  return decision.play;
}
