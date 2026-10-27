/**
 * Renaming a dashboard and editing its description from a form field. The field keeps a draft while the user
 * types; only the committed value becomes a `setMeta` op, so one rename is one undo step and one saved version.
 */
import { type DashboardDoc, LIMITS, type OpInput } from '@patchbay/core';
import { useEditor } from './editor.ts';

export type DetailsField = 'title' | 'description';

export const detailsLimits: Record<DetailsField, number> = {
  title: LIMITS.title,
  description: LIMITS.description,
};

export type DetailsChange =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'change'; ops: OpInput[]; label: string };

/** What committing `raw` into `field` would do. Surrounding whitespace is dropped, as nobody means it. */
export function detailsChange(doc: DashboardDoc, field: DetailsField, raw: string): DetailsChange {
  const value = raw.trim();
  if (field === 'title' && value === '') return { kind: 'invalid', error: 'A dashboard needs a title.' };
  if (value.length > detailsLimits[field]) {
    return { kind: 'invalid', error: `At most ${detailsLimits[field]} characters.` };
  }
  if (value === doc[field]) return { kind: 'unchanged' };
  return field === 'title'
    ? { kind: 'change', ops: [{ op: 'setMeta', title: value }], label: 'Renamed dashboard' }
    : { kind: 'change', ops: [{ op: 'setMeta', description: value }], label: 'Edited description' };
}

/** Applies a committed field value through the editor store. Returns an error to show, or null. */
export function commitDetails(field: DetailsField, raw: string): string | null {
  const { doc, apply } = useEditor.getState();
  if (!doc) return 'Dashboard not loaded';
  const change = detailsChange(doc, field, raw);
  if (change.kind === 'invalid') return change.error;
  if (change.kind === 'unchanged') return null;
  return apply(change.ops, change.label);
}
