/**
 * Inserting filter references in the dataset editor (proposal 0010). The editor offers only what validation accepts at
 * the place (core `refProblem`), so an editor rarely meets a validation error after the fact.
 */
import {
  type DashboardDoc,
  fieldRef,
  lineageParameters,
  PARAM_PARTS,
  type Parameter,
  type ParamPart,
  type ParamSpec,
  type RefPlace,
  readRef,
  refProblem,
  splitUrl,
} from '@patchbay/core';

export interface RefChoice {
  text: string;
  label: string;
}

export const PART_LABELS: Record<ParamPart, string> = {
  from: 'first day',
  to: 'last day',
  start: 'start, epoch ms',
  end: 'end, epoch ms',
};

export function refChoices(
  parameters: readonly Parameter[] | undefined,
  place: RefPlace,
  context: { secrets: boolean },
): RefChoice[] {
  return (parameters ?? []).flatMap((p) =>
    (p.type === 'dateRange' ? [...PARAM_PARTS] : [null]).flatMap((part) =>
      refProblem(p, { id: p.id, part, place }, context)
        ? []
        : [
            {
              text: `$param.${p.id}${part ? `.${part}` : ''}`,
              label: part ? `${p.label} (${PART_LABELS[part]})` : p.label,
            },
          ],
    ),
  );
}

/**
 * The references a connector parameter can take. None for a yes/no one: its schema coerces any text, "false" too, to
 * true, so a filter could never turn it off.
 */
export function connectorChoices(
  parameters: readonly Parameter[] | undefined,
  spec: Pick<ParamSpec, 'type'>,
): RefChoice[] {
  return spec.type === 'boolean' ? [] : refChoices(parameters, 'connector', { secrets: false });
}

export function insertAt(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}

/**
 * Where a caret in a URL can take a reference: right after a "/" of the path with nothing of the segment after it, or
 * right after the "=" of a query pair with nothing of the value after it. Anywhere else a reference would be embedded.
 */
export function urlPlaceAt(url: string, caret: number): 'urlPath' | 'urlQuery' | null {
  const { authority, path, query } = splitUrl(url);
  const pathStart = authority.length;
  const pathEnd = pathStart + path.length;
  const before = url[caret - 1];
  const after = url[caret];
  if (caret > pathStart && caret <= pathEnd)
    return before === '/' && (after === undefined || after === '/' || after === '?' || after === '#')
      ? 'urlPath'
      : null;
  if (query !== null && caret > pathEnd && caret <= pathEnd + 1 + query.length) {
    // A second "=" inside the value would be saved as a reference the check refuses.
    const pair =
      url
        .slice(pathEnd + 1, caret)
        .split('&')
        .at(-1) ?? '';
    return before === '=' &&
      pair.indexOf('=') === pair.length - 1 &&
      (after === undefined || after === '&' || after === '#')
      ? 'urlQuery'
      : null;
  }
  return null;
}

/**
 * What a select shows when `chosen` may not be among its options (yet): the browser shows the first one, so the form
 * must use it too. Columns arrive after the step is added on a slow API, and filters can be removed meanwhile.
 */
export function chosenOrFirst(chosen: string, options: readonly string[]): string {
  return options.includes(chosen) ? chosen : (options[0] ?? '');
}

/** "Match a filter" for the Filter rows step: the expression for a filter and the column it filters. */
export function filterPreset(param: Parameter, column: string): string {
  const col = fieldRef(column);
  const ref = `$param.${param.id}`;
  switch (param.type) {
    case 'select':
      return param.all !== undefined ? `${ref} == null || ${col} == ${ref}` : `${col} == ${ref}`;
    case 'text':
      return `${ref} == "" || contains(${col}, ${ref})`;
    case 'dateRange':
      return `${col} >= ${ref}.start && ${col} < ${ref}.end`;
  }
}

/** The dataset list's tooltip: "Changes with Region, Period", in declared order. */
export function filtersTooltip(doc: DashboardDoc, datasetId: string): string | null {
  const ids = new Set(lineageParameters(doc, datasetId));
  if (ids.size === 0) return null;
  return `Changes with ${(doc.parameters ?? [])
    .filter((p) => ids.has(p.id))
    .map((p) => p.label)
    .join(', ')}`;
}

/** The reference a connector parameter consists of, or null. */
export function wholeRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = readRef(value);
  return ref && !('problem' in ref) ? value : null;
}
