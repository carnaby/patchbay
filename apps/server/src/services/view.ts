/**
 * The filter values of one request (proposal 0010): `p.<id>` query parameters, an MCP tool's `parameters` or a preview
 * body, always read against the saved declarations. Values are never stored; they only decide what a scope binds, and
 * binding gives every view its own cache entries (core bind.ts).
 */
import { type DashboardDoc, type ParameterValues, readParameterValues } from '@patchbay/core';
import { badRequest } from '../util/errors.ts';

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
): ParameterValues {
  const { values, problems } = readParameterValues(
    doc.parameters,
    (id) => (raw && Object.hasOwn(raw, id) ? raw[id] : undefined),
    now,
  );
  if (problems.length) throw badRequest(problems.map((p) => p.message).join('; '));
  return values;
}
