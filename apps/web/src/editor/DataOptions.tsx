/**
 * Choices of select filters that take them from a dataset column (proposal 0010, phase 2): loaded with the dataset's
 * own query, so they share its cache and refresh, and checked against the page's value once they arrive.
 */
import type { OptionValue, Parameter } from '@patchbay/core';
import { useEffect, useMemo } from 'react';
import { toast } from '../components/ui.tsx';
import { useEditor } from '../state/editor.ts';
import { choicesOfResult, type DataChoices, staleDataValue, useParameters } from '../state/parameters.ts';
import { useDatasetResult } from '../state/sync.ts';

/**
 * The choices of a data-driven select and whether they can never arrive: the dataset failed or is gone. Loading and
 * failed both have no options, but a bar must keep a link's value visible while loading and offer only All after a
 * failure.
 */
export function useDataChoices(
  dashboardId: string,
  param: Parameter | undefined,
  live: boolean,
): DataChoices {
  const from = param?.type === 'select' ? param.optionsFrom : undefined;
  const dataset = useEditor((s) => (from ? s.doc?.datasets.find((d) => d.id === from.dataset) : undefined));
  const query = useDatasetResult(dashboardId, dataset, live);
  const { options, failed } = !from
    ? FIXED
    : !dataset
      ? GONE
      : choicesOfResult(from.field, query.data, query.isError);
  return useMemo(() => ({ options, failed }), [options, failed]);
}

const FIXED: DataChoices = { options: null, failed: false };
const GONE: DataChoices = { options: null, failed: true };

/** The loaded choices of a data-driven select; null while loading, for a failed dataset and for a fixed list. */
export function useDataOptions(
  dashboardId: string,
  param: Parameter | undefined,
  live: boolean,
): readonly OptionValue[] | null {
  return useDataChoices(dashboardId, param, live).options;
}

/**
 * Renders nothing. Resets a data-driven value the loaded choices do not hold, also while presenting: a wall screen
 * must not keep showing an error for a value the data dropped. The toast only outside presentation mode.
 */
export function DataOptionsGuard({
  dashboardId,
  live,
  presenting,
}: {
  dashboardId: string;
  live: boolean;
  presenting: boolean;
}) {
  const parameters = useEditor((s) => s.doc?.parameters);
  const fromData = (parameters ?? []).filter((p) => p.type === 'select' && p.optionsFrom);
  return (
    <>
      {fromData.map((p) => (
        <GuardOne
          key={p.id}
          dashboardId={dashboardId}
          live={live}
          presenting={presenting}
          param={p}
          parameters={parameters!}
        />
      ))}
    </>
  );
}

function GuardOne({
  dashboardId,
  live,
  presenting,
  param,
  parameters,
}: {
  dashboardId: string;
  live: boolean;
  presenting: boolean;
  param: Parameter;
  parameters: readonly Parameter[];
}) {
  const options = useDataOptions(dashboardId, param, live);
  const raw = useParameters((s) => s.raw);
  const stale = staleDataValue(param, raw, options);
  useEffect(() => {
    if (!stale) return;
    if (!presenting)
      toast(`${param.label}: ${raw[param.id]} is no longer one of the choices. Showing all instead.`, 'bad');
    useParameters.getState().set(param.id, null, parameters);
  }, [stale, presenting, param, parameters, raw]);
  return null;
}
