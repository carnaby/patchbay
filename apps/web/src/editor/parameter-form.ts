/**
 * The form behind the Filters panel (proposal 0010): new declarations, the options text, and the operations a save
 * sends. Plain TypeScript, so its rules are tested without a browser; every change still goes through applyOps.
 */
import {
  type DashboardDoc,
  type DateRange,
  declarationIssues,
  formatZodIssues,
  type OpInput,
  type OptionValue,
  type Parameter,
  ParameterSchema,
  PLACE_LABELS,
  parameterUsage,
  readParameterValues,
} from '@patchbay/core';
import type { RawValues } from '../state/parameters.ts';

export type ParameterType = Parameter['type'];
export type OptionInput = { value: OptionValue; label?: string };

export const TYPE_LABELS: Record<ParameterType, string> = {
  select: 'Choice',
  text: 'Search text',
  dateRange: 'Period',
};

/** "Sales region" → "sales_region": a-z, 0-9 and "_", starting with a letter, unique among `taken`. */
export function idFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28)
    .replace(/_+$/, '');
  const id = /^[a-z]/.test(base) ? base : `f_${base}`.replace(/_+$/, '');
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id}_${n}`)) return `${id}_${n}`;
}

/** A declaration of each kind that saves as it is, for the editor to change from there. */
export function newParameter(type: ParameterType, taken: ReadonlySet<string>): Parameter {
  switch (type) {
    case 'select':
      return {
        id: idFromLabel('Choice', taken),
        label: 'Choice',
        type,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        all: 'All',
        default: null,
      };
    case 'text':
      return { id: idFromLabel('Search', taken), label: 'Search', type, default: '' };
    case 'dateRange':
      return {
        id: idFromLabel('Period', taken),
        label: 'Period',
        type,
        presets: ['last7d', 'last30d', 'last90d'],
        custom: false,
        maxDays: 366,
        default: 'last30d',
      };
  }
}

/** One option per line, "value" or "value | Label": pasting a list is the quickest way to declare a choice. */
export function optionsText(options: readonly OptionInput[]): string {
  return options
    .map((o) =>
      o.label !== undefined && o.label !== String(o.value) ? `${o.value} | ${o.label}` : String(o.value),
    )
    .join('\n');
}

export function parseOptions(text: string, previous: readonly OptionInput[] = []): OptionInput[] {
  return text.split('\n').flatMap((line) => {
    const [first = '', ...rest] = line.split('|');
    const value = first.trim();
    if (!value) return [];
    const label = rest.join('|').trim();
    // A number an agent declared stays a number while its text is unchanged; the editor itself writes text.
    const kept = previous.find((o) => String(o.value) === value)?.value ?? value;
    return [{ value: kept, ...(label && label !== value ? { label } : {}) }];
  });
}

/** The declaration a form describes, or the first reason it cannot be saved (the same checks as a save). */
export function checkParameter(
  candidate: unknown,
  others: readonly Parameter[],
): { parameter: Parameter } | { error: string } {
  const parsed = ParameterSchema.safeParse(candidate);
  if (!parsed.success) return { error: formatZodIssues(parsed.error)[0] ?? 'This filter is not valid' };
  const issue = declarationIssues([...others, parsed.data]).find((i) => i.includes(`"${parsed.data.id}"`));
  return issue ? { error: issue } : { parameter: parsed.data };
}

/** What changed between two declarations of one filter, as one updateParameter; null removes a field. */
export function updateOps(before: Parameter, after: Parameter): OpInput[] {
  const set: Record<string, unknown> = {};
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'id' || key === 'type') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) set[key] = b[key] === undefined ? null : b[key];
  }
  return Object.keys(set).length > 0 ? [{ op: 'updateParameter', id: before.id, set }] : [];
}

/** "Make current values the default": one updateParameter per filter the URL sets. */
export function defaultOps(
  parameters: readonly Parameter[] | undefined,
  raw: RawValues,
  now = Date.now(),
): OpInput[] {
  const { values } = readParameterValues(
    parameters,
    (id) => (Object.hasOwn(raw, id) ? raw[id] : undefined),
    now,
  );
  return (parameters ?? []).flatMap((p): OpInput[] => {
    if (!Object.hasOwn(raw, p.id)) return [];
    const value = values[p.id];
    const next =
      p.type === 'dateRange'
        ? ((value as DateRange).preset ?? { from: (value as DateRange).from, to: (value as DateRange).to })
        : value;
    return [{ op: 'updateParameter', id: p.id, set: { default: next } }];
  });
}

/** "Used by Sales (filter step), Orders (URL query)", or null when nothing uses the filter. */
export function usageText(doc: Pick<DashboardDoc, 'datasets'>, id: string): string | null {
  const uses = parameterUsage(doc, id);
  return uses.length ? `Used by ${uses.map((u) => `${u.name} (${PLACE_LABELS[u.place]})`).join(', ')}` : null;
}
