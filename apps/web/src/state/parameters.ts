/**
 * The filter values of the page (proposal 0010). The page URL is the state: `p.<id>` query parameters, only for values
 * that differ from their default, so a plain /d/<id> link follows whatever defaults an editor sets later. This store
 * mirrors them for code outside React (fetches, sound cues) and is kept in step with the URL by `useParameterUrl`.
 * Values are never saved into the document.
 */
import {
  defaultText,
  type Parameter,
  parameterText,
  readParameterValues,
  type ValueProblem,
} from '@patchbay/core';
import { create } from 'zustand';

/** Valid values that differ from their default, by filter id, in their text form. */
export type RawValues = Readonly<Record<string, string>>;
/** Filter bar changes replace the history entry; a cross-filter click (phase 2) pushes one, so Back undoes it. */
export type HistoryMode = 'replace' | 'push';

const EMPTY: RawValues = {};

export function rawFromSearch(search: URLSearchParams): Record<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of search)
    if (key.startsWith('p.') && !found.has(key.slice(2))) found.set(key.slice(2), value);
  // fromEntries, not assignment: "p.__proto__" stays an ordinary key, which no declaration ever reads.
  return Object.fromEntries(found);
}

/** The URL's other parameters as they were, then the filters, sorted, so one view always has one URL. */
export function searchWith(search: URLSearchParams, raw: RawValues): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of search) if (!key.startsWith('p.')) next.append(key, value);
  for (const id of Object.keys(raw).sort()) next.append(`p.${id}`, raw[id]!);
  return next;
}

/** `p.q=a%20b&p.region=eu`: the view part of a link, empty at the defaults. */
export function rawQuery(raw: RawValues): string {
  return Object.keys(raw)
    .sort()
    .map((id) => `p.${id}=${encodeURIComponent(raw[id]!)}`)
    .join('&');
}

export const sameRaw = (a: RawValues, b: RawValues) => rawQuery(a) === rawQuery(b);

export function pickRaw(raw: RawValues, ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(ids.filter((id) => Object.hasOwn(raw, id)).map((id) => [id, raw[id]!]));
}

/** The values a URL may keep: valid, different from the default. Unknown ids go quietly: a filter was removed. */
export function normalizeRaw(
  parameters: readonly Parameter[] | undefined,
  raw: RawValues,
  now: number,
): { raw: Record<string, string>; problems: ValueProblem[] } {
  // Own-property lookup only: a link must not reach a prototype name.
  const given = (id: string) => (Object.hasOwn(raw, id) ? raw[id] : undefined);
  const { values, problems } = readParameterValues(parameters, given, now);
  const invalid = new Set(problems.map((p) => p.id));
  const out: Record<string, string> = {};
  for (const p of parameters ?? []) {
    if (invalid.has(p.id) || given(p.id) === undefined) continue;
    const text = parameterText(p, values[p.id]!);
    // A declared id (never a prototype name), so assigning is safe.
    if (text !== defaultText(p)) out[p.id] = text;
  }
  return { raw: out, problems };
}

/** One filter set to `text` (null: back to its default), or why it cannot be. */
export function applyValue(
  parameters: readonly Parameter[] | undefined,
  raw: RawValues,
  id: string,
  text: string | null,
  now: number,
): { raw: Record<string, string> } | { problem: string } {
  const next = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== id));
  const param = parameters?.find((p) => p.id === id);
  if (!param || text === null) return { raw: next };
  const { values, problems } = readParameterValues([param], (x) => (x === id ? text : undefined), now);
  if (problems.length > 0) return { problem: problems[0]!.message };
  const normal = parameterText(param, values[id]!);
  if (normal !== defaultText(param)) next[id] = normal;
  return { raw: next };
}

interface ParameterState {
  /** The dashboard whose URL `raw` was read from; null until it was. Data queries wait for it. */
  dashboardId: string | null;
  raw: RawValues;
  history: HistoryMode;
  /** Sets one filter; returns why it cannot be set, or null. */
  set(
    id: string,
    text: string | null,
    parameters: readonly Parameter[] | undefined,
    history?: HistoryMode,
  ): string | null;
  reset(history?: HistoryMode): void;
}

export const useParameters = create<ParameterState>((set, get) => ({
  dashboardId: null,
  raw: EMPTY,
  history: 'replace',
  set(id, text, parameters, history = 'replace') {
    const result = applyValue(parameters, get().raw, id, text, Date.now());
    if ('problem' in result) return result.problem;
    if (!sameRaw(result.raw, get().raw)) set({ raw: result.raw, history });
    return null;
  },
  reset(history = 'replace') {
    if (Object.keys(get().raw).length > 0) set({ raw: EMPTY, history });
    else set({ history: 'replace' });
  },
}));
