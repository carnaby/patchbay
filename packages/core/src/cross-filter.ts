/**
 * Cross-filter (proposal 0010, phase 2): a click on a chart, table or map item sets a filter, and the selected item
 * stays at full strength while the others are dimmed. Colour still follows the entity (theme.ts): dimming lowers
 * opacity and never recolours. Shared by the browser and the snapshot renderer, so both draw the same selection.
 */
import type { ColorMap } from './colors.ts';
import type { LineageDoc } from './lineage.ts';
import {
  lineageParameters,
  MAX_TEXT_VALUE,
  type Parameter,
  type ParameterValue,
  type ParameterValues,
} from './parameters.ts';
import type { CrossFilter, Widget } from './schema.ts';
import type { Row, Scalar } from './table.ts';

export const DIMMED_OPACITY = 0.25;

/** The selected item: a column, and its value as the text charts label their items with. */
export interface Selection {
  field: string;
  value: string;
}

export function crossFilterOf(widget: Widget): CrossFilter | undefined {
  return widget.type === 'chart' || widget.type === 'table' || widget.type === 'map'
    ? widget.config.crossFilter
    : undefined;
}

/** What a widget's filter currently selects; null at "All", for an empty text and for widgets without a cross-filter. */
export function crossFilterSelection(widget: Widget, values: ParameterValues | undefined): Selection | null {
  const cross = crossFilterOf(widget);
  if (!cross || !values || !Object.hasOwn(values, cross.parameter)) return null;
  const value = values[cross.parameter] as ParameterValue;
  if (value === null || value === '' || typeof value === 'object') return null;
  return { field: cross.field, value: String(value) };
}

/**
 * The entity a data widget is narrowed to, named by a select filter in its dataset's lineage and coloured on the
 * dashboard. A KPI has no entity column (its data is often aggregated across entities), so the filter that narrowed
 * it is the only place the entity is named. Null for none, and for several: no one entity is in focus then.
 */
export function focusedEntity(
  doc: LineageDoc & { parameters?: readonly Parameter[] | undefined; colors?: ColorMap | undefined },
  widget: Widget,
  values: ParameterValues | undefined,
): string | null {
  if (!('datasetId' in widget) || !values || !doc.colors) return null;
  const named = new Set<string>();
  for (const id of lineageParameters(doc, widget.datasetId)) {
    if (doc.parameters?.find((p) => p.id === id)?.type !== 'select' || !Object.hasOwn(values, id)) continue;
    const value = values[id];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const key = String(value);
    if (key !== '' && Object.hasOwn(doc.colors, key)) named.add(key);
  }
  return named.size === 1 ? [...named][0]! : null;
}

/** Whether a row is the selected item (true), another one (false), or nothing is selected (null). As text: 2026 and "2026" are one item. */
export function rowSelected(row: Row, selection: Selection | null): boolean | null {
  if (!selection) return null;
  const v = row[selection.field];
  return v !== null && v !== undefined && String(v) === selection.value;
}

/**
 * The selection to draw: null when no row holds the value. A typed text, or a value this widget's data does not hold,
 * would otherwise dim every item. Returns the same object when it keeps it (chart options memoize on it).
 */
export function effectiveSelection(selection: Selection | null, rows: readonly Row[]): Selection | null {
  if (!selection) return null;
  return rows.some((r) => rowSelected(r, selection) === true) ? selection : null;
}

/** The filter text a click on an item with this value gives, or why it cannot set the filter. */
export function crossFilterPick(
  param: Parameter,
  value: Scalar | undefined,
): { text: string } | { problem: string } {
  if (value === null || value === undefined || value === '')
    return { problem: 'This item has no value to filter by' };
  const text = String(value);
  switch (param.type) {
    case 'select':
      // Choices from data are not at hand here: the server reads them and refuses a value they do not hold.
      if (param.optionsFrom) {
        if (text.length > MAX_TEXT_VALUE)
          return {
            problem: `This value is longer than ${MAX_TEXT_VALUE} characters, so it is not one of the ${param.label} choices`,
          };
        return { text };
      }
      return (param.options ?? []).some((o) => String(o.value) === text)
        ? { text }
        : { problem: `${text} is not one of the ${param.label} choices` };
    case 'text': {
      const trimmed = text.trim();
      return trimmed.length > MAX_TEXT_VALUE
        ? { problem: `${param.label} takes at most ${MAX_TEXT_VALUE} characters` }
        : { text: trimmed };
    }
    case 'dateRange':
      return { problem: `${param.label} is a period; a click cannot set it` };
  }
}
