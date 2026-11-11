/**
 * Dashboard parameters (proposal 0010): values a viewer chooses in the dashboard's header, declared in the document as
 * `parameters` and referenced from datasets as `$param.<id>`. The UI calls them filters. The field name keeps them
 * apart from a connector's `params` and a secret's `paramName`.
 *
 * Values cross every boundary (page URL, REST query, MCP arguments) in one text form, read here against the
 * declarations. Only types are imported from the document schema: `schema.ts` imports this module for its schema and
 * checks, like `lineage.ts`.
 */
import { z } from 'zod';
import { MAX_BOUND_EXPRESSION, paramNodes, parse } from './expr.ts';
import { IdSchema } from './ids.ts';
import { type LineageDataset, type LineageDoc, lineageDatasets } from './lineage.ts';
import { PARAM_ID, PARAM_PREFIX, type RefName, readRef, WHOLE_REF } from './param-ref.ts';
import type { DashboardDoc } from './schema.ts';
import type { DataTable } from './table.ts';

export const MAX_PARAMETERS = 8;
export const MAX_TEXT_VALUE = 100;
/** Choices a select takes from a dataset column (proposal 0010, phase 2): the bound on views and on the list. */
export const MAX_DATA_OPTIONS = 200;
/** "All" in the text form of a select. An option may therefore not be "*". */
export const ALL_TEXT = '*';

