/** "Share of total" and "Difference from average" for the Add column step: they only write an expression. */
import { fieldRef } from '@patchbay/core';

export type PresetKind = 'share' | 'difference';

export const PRESETS: Record<PresetKind, { label: string; help: string }> = {
  share: {
    label: 'Share of total',
    help: 'Each value as a percentage of the column total (or of its group), of the rows at this point in the pipeline',
  },
  difference: {
    label: 'Difference from average',
    help: 'Each value minus the column average (or its group average), of the rows at this point in the pipeline',
  },
};

export function presetExpression(kind: PresetKind, column: string, per?: string): string {
  const x = fieldRef(column);
  const by = per ? `, ${fieldRef(per)}` : '';
  return kind === 'share' ? `round(${x} / col_sum(${x}${by}) * 100, 1)` : `${x} - col_avg(${x}${by})`;
}

export function presetColumnName(kind: PresetKind, column: string): string {
  return `${kind === 'share' ? 'share' : 'diff'}_${column}`.slice(0, 200);
}

/**
 * Columns a preset can sum or average. Types are only known for the source's own columns; a column added by an earlier
 * step has none, so it stays offered rather than hidden. Without any type information every column stays.
 */
export function presetColumns(columns: string[], types: Record<string, string>): string[] {
  const usable = columns.filter((c) => types[c] === undefined || types[c] === 'number');
  return usable.length > 0 ? usable : columns;
}

/** A string column would only produce an error, so the first column known to be numeric comes first. */
export function defaultPresetColumn(columns: string[], types: Record<string, string>): string {
  return columns.find((c) => types[c] === 'number') ?? presetColumns(columns, types)[0] ?? '';
}
