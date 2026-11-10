/**
 * The filter values of one request (proposal 0010): `p.<id>` query parameters, an MCP tool's `parameters` or a preview
 * body, always read against the saved declarations. Values are never stored; they only decide what a scope binds, and
 * binding gives every view its own cache entries (core bind.ts).
 */
import {
  ALL_TEXT,
  type DashboardDoc,
  type DataTable,
  distinctOptions,
  type OptionValue,
  type ParameterValues,
  readParameterValues,
} from '@patchbay/core';
import { badRequest } from '../util/errors.ts';
import type { DashboardTarget, DataService } from './data.ts';

export type RawParameters = Readonly<Record<string, string>>;

/** `?p.region=eu&p.period=last7d` as { region: "eu", period: "last7d" }; the first of a repeated one counts. */
export function rawFromQuery(url: string): RawParameters {
  const found = new Map<string, string>();
  for (const [key, value] of new URL(url).searchParams)
    if (key.startsWith('p.') && !found.has(key.slice(2))) found.set(key.slice(2), value);
  // fromEntries, not assignment: "p.__proto__" must stay an ordinary key, which no declaration ever reads.
  return Object.fromEntries(found);
}

/** The view's values, the defaults for whatever is not given; a value the declaration does not offer is a 400. */
export function viewValues(
  doc: Pick<DashboardDoc, 'parameters'>,
  raw: RawParameters | undefined,
  now = Date.now(),
  dataOptions?: ReadonlyMap<string, readonly OptionValue[]>,
): ParameterValues {
  const { values, problems } = readParameterValues(
    doc.parameters,
    (id) => (raw && Object.hasOwn(raw, id) ? raw[id] : undefined),
    now,
    { ...(dataOptions ? { dataOptions } : {}) },
  );
  if (problems.length) throw badRequest(problems.map((p) => p.message).join('; '));
  return values;
}

/**
 * Choices per result table and column. A cached result keeps its table object until a new reading replaces it, so
 * every request on the same result shares one computation instead of repeating it on the main thread; a new reading
 * is a new table, and a dropped table takes its entry with it.
 */
const choicesByTable = new WeakMap<DataTable, Map<string, readonly OptionValue[]>>();

function choicesOf(table: DataTable, field: string): readonly OptionValue[] {
  let byField = choicesByTable.get(table);
  if (!byField) {
    byField = new Map();
    choicesByTable.set(table, byField);
  }
  let choices = byField.get(field);
  if (!choices) {
    choices = distinctOptions(table, field);
    byField.set(field, choices);
  }
  return choices;
}

/**
 * The choices of selects that take them from a dataset column, for the values a request gives (none when it gives
 * none, or "All"). Read through a scope, so it is usually a cached lookup; a dataset that fails gives no choices, and
 * `viewValues` then refuses its values instead of accepting them unchecked.
 */
export async function loadDataOptions(
  data: DataService,
  target: DashboardTarget,
  doc: DashboardDoc,
  raw: RawParameters | undefined,
): Promise<ReadonlyMap<string, readonly OptionValue[]>> {
  const out = new Map<string, readonly OptionValue[]>();
  const wanted = (doc.parameters ?? []).flatMap((p) =>
    p.type === 'select' && p.optionsFrom && raw && Object.hasOwn(raw, p.id) && raw[p.id] !== ALL_TEXT
      ? [{ id: p.id, ...p.optionsFrom }]
      : [],
  );
  if (wanted.length === 0) return out;
  // The options datasets use no filter (validation), so the defaults the scope binds change nothing in them.
  const scope = data.scope(target, doc);
  for (const w of wanted) {
    const dataset = doc.datasets.find((d) => d.id === w.dataset);
    if (!dataset) continue;
    const result = await scope.resolve(dataset);
    if (!result.error) out.set(w.id, choicesOf(result.table, w.field));
  }
  return out;
}