export const ParamIdSchema = z
  .string()
  .regex(PARAM_ID, 'Filter ids are 1-32 chars of a-z, 0-9 or "_", starting with a letter');

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'last7d',
  'last30d',
  'last90d',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'last12m',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7d: 'Last 7 days',
  last30d: 'Last 30 days',
  last90d: 'Last 90 days',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisYear: 'This year',
  last12m: 'Last 12 months',
};

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** Epoch ms of 00:00 UTC on an ISO date, or null when it is not a calendar date ("2026-02-30"). */
export function isoDay(text: string): number | null {
  if (!ISO_DATE.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const IsoDate = z
  .string()
  .regex(ISO_DATE, 'Dates are YYYY-MM-DD')
  .refine((s) => isoDay(s) !== null, 'Not a calendar date');

export const OptionValueSchema = z.union([z.string().min(1).max(100), z.number()]);
export type OptionValue = z.infer<typeof OptionValueSchema>;

const base = { id: ParamIdSchema, label: z.string().min(1).max(40) };

// Field descriptions live in the MCP reference text: every byte here is paid on each MCP connection.
export const ParameterSchema = z.discriminatedUnion('type', [
  z
    .strictObject({
      ...base,
      type: z.literal('select'),
      options: z
        .array(z.strictObject({ value: OptionValueSchema, label: z.string().min(1).max(60).optional() }))
        .min(1, 'Give at least one option')
        .max(50)
        .optional(),
      // The distinct values of a column of a dataset that uses no filter, instead of a fixed list.
      optionsFrom: z.strictObject({ dataset: IdSchema, field: z.string().min(1).max(200) }).optional(),
      // Its presence offers "All" under this label ("All regions", "Any status"); the value of "All" is null.
      all: z.string().min(1).max(40).optional(),
      default: OptionValueSchema.nullable(),
    })
    .superRefine((p, ctx) => {
      if ((p.options === undefined) === (p.optionsFrom === undefined))
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give either options or optionsFrom' });
    }),
  z.strictObject({
    ...base,
    type: z.literal('text'),
    placeholder: z.string().max(60).optional(),
    // Trimmed at parse so stored defaults with stray spaces read the same as links, snapshots and the page.
    default: z.string().trim().max(MAX_TEXT_VALUE).default(''),
  }),
  z.strictObject({
    ...base,
    type: z.literal('dateRange'),
    presets: z.array(z.enum(DATE_PRESETS)).min(1).max(DATE_PRESETS.length),
    custom: z.boolean().default(false),
    min: IsoDate.optional(),
    max: IsoDate.optional(),
    maxDays: z.number().int().min(1).max(3660).default(366),
    default: z.union([z.enum(DATE_PRESETS), z.strictObject({ from: IsoDate, to: IsoDate })]),
  }),
]);
export type Parameter = z.infer<typeof ParameterSchema>;
export type ParameterInput = z.input<typeof ParameterSchema>;
export type SelectParam = Extract<Parameter, { type: 'select' }>;
export type DateParam = Extract<Parameter, { type: 'dateRange' }>;

/** A date range's value in every form a reference may ask for. `preset` keeps a link relative ("last7d"). */
export interface DateRange {
  from: string;
  to: string;
  start: number;
  end: number;
  preset?: DatePreset;
}

/** What a data answer for a relative period states (types.ts `DatasetResult.calendar`). */
export interface CalendarWindow {
  /** The resolved windows, "from..to" per filter at a relative preset, joined with "|" (the format of soundWindow). */
  window: string;
  /** Whole seconds, rounded up, from the moment the server resolved the view to the next 00:00 UTC. */
  validForSec: number;
}

/** One formatter for the server's stated window and the web's own fallback, so the two never differ in form. */
export const windowText = (range: Pick<DateRange, 'from' | 'to'>) => `${range.from}..${range.to}`;

/**
 * The calendar window of the filters `ids` at a relative preset, and how long it stays valid. Every preset may change
 * at midnight UTC (lastMonth then simply gives the same window again), so validity always ends there. Null when none
 * of them is at a relative preset.
 */
export function calendarOf(
  parameters: readonly Parameter[] | undefined,
  ids: readonly string[],
  values: ParameterValues,
  now: number,
): CalendarWindow | null {
  const windows = ids.flatMap((id) => {
    const p = parameters?.find((x) => x.id === id);
    const v = values[id];
    return p?.type === 'dateRange' && v && typeof v === 'object' && v.preset ? [windowText(v)] : [];
  });
  if (windows.length === 0) return null;
  const midnight = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  return { window: windows.join('|'), validForSec: Math.ceil((midnight - now) / 1000) };
}

export type ParameterValue = string | number | null | DateRange;
export type ParameterValues = Readonly<Record<string, ParameterValue>>;

export interface ValueProblem {
  id: string;
  message: string;
}

function rangeOf(first: number, last: number): DateRange {
  return { from: isoOf(first), to: isoOf(last), start: first, end: last + DAY_MS };
}

/** First and last day of each preset, for a given UTC day; `last7d` is the seven days ending today. */
const PRESET_DAYS: Record<DatePreset, (today: number, y: number, m: number, d: number) => [number, number]> =
  {
    today: (t) => [t, t],
    yesterday: (t) => [t - DAY_MS, t - DAY_MS],
    last7d: (t) => [t - 6 * DAY_MS, t],
    last30d: (t) => [t - 29 * DAY_MS, t],
    last90d: (t) => [t - 89 * DAY_MS, t],
    thisMonth: (t, y, m) => [Date.UTC(y, m, 1), t],
    lastMonth: (_t, y, m) => [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1) - DAY_MS],
    thisYear: (t, y) => [Date.UTC(y, 0, 1), t],
    // The day after the same day a year earlier; a leap day, which has none, uses the last day of that February.
    last12m: (t, y, m, d) => [
      Date.UTC(y - 1, m, Math.min(d, new Date(Date.UTC(y - 1, m + 1, 0)).getUTCDate())) + DAY_MS,
      t,
    ],
  };

/** A relative preset against `now`, in UTC: a wall screen pinned to one moves to the new day by itself. */
export function presetRange(preset: DatePreset, now: number): DateRange {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const day = new Date(today);
  const [first, last] = PRESET_DAYS[preset](today, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return { ...rangeOf(first, last), preset };
}

/** Why a custom range does not fit the declaration, as the end of a sentence, or null. */
function rangeIssue(p: DateParam, from: string, to: string): string | null {
  const first = isoDay(from);
  const last = isoDay(to);
  if (first === null || last === null) return 'has a day that is not on the calendar';
  if (last < first) return 'ends before it starts';
  if ((p.min !== undefined && from < p.min) || (p.max !== undefined && to > p.max))
    return `must lie between ${p.min ?? 'any date'} and ${p.max ?? 'any date'}`;
  const days = (last - first) / DAY_MS + 1;
  if (days > p.maxDays) return `is ${days} days long; at most ${p.maxDays}`;
  return null;
}

export function defaultValue(param: Parameter, now: number): ParameterValue {
  switch (param.type) {
    case 'select':
    case 'text':
      return param.default;
    case 'dateRange':
      return typeof param.default === 'string'
        ? presetRange(param.default, now)
        : rangeOf(isoDay(param.default.from)!, isoDay(param.default.to)!);
  }
}

/** The text form of a value: what a link, a REST query and an MCP argument carry. */
export function parameterText(param: Parameter, value: ParameterValue): string {
  switch (param.type) {
    case 'select':
      return value === null ? ALL_TEXT : String(value);
    case 'text':
      return typeof value === 'string' ? value : '';
    case 'dateRange': {
      const range = value as DateRange;
      return range.preset ?? `${range.from}..${range.to}`;
    }
  }
}

export function defaultText(param: Parameter): string {
  switch (param.type) {
    case 'select':
      return param.default === null ? ALL_TEXT : String(param.default);
    case 'text':
      return param.default;
    case 'dateRange':
      return typeof param.default === 'string' ? param.default : `${param.default.from}..${param.default.to}`;
  }
}

/** A value as the messages quote it: a hand-edited link can carry anything, and the message goes back to it. */
const quoted = (text: string) => `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;

export interface ReadOptions {
  /** The loaded choices of selects with optionsFrom, by filter id. */
  dataOptions?: ReadonlyMap<string, readonly OptionValue[]>;
  /**
   * The browser reads the page URL before the choices arrive: it keeps such a value, and the server (which always
   * loads them) decides.
   */
  lenientData?: boolean;
}

/** The choices of a select as values: its fixed options, the loaded data options, or null when not loaded. */
function choicesOf(p: SelectParam, options: ReadOptions): readonly OptionValue[] | null {
  if (!p.optionsFrom) return (p.options ?? []).map((o) => o.value);
  return options.dataOptions?.get(p.id) ?? null;
}

function readValue(
  p: Parameter,
  text: string,
  now: number,
  options: ReadOptions,
): { value: ParameterValue } | { message: string } {
  switch (p.type) {
    case 'select': {
      if (text === ALL_TEXT && p.all) return { value: null };
      const choices = choicesOf(p, options);
      if (choices === null) {
        if (options.lenientData) {
          // Data never offers an empty or over-long choice: say so instead of blaming the options dataset.
          if (text.length === 0 || text.length > MAX_TEXT_VALUE)
            return { message: `Filter "${p.id}" has no value ${quoted(text)}` };
          return { value: text };
        }
        return {
          message: `Filter "${p.id}" takes its choices from dataset "${p.optionsFrom!.dataset}", which could not be read`,
        };
      }
      const found = choices.find((v) => String(v) === text);
      if (found !== undefined) return { value: found };
      const listed = choices.slice(0, 20).map(String).join(', ') + (choices.length > 20 ? ', …' : '');
      // Only data can offer none: a fixed list has at least one option.
      const offer =
        choices.length === 0
          ? `the data offers no choices${p.all ? ', only * for all' : ''}`
          : `choose one of ${listed}${p.all ? ', or * for all' : ''}`;
      return { message: `Filter "${p.id}" has no value ${quoted(text)}; ${offer}` };
    }
    case 'text': {
      const value = text.trim();
      return value.length > MAX_TEXT_VALUE
        ? { message: `Filter "${p.id}" takes at most ${MAX_TEXT_VALUE} characters` }
        : { value };
    }
    case 'dateRange': {
      if ((p.presets as readonly string[]).includes(text))
        return { value: presetRange(text as DatePreset, now) };
      const m = RANGE.exec(text);
      if (!m) {
        const custom = p.custom ? ', or a range like 2026-01-01..2026-01-31' : '';
        return {
          message: `Filter "${p.id}" has no value ${quoted(text)}; choose one of ${p.presets.join(', ')}${custom}`,
        };
      }
      if (!p.custom)
        return { message: `Filter "${p.id}" takes only its presets (${p.presets.join(', ')}), not a range` };
      const [, from, to] = m as unknown as [string, string, string];
      const reason = rangeIssue(p, from, to);
      if (reason) return { message: `Filter "${p.id}": the range ${from}..${to} ${reason}` };
      return { value: rangeOf(isoDay(from)!, isoDay(to)!) };
    }
  }
}

/**
 * The values of a view. A missing value takes the default; an invalid one takes the default and is named in
 * `problems` with what may be chosen. Ids that are not declared are ignored, so a link survives the removal of a
 * filter. `raw` should read own properties only: "constructor" is a valid id, and a non-string answer counts as
 * absent.
 */
export function readParameterValues(
  parameters: readonly Parameter[] | undefined,
  raw: (id: string) => string | undefined,
  now: number,
  options: ReadOptions = {},
): { values: Record<string, ParameterValue>; problems: ValueProblem[] } {
  const values: Record<string, ParameterValue> = {};
  const problems: ValueProblem[] = [];
  for (const p of parameters ?? []) {
    const given = raw(p.id);
    const text = typeof given === 'string' ? given : undefined;
    if (text === undefined) {
      values[p.id] = defaultValue(p, now);
      continue;
    }
    const read = readValue(p, text, now, options);
    if ('message' in read) {
      problems.push({ id: p.id, message: read.message });
      values[p.id] = defaultValue(p, now);
    } else values[p.id] = read.value;
  }
  return { values, problems };
}

/** The values of a view with nothing chosen: every filter at its default. */
export function defaultParameterValues(
  parameters: readonly Parameter[] | undefined,
  now: number = Date.now(),
): ParameterValues {
  return readParameterValues(parameters, () => undefined, now).values;
}

/** The `p.<id>` entries of a link to this view: only values that differ from their default, in declared order. */
export function writeParameterValues(
  parameters: readonly Parameter[] | undefined,
  values: ParameterValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parameters ?? []) {
    if (!Object.hasOwn(values, p.id)) continue;
    const text = parameterText(p, values[p.id] as ParameterValue);
    if (text !== defaultText(p)) out[`p.${p.id}`] = text;
  }
  return out;
}

/** The view as a canonical query string: sorted, encoded, empty at the defaults (snapshot keys, view links). */
export function viewQuery(parameters: readonly Parameter[] | undefined, values: ParameterValues): string {
  return Object.entries(writeParameterValues(parameters, values))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, text]) => `${key}=${encodeURIComponent(text)}`)
    .join('&');
}

export function describeParameterValue(param: Parameter, value: ParameterValue): string {
  switch (param.type) {
    case 'select': {
      if (value === null) return param.all ?? 'All';
      const option = param.options?.find((o) => o.value === value);
      return option?.label ?? String(value);
    }
    case 'text':
      return `"${typeof value === 'string' ? value : ''}"`;
    case 'dateRange': {
      const range = value as DateRange;
      return range.preset ? DATE_PRESET_LABELS[range.preset] : `${range.from} – ${range.to}`;
    }
  }
}

/** "Region: EU · Period: Last 7 days": the line a wall screen and an agent see. An empty text filter is left out. */
export function parameterSummary(
  parameters: readonly Parameter[] | undefined,
  values: ParameterValues,
): string {
  return (parameters ?? [])
    .flatMap((p) => {
      if (!Object.hasOwn(values, p.id)) return [];
      const value = values[p.id] as ParameterValue;
      if (p.type === 'text' && value === '') return [];
      return [`${p.label}: ${describeParameterValue(p, value)}`];
    })
    .join(' · ');
}

/** Where a reference stands. `url` is a misplaced one: in an address's authority or fragment, or a query name. */
export type RefPlace = 'filter' | 'derive' | 'url' | 'urlPath' | 'urlQuery' | 'body' | 'connector' | 'click';

export const PLACE_LABELS: Record<RefPlace, string> = {
  filter: 'filter step',
  derive: 'derive step',
  url: 'URL',
  urlPath: 'URL path',
  urlQuery: 'URL query',
  body: 'body',
  connector: 'connector parameters',
  click: 'click',
};

/** Chart kinds whose items stand for one value of a column: a bar, a point of a line or area, a slice. */
export const CROSS_FILTER_KINDS = ['bar', 'line', 'area', 'pie', 'donut', 'funnel'] as const;
/** Of those, the ones without series: their items are the values of x. */
export const PROPORTION_KINDS = ['pie', 'donut', 'funnel'] as const;

export interface ParameterRef extends RefName {
  place: RefPlace;
  /** The reference as written, for messages. */
  text: string;
  /** Why it cannot stand there; set for references no value could fill, whatever the declarations. */
  problem?: string;
}

/** A reference and what may follow its id: the class decides where an embedded one ends, for messages only. */
const REF_TEXT = /\$param\.[A-Za-z0-9_.]*/g;
const shortQuote = (text: string) => `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;

/**
 * A value that may hold one reference, as the whole of it: no delimiter rules, nothing to escape by context, and no
 * way to splice a value into a query language.
 */
function wholeValue(text: string, place: RefPlace, inside: string, example: string, out: ParameterRef[]) {
  if (!text.includes(PARAM_PREFIX)) return;
  if (WHOLE_REF.test(text)) {
    const ref = readRef(text)!;
    out.push(
      'problem' in ref ? { id: '', part: null, place, text, problem: ref.problem } : { ...ref, place, text },
    );
    return;
  }
  for (const m of text.matchAll(REF_TEXT)) {
    const ref = readRef(m[0]);
    out.push({
      id: ref && !('problem' in ref) ? ref.id : '',
      part: null,
      place,
      text: m[0],
      problem: `${shortQuote(text)} puts a filter inside a longer ${inside}; ${example}`,
    });
  }
}

const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*[^/?#\\]*/;

/**
 * The parts of an address as written. Split as text rather than parsed with `new URL`, which normalises: binding must
 * keep every byte outside a reference exactly as saved (the HTTP cache key and the showcase's exact-match trust).
 */
export function splitUrl(url: string): {
  authority: string;
  path: string;
  query: string | null;
  fragment: string;
} {
  const authority = AUTHORITY.exec(url)?.[0] ?? '';
  const rest = url.slice(authority.length);
  const hash = rest.indexOf('#');
  const beforeHash = hash < 0 ? rest : rest.slice(0, hash);
  const fragment = hash < 0 ? '' : rest.slice(hash);
  const q = beforeHash.indexOf('?');
  return {
    authority,
    path: q < 0 ? beforeHash : beforeHash.slice(0, q),
    query: q < 0 ? null : beforeHash.slice(q + 1),
    fragment,
  };
}

const PATH_EXAMPLE = 'a filter must be a whole path segment, as in /regions/$param.region/sales';
const QUERY_EXAMPLE = 'a filter must be a whole query value, as in ?region=$param.region';
const VALUE_EXAMPLE =
  'a filter must be the whole value, as in { "region": "$param.region" }; never put one into query text, pass it as a variable';

function urlRefs(url: string, out: ParameterRef[]) {
  if (!url.includes(PARAM_PREFIX)) return;
  const { authority, path, query, fragment } = splitUrl(url);
  // The scheme, host, port and user info are where a request goes: no value may move it (SSRF).
  const misplaced = (text: string, problem: string) => {
    for (const m of text.matchAll(REF_TEXT))
      out.push({ id: '', part: null, place: 'url', text: m[0], problem });
  };
  misplaced(authority, 'Filters cannot be part of the scheme, host, port or user name of an address');
  misplaced(fragment, 'Filters cannot be part of the fragment (#…) of an address');
  for (const segment of path.split('/')) wholeValue(segment, 'urlPath', 'path segment', PATH_EXAMPLE, out);
  for (const pair of query === null ? [] : query.split('&')) {
    const eq = pair.indexOf('=');
    misplaced(
      eq < 0 ? pair : pair.slice(0, eq),
      'A query parameter name cannot be a filter; use it as the value: ?region=$param.region',
    );
    if (eq >= 0) wholeValue(pair.slice(eq + 1), 'urlQuery', 'query value', QUERY_EXAMPLE, out);
  }
}

function jsonRefs(value: unknown, place: 'body' | 'connector', out: ParameterRef[]) {
  if (typeof value === 'string') wholeValue(value, place, 'text', VALUE_EXAMPLE, out);
  else if (Array.isArray(value)) for (const v of value) jsonRefs(v, place, out);
  else if (value !== null && typeof value === 'object')
    for (const [key, v] of Object.entries(value)) {
      for (const m of key.matchAll(REF_TEXT))
        out.push({
          id: '',
          part: null,
          place,
          text: m[0],
          problem: 'A key cannot be a filter; use it as a value',
        });
      jsonRefs(v, place, out);
    }
}

/** A dataset's own references (not those of the datasets it reads), in source order, then step by step. */
export function parameterRefs(dataset: Pick<LineageDataset, 'source' | 'transforms'>): ParameterRef[] {
  const out: ParameterRef[] = [];
  const source = dataset.source;
  if (source.kind === 'http' || source.kind === 'feed') urlRefs(source.url, out);
  if (source.kind === 'http' && source.body !== undefined) jsonRefs(source.body, 'body', out);
  if (source.kind === 'connector') jsonRefs(source.params, 'connector', out);
  for (const step of dataset.transforms) {
    if ((step.type !== 'filter' && step.type !== 'derive') || !step.expr.includes(PARAM_PREFIX)) continue;
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(step.expr, { maxLength: MAX_BOUND_EXPRESSION });
    } catch {
      // An expression that does not parse is reported by the schema, with its position.
      continue;
    }
    for (const n of paramNodes(ast))
      out.push({
        id: n.id,
        part: n.part,
        place: step.type,
        text: `${PARAM_PREFIX}${n.id}${n.part ? `.${n.part}` : ''}`,
      });
  }
  return out;
}

/** The filters a dataset depends on, its own and those of everything it reads (proposal 0005), sorted. */
export function lineageParameters(doc: LineageDoc, id: string): string[] {
  const ids = lineageDatasets(doc, id).flatMap((d) => parameterRefs(d).map((r) => r.id));
  return [...new Set(ids.filter(Boolean))].sort();
}

export interface ParameterUse {
  /** The dataset (phase 2: also the widget) that uses the filter. */
  id: string;
  name: string;
  place: RefPlace;
}

/** What uses a filter, once per place: "Used by Sales (filter step), Orders (URL query), By region (click)". */
export function parameterUsage(
  doc: Pick<DashboardDoc, 'datasets' | 'widgets'>,
  paramId: string,
): ParameterUse[] {
  const datasets = doc.datasets.flatMap((d) =>
    [
      ...new Set(
        parameterRefs(d)
          .filter((r) => r.id === paramId)
          .map((r) => r.place),
      ),
    ].map((place) => ({
      id: d.id,
      name: d.name,
      place,
    })),
  );
  const widgets = doc.widgets.flatMap((w) =>
    (w.type === 'chart' || w.type === 'table' || w.type === 'map') &&
    w.config.crossFilter?.parameter === paramId
      ? [{ id: w.id, name: w.title ?? w.id, place: 'click' as const }]
      : [],
  );
  return [...datasets, ...widgets];
}

export interface RefContext {
  /** The source sends secrets: references stay out of its path, so the secret's binding holds for every value. */
  secrets: boolean;
}

/** Why `param` cannot fill a reference at this place, or null. The editor offers only references this accepts. */
export function refProblem(
  param: Parameter,
  ref: RefName & { place: RefPlace },
  context: RefContext,
): string | null {
  if (param.type === 'dateRange') {
    if (!ref.part)
      return `filter "${param.id}" is a date range: use .from, .to (YYYY-MM-DD) or .start, .end (epoch ms)`;
  } else if (ref.part) return `filter "${param.id}" has no part .${ref.part}; only date ranges have parts`;
  if (ref.place === 'filter' || ref.place === 'derive') return null;
  // Free text would let a viewer send anything to an upstream: decision 2 of proposal 0010.
  if (param.type === 'text')
    return `text filters work in filter and derive steps only, never in a request (filter "${param.id}")`;
  // Only static options reach a request sent with the owner's key (proposal 0010, "Security").
  if (param.type === 'select' && param.optionsFrom && context.secrets)
    return `choices from data never reach a source with secrets; give filter "${param.id}" a fixed list of options`;
  if (ref.place === 'urlPath') {
    if (param.type !== 'select') return `only a select filter can be a path segment (filter "${param.id}")`;
    if (param.all !== undefined)
      return `filter "${param.id}" offers "All", which no path segment can mean; use it in the query string`;
    if (context.secrets)
      return `a source with secrets takes filters only in query values and the body, never in the path (filter "${param.id}")`;
  }
  return null;
}

/** Whether an expression of a table rule or sound condition uses a filter, which it may not (phase 1). */
function expressionUsesFilters(src: string): boolean {
  if (!src.includes(PARAM_PREFIX)) return false;
  try {
    return paramNodes(parse(src)).length > 0;
  } catch {
    return false;
  }
}

/**
 * A lone UTF-16 surrogate is not text: it cannot be percent-encoded into an address and a link cannot carry it, so
 * the binder would refuse the value on every view. It is refused where it is declared instead.
 */
const brokenText = (text: string) => /\p{Cs}/u.test(text);
const BROKEN = 'holds a broken character (a lone UTF-16 surrogate)';

/**
 * Option values that may not be written: "$param." anywhere inside one. A bound body or connector value holding it is
 * refused as unbound by loadSource with a misleading message. Write-time only (addParameter, updateParameter, the
 * editor), never part of declarationIssues: that runs on every stored read, and documents saved since 0.3.0 may hold
 * such an option and must keep opening. Values `previous` already holds stay allowed, so a legacy filter can be
 * relabelled. A leading "$param." is already a read-time issue and is not repeated.
 */
export function optionWriteIssues(param: Parameter, previous?: Parameter): string[] {
  if (param.type !== 'select') return [];
  const held = new Set(
    previous?.type === 'select' ? (previous.options ?? []).map((o) => String(o.value)) : [],
  );
  const issues: string[] = [];
  for (const o of param.options ?? []) {
    const text = String(o.value);
    if (text.includes(PARAM_PREFIX) && !text.startsWith(PARAM_PREFIX) && !held.has(text))
      issues.push(`Filter "${param.id}": an option value cannot contain "${PARAM_PREFIX}" (${quoted(text)})`);
  }
  return issues;
}

/** What the schema cannot say about declarations: duplicates, reserved values, defaults that are not choices. */
export function declarationIssues(parameters: readonly Parameter[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const p of parameters) {
    if (seen.has(p.id)) issues.push(`Filter ids must be unique: "${p.id}" appears twice`);
    seen.add(p.id);
    const name = `Filter "${p.id}"`;
    if (p.type === 'select' && p.optionsFrom) {
      // Data may not hold a fixed default tomorrow; "All" always exists.
      if (p.all === undefined || p.default !== null)
        issues.push(
          `Filter "${p.id}" takes its choices from data, so it needs "All" (all) and the default null`,
        );
      continue;
    }
    if (p.type === 'select') {
      const texts = new Set<string>();
      for (const o of p.options ?? []) {
        const text = String(o.value);
        if (texts.has(text)) issues.push(`${name}: option "${text}" appears twice`);
        texts.add(text);
        if (text === ALL_TEXT)
          issues.push(`${name}: "*" stands for "All" in links; use another option value`);
        // A bound body or connector value equal to "$param.x" would read as a reference again.
        if (text.startsWith(PARAM_PREFIX))
          issues.push(`${name}: an option value cannot start with "${PARAM_PREFIX}"`);
        if (brokenText(text)) issues.push(`${name}: an option value ${BROKEN}`);
      }
      if (typeof p.default === 'string' && brokenText(p.default))
        issues.push(`${name}: the default ${BROKEN}`);
      else if (p.default === null) {
        if (!p.all)
          issues.push(
            `${name}: the default is "All" (null), but the filter offers no "All"; set all to its label`,
          );
      } else if (!texts.has(String(p.default)))
        issues.push(`${name}: the default "${p.default}" is not one of its options`);
    } else if (p.type === 'text') {
      if (brokenText(p.default)) issues.push(`${name}: the default ${BROKEN}`);
    } else if (p.type === 'dateRange') {
      if (p.min !== undefined && p.max !== undefined && p.min > p.max)
        issues.push(`${name}: min is after max`);
      if (typeof p.default === 'string') {
        if (!p.presets.includes(p.default))
          issues.push(`${name}: the default "${p.default}" is not one of its presets`);
      } else if (!p.custom) issues.push(`${name}: a range as default needs custom: true`);
      else {
        const reason = rangeIssue(p, p.default.from, p.default.to);
        if (reason) issues.push(`${name}: the default range ${reason}`);
      }
    }
  }
  return issues;
}

/** Problems of a document's filters that the schema cannot express; `integrityIssues` runs it on every write. */
export function parameterIssues(doc: Pick<DashboardDoc, 'parameters' | 'datasets' | 'widgets'>): string[] {
  const parameters = doc.parameters ?? [];
  const issues = declarationIssues(parameters);
  const byId = new Map(parameters.map((p) => [p.id, p]));
  const declared = parameters.length
    ? `declared filters: ${parameters.map((p) => p.id).join(', ')}`
    : 'no filters are declared';
  for (const d of doc.datasets) {
    const secrets = d.source.kind === 'http' && (d.source.secrets?.length ?? 0) > 0;
    const refs = parameterRefs(d);
    const said = new Set<string>();
    for (const r of refs) {
      const param = byId.get(r.id);
      const problem =
        r.problem ?? (param ? refProblem(param, r, { secrets }) : `unknown filter "${r.id}"; ${declared}`);
      if (!problem) continue;
      const line = `Dataset "${d.id}" (${PLACE_LABELS[r.place]}): ${problem}`;
      if (said.has(line)) continue;
      said.add(line);
      issues.push(line);
    }
    // The history holds the source's rows, keyed by dashboard and dataset, and restarts when the source text
    // changes: a source that differs per view would restart it on every load. Steps run after it and are harmless.
    if (d.accumulate > 0 && refs.some((r) => r.place !== 'filter' && r.place !== 'derive'))
      issues.push(
        `Dataset "${d.id}" keeps a history (accumulate) and its source uses filters, so every view would restart it; accumulate a dataset without filters and filter in a dataset derived from it`,
      );
  }
  for (const w of doc.widgets) {
    if (w.type === 'table' && (w.config.rules ?? []).some((rule) => expressionUsesFilters(rule.when)))
      issues.push(`Widget "${w.id}": filters ($param) work in datasets only, not in table rules`);
    if ('sound' in w && w.sound?.trigger.kind === 'condition' && expressionUsesFilters(w.sound.trigger.expr))
      issues.push(`Widget "${w.id}": filters ($param) work in datasets only, not in sound conditions`);
    const cross =
      w.type === 'chart' || w.type === 'table' || w.type === 'map' ? w.config.crossFilter : undefined;
    if (cross) {
      const name = `Widget "${w.id}"`;
      const param = byId.get(cross.parameter);
      if (!param) issues.push(`${name}: a click sets unknown filter "${cross.parameter}"; ${declared}`);
      else if (param.type === 'dateRange')
        issues.push(`${name}: a click can set a choice or a text filter, not the date range "${param.id}"`);
      if (w.type === 'chart') {
        const kind = w.config.kind;
        const proportion = (PROPORTION_KINDS as readonly string[]).includes(kind);
        if (!(CROSS_FILTER_KINDS as readonly string[]).includes(kind))
          issues.push(
            `${name}: clicks set filters on ${CROSS_FILTER_KINDS.slice(0, -1).join(', ')} and funnel charts, not ${kind}`,
          );
        else if (cross.field !== w.config.x && (proportion || cross.field !== w.config.series))
          issues.push(
            `${name}: a click on this chart gives its ${proportion ? 'x column' : 'x or series column'} (${[
              w.config.x,
              ...(!proportion && w.config.series ? [w.config.series] : []),
            ].join(', ')}), not "${cross.field}"`,
          );
      }
    }
  }
  return issues;
}

/**
 * Where selects take their choices from. Whole-document rules, run by integrityIssues next to parameterIssues: a
 * preview checks parameterIssues on a document that holds only its draft, where every options dataset is unknown.
 */
export function optionsFromIssues(doc: Pick<DashboardDoc, 'parameters' | 'datasets'>): string[] {
  const issues: string[] = [];
  for (const p of doc.parameters ?? []) {
    if (p.type !== 'select' || !p.optionsFrom) continue;
    const from = p.optionsFrom.dataset;
    if (!doc.datasets.some((d) => d.id === from))
      issues.push(`Filter "${p.id}" takes its choices from unknown dataset "${from}"`);
    // Choices that change with a filter would make a value valid in one view and not in another.
    else if (lineageParameters(doc, from).length > 0)
      issues.push(
        `Filter "${p.id}" takes its choices from "${from}", which changes with filters itself; use a dataset without filters`,
      );
  }
  return issues;
}

// One collator for every sort: localeCompare with a locale builds a new one per comparison, which made 10,000 values
// cost ~480 ms of the server's main thread on every request carrying a value.
const optionOrder = new Intl.Collator('en', { numeric: true });

/** A select's choices from a column: distinct values that can be choices, sorted, at most MAX_DATA_OPTIONS. */
export function distinctOptions(table: DataTable, field: string): OptionValue[] {
  const seen = new Set<string>();
  const out: OptionValue[] = [];
  for (const row of table.rows) {
    const v = row[field];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const text = String(v);
    // The rules of a fixed option: no "All" text, no reference, no broken character, and what a link can carry.
    if (
      text === '' ||
      text.length > MAX_TEXT_VALUE ||
      text === ALL_TEXT ||
      text.includes(PARAM_PREFIX) ||
      brokenText(text) ||
      seen.has(text)
    )
      continue;
    seen.add(text);
    out.push(v);
  }
  return out.sort((a, b) => optionOrder.compare(String(a), String(b))).slice(0, MAX_DATA_OPTIONS);
}
