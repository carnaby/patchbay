/**
 * What a click on a chart, table or map item does (proposal 0010, phase 2). Pure, so the rules are tested without a
 * browser: nothing while presenting (an accidental tap on an unattended screen would change the view and nobody would
 * change it back), the clicked value sets the filter, and the selected item clicked again resets it.
 */
import {
  type ChartConfig,
  CROSS_FILTER_KINDS,
  crossFilterOf,
  crossFilterPick,
  defaultText,
  type Parameter,
  PROPORTION_KINDS,
  type Scalar,
  type Widget,
} from '@patchbay/core';
import type { RawValues } from './parameters.ts';

export type ClickResult = { id: string; text: string | null } | { problem: string } | null;

export function crossFilterClick(
  widget: Widget,
  parameters: readonly Parameter[] | undefined,
  raw: RawValues,
  clicked: Scalar | undefined,
  presenting: boolean,
): ClickResult {
  if (presenting) return null;
  const cross = crossFilterOf(widget);
  const param = cross ? parameters?.find((p) => p.id === cross.parameter) : undefined;
  if (!cross || !param) return null;
  const pick = crossFilterPick(param, clicked);
  if ('problem' in pick) return pick;
  const current = Object.hasOwn(raw, param.id) ? raw[param.id] : defaultText(param);
  return { id: param.id, text: current === pick.text ? null : pick.text };
}

/**
 * A change of a chart's kind, x or series that keeps its cross-filter valid: it follows a renamed column and is
 * dropped where clicks cannot go, the way reference lines are dropped for kinds without a value axis.
 */
export function chartPatch(
  config: ChartConfig,
  patch: Partial<Pick<ChartConfig, 'kind' | 'x' | 'series'>>,
): Record<string, unknown> {
  const cross = config.crossFilter;
  if (!cross) return patch;
  const next = { ...config, ...patch };
  if (!(CROSS_FILTER_KINDS as readonly string[]).includes(next.kind))
    return { ...patch, crossFilter: undefined };
  const proportion = (PROPORTION_KINDS as readonly string[]).includes(next.kind);
  const field =
    cross.field === config.x
      ? next.x
      : cross.field === config.series && !proportion
        ? next.series
        : undefined;
  if (!field) return { ...patch, crossFilter: undefined };
  return field === cross.field ? patch : { ...patch, crossFilter: { ...cross, field } };
}
