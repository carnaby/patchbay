/**
 * Sound cues on live widgets (proposal 0002).
 *
 * The rule lives on the widget; the decision is a pure function so every
 * behavioural rule (edge trigger, silent first result, new rows by key,
 * cooldown) is unit-tested here instead of in the browser.
 */
import { z } from 'zod';
import { compile, ExprError, isTruthy, parse, referencedFields } from './expr.ts';
import type { DataTable, Scalar } from './table.ts';

export const SOUND_IDS = ['bell', 'chime', 'ding', 'cash', 'pop', 'alert'] as const;
export type SoundId = (typeof SOUND_IDS)[number];

const conditionExpr = z
  .string()
  .min(1)
  .max(2000)
  .superRefine((src, ctx) => {
    try {
      parse(src);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof ExprError ? e.message : 'Invalid expression' });
    }
  });

export const SoundTriggerSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('newRows'),
      key: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Column that identifies a row (e.g. "order_id"); without it, row counts are compared'),
    })
    .describe('Play when rows appear that were not in the previous result'),
  z
    .strictObject({ kind: z.literal('condition'), expr: conditionExpr })
    .describe('Play when the expression, evaluated on the last row, becomes true'),
]);
export type SoundTrigger = z.infer<typeof SoundTriggerSchema>;

export const SoundRuleSchema = z.strictObject({
  trigger: SoundTriggerSchema,
  sound: z.enum(SOUND_IDS).default('bell'),
  volume: z.number().min(0).max(1).default(0.7),
  cooldownSec: z.number().int().min(0).max(3600).default(10),
});
export type SoundRule = z.infer<typeof SoundRuleSchema>;
export type SoundRuleInput = z.input<typeof SoundRuleSchema>;

/** What the decision remembers between two results of the same widget. */
export interface SoundState {
  /** Keys of the previous result (newRows with a key). */
  keys: Set<string> | null;
  /** Row count of the previous result (newRows without a key). */
  count: number;
  /** Condition value on the previous result (condition trigger). */
  condition: boolean;
  /** Epoch ms of the last decision to play, for the cooldown. */
  lastPlayedAt: number | null;
}

export interface SoundDecision {
  play: boolean;
  state: SoundState;
}

function keyOf(v: Scalar | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  // Typed so that the number 1 and the string "1" stay different keys.
  return `${typeof v}:${String(v)}`;
}

function keysOf(table: DataTable, key: string): Set<string> {
  const out = new Set<string>();
  for (const row of table.rows) {
    const k = keyOf(row[key]);
    if (k !== null) out.add(k);
  }
  return out;
}

/**
 * Conditions look at the last row: live sources append their newest reading at
 * the end (accumulate, time series), so "the current value" is the last row.
 * Looking at any row instead would stay true while an old reading is still in
 * a rolling window, and the edge would never re-arm.
 */
function conditionHolds(expr: string, table: DataTable): boolean {
  const last = table.rows[table.rows.length - 1];
  if (!last) return false;
  try {
    return isTruthy(compile(expr)(last));
  } catch {
    return false;
  }
}

/**
 * Decides whether a widget should play its sound for a new result.
 *
 * `state` is null for the first result after opening the page, reconnecting,
 * refetching or changing the rule: that result only sets the baseline.
 */
export function soundDecision(
  rule: SoundRule,
  next: DataTable,
  state: SoundState | null,
  now: number,
): SoundDecision {
  const trigger = rule.trigger;
  const fresh: SoundState = {
    keys: trigger.kind === 'newRows' && trigger.key ? keysOf(next, trigger.key) : null,
    count: next.rows.length,
    condition: trigger.kind === 'condition' ? conditionHolds(trigger.expr, next) : false,
    lastPlayedAt: state?.lastPlayedAt ?? null,
  };
  if (!state) return { play: false, state: fresh };

  let fired: boolean;
  if (trigger.kind === 'condition') {
    fired = fresh.condition && !state.condition;
  } else if (trigger.key) {
    const previous = state.keys ?? new Set<string>();
    fired = false;
    for (const k of fresh.keys!) {
      if (!previous.has(k)) {
        fired = true;
        break;
      }
    }
  } else {
    fired = fresh.count > state.count;
  }

  // A trigger inside the cooldown is consumed, not postponed: the baseline moves on,
  // so a burst of orders never turns into a late second ring.
  const cooling = state.lastPlayedAt !== null && now - state.lastPlayedAt < rule.cooldownSec * 1000;
  const play = fired && !cooling;
  return { play, state: play ? { ...fresh, lastPlayedAt: now } : fresh };
}

/** Columns a rule needs that the result does not have (a likely typo), for a hint in the UI. */
export function soundRuleMissingColumns(rule: SoundRule, table: DataTable): string[] {
  const names = new Set(table.columns.map((c) => c.name));
  if (rule.trigger.kind === 'newRows') {
    return rule.trigger.key && !names.has(rule.trigger.key) ? [rule.trigger.key] : [];
  }
  try {
    return [...referencedFields(parse(rule.trigger.expr))].filter((f) => !names.has(f));
  } catch {
    return [];
  }
}
