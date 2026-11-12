/**
 * The form behind the Filters panel (proposal 0010): new declarations, the options text, and the operations a save
 * sends. Plain TypeScript, so its rules are tested without a browser; every change still goes through applyOps.
 */
import {
  type DashboardDoc,
  type DatePreset,
  type DateRange,
  declarationIssues,
  formatZodIssues,
  MAX_PARAMETERS,
  type OpInput,
  type OptionValue,
  optionWriteIssues,
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

/** Only "\|" is an escape: a "|" inside a value or label. The first "|" not written so ends the value. */
const escapeBars = (text: string) => text.replace(/\|/g, '\\|');
const unescapeBars = (text: string) => text.replace(/\\\|/g, '|');
/** One option per line cannot hold a line break: it is shown as this mark. */
const LINE_BREAK = '↵';
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, LINE_BREAK);
const shown = (text: string) => escapeBars(oneLine(text));

/** The first "|" not written as "\|", or -1. A loop, not a lookbehind: older Safari cannot parse one. */
function separatorAt(line: string): number {
  for (let i = 0; i < line.length; i++) if (line[i] === '|' && line[i - 1] !== '\\') return i;
  return -1;
}

/**
 * One option per line, "value" or "value | Label": pasting a list is the quickest way to declare a choice. A "|"
 * inside is written "\|", and a line break shows as "↵".
 */
export function optionsText(options: readonly OptionInput[]): string {
  return options
    .map((o) => {
      const value = String(o.value);
      return o.label !== undefined && o.label !== value
        ? `${shown(value)} | ${shown(o.label)}`
        : shown(value);
    })
    .join('\n');
}

export function parseOptions(text: string, previous: readonly OptionInput[] = []): OptionInput[] {
  return text.split('\n').flatMap((line) => {
    const at = separatorAt(line);
    const value = unescapeBars(at < 0 ? line : line.slice(0, at)).trim();
    if (!value) return [];
    const label = at < 0 ? '' : unescapeBars(line.slice(at + 1)).trim();
    // What an agent declared stays as declared while its text is unchanged: a number stays a number, and a line
    // break shown as "↵" stays a line break. The editor itself writes the text it shows.
    const prev = previous.find((o) => oneLine(String(o.value)) === value);
    const kept = prev?.value ?? value;
    const keptText = String(kept);
    const keptLabel = prev?.label !== undefined && oneLine(prev.label) === label ? prev.label : label;
    // "eu | eu" saved by an agent shows as "eu"; typed back either way, it keeps its label.
    const keepSame = prev?.label === keptText && (!label || label === value);
    return [
      {
        value: kept,
        ...(keptLabel && keptLabel !== keptText ? { label: keptLabel } : keepSame ? { label: keptText } : {}),
      },
    ];
  });
}

/**
 * The draft change of the "Fixed list" / "From a dataset column" switch. Never both: the schema refuses options
 * together with optionsFrom. A list starts from what the author typed before, or empty: a made-up option would save
 * as a real choice, while an empty list keeps Save disabled with the reason. `previous` are the options the form
 * opened with: switching to a column and back keeps what they hold.
 */
export function choiceSourcePatch(
  mode: 'list' | 'data',
  draft: Record<string, unknown>,
  optionsDraft: string,
  firstDataset: string | undefined,
  previous: readonly OptionInput[] = [],
): Record<string, unknown> {
  if (mode === 'data')
    return {
      options: undefined,
      optionsFrom: { dataset: firstDataset ?? '', field: '' },
      all: typeof draft.all === 'string' ? draft.all : 'All',
      default: null,
    };
  return { optionsFrom: undefined, options: parseOptions(optionsDraft, previous) };
}

/** The declaration a form describes, or the first reason it cannot be saved (the same checks as a save). */
export function checkParameter(
  candidate: unknown,
  others: readonly Parameter[],
  /** The saved declaration being edited, if any: option values it already holds stay allowed. */
  previous?: Parameter,
): { parameter: Parameter } | { error: string } {
  const parsed = ParameterSchema.safeParse(candidate);
  if (!parsed.success) return { error: formatZodIssues(parsed.error)[0] ?? 'This filter is not valid' };
  const issue =
    declarationIssues([...others, parsed.data]).find((i) => i.includes(`"${parsed.data.id}"`)) ??
    optionWriteIssues(parsed.data, previous)[0];
  return issue ? { error: issue } : { parameter: parsed.data };
}

/**
 * The patch that keeps `default` valid after the options or the ticked presets changed, so the Default list never
 * shows a value the saved filter would not accept; {} when it already is. Data-fed choices always start at All.
 */
export function reseatDefault(
  draft: Record<string, unknown>,
  /** The options before this edit: typing in the default's own line moves the default with it. */
  previousOptions?: readonly OptionInput[],
): Record<string, unknown> {
  if (draft.type === 'select' && !draft.optionsFrom) {
    const options = (draft.options as OptionInput[] | undefined) ?? [];
    const hasAll = draft.all !== undefined;
    if (draft.default === null) return hasAll ? {} : { default: options[0]?.value ?? null };
    if (options.some((o) => String(o.value) === String(draft.default))) return {};
    // Typing in the default's own line changes its value; follow the line, not the first option.
    const was = previousOptions?.findIndex((o) => String(o.value) === String(draft.default)) ?? -1;
    if (was >= 0 && previousOptions?.length === options.length) return { default: options[was]?.value };
    return { default: hasAll ? null : (options[0]?.value ?? null) };
  }
  if (draft.type === 'dateRange' && typeof draft.default === 'string') {
    const presets = (draft.presets as DatePreset[] | undefined) ?? [];
    if (presets.length === 0 || presets.includes(draft.default as DatePreset)) return {};
    return { default: presets[0] };
  }
  return {};
}

/** Why no filter can be added (shown beside the disabled button, where touch users see it); null when one can. */
export function addFilterBlocker(parameters: readonly Parameter[] | undefined): string | null {
  return (parameters?.length ?? 0) >= MAX_PARAMETERS
    ? `A dashboard has at most ${MAX_PARAMETERS} filters`
    : null;
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
    // A data-fed choice always starts at All, and a value equal to the default would only add an empty version.
    if (!Object.hasOwn(raw, p.id) || (p.type === 'select' && p.optionsFrom)) return [];
    const value = values[p.id];
    const next =
      p.type === 'dateRange'
        ? ((value as DateRange).preset ?? { from: (value as DateRange).from, to: (value as DateRange).to })
        : value;
    return JSON.stringify(next) === JSON.stringify(p.default)
      ? []
      : [{ op: 'updateParameter', id: p.id, set: { default: next } }];
  });
}

/** "Used by Sales (filter step), Orders (URL query)", or null when nothing uses the filter. */
export function usageText(doc: Pick<DashboardDoc, 'datasets' | 'widgets'>, id: string): string | null {
  const uses = parameterUsage(doc, id);
  return uses.length ? `Used by ${uses.map((u) => `${u.name} (${PLACE_LABELS[u.place]})`).join(', ')}` : null;
}
