/**
 * Identities of dataset results in the web app (proposal 0005). A derived dataset's data changes when anything it
 * reads changes, so keys, the "saved yet?" check and sound baselines all use its lineage, not its own definition.
 */
import {
  lineageKey as computeLineageKey,
  type DashboardDoc,
  defaultText,
  type LineageDataset,
  lineageParameters,
  parameterRefs,
  type SoundRule,
  upstreamOf,
} from '@patchbay/core';
import { normalizeRaw, pickRaw, type RawValues } from './parameters.ts';

const memo = new WeakMap<DashboardDoc, Map<string, string>>();

/**
 * Cached per document and dataset: reading it runs on every render of every widget. Documents are immutable (the
 * editor store replaces `doc` through applyOps and never mutates it), so a cached key cannot go stale.
 */
export function lineageKey(doc: DashboardDoc, datasetId: string): string {
  const byId = memo.get(doc) ?? new Map<string, string>();
  memo.set(doc, byId);
  const cached = byId.get(datasetId);
  if (cached !== undefined) return cached;
  const key = computeLineageKey(doc, datasetId);
  byId.set(datasetId, key);
  return key;
}

const parameterMemo = new WeakMap<DashboardDoc, Map<string, string[]>>();

/** The filters a dataset depends on, its own and those of everything it reads; cached per document like the lineage. */
export function datasetParameters(doc: DashboardDoc, datasetId: string): string[] {
  const byId = parameterMemo.get(doc) ?? new Map<string, string[]>();
  parameterMemo.set(doc, byId);
  let ids = byId.get(datasetId);
  if (!ids) {
    ids = lineageParameters(doc, datasetId);
    byId.set(datasetId, ids);
  }
  return ids;
}

const acceptedMemo = new WeakMap<DashboardDoc, WeakMap<RawValues, RawValues>>();

/**
 * The values `doc`'s declarations accept, as `useParameterUrl` will normalise them. A new document (an option removed
 * in another tab) reaches the keys in the render that receives it, before that effect resets the store: reading the
 * values here means no request ever carries a value the declarations refuse. Validity does not depend on the clock.
 */
function acceptedRaw(doc: DashboardDoc, raw: RawValues): RawValues {
  const byRaw = acceptedMemo.get(doc) ?? new WeakMap<RawValues, RawValues>();
  acceptedMemo.set(doc, byRaw);
  let accepted = byRaw.get(raw);
  if (!accepted) {
    accepted = normalizeRaw(doc.parameters, raw, Date.now()).raw;
    byRaw.set(raw, accepted);
  }
  return accepted;
}

/**
 * The view part of a dataset's key: each filter it depends on with its declaration and current value, '' for a
 * dataset that uses none. A change of a filter changes the keys of exactly the datasets that use it, and the
 * declarations are in it because the server reads values against them.
 */
export function viewKey(doc: DashboardDoc, datasetId: string, raw: RawValues): string {
  const ids = datasetParameters(doc, datasetId);
  if (ids.length === 0) return '';
  const accepted = acceptedRaw(doc, raw);
  return JSON.stringify(
    ids.map((id) => [
      id,
      doc.parameters?.find((p) => p.id === id) ?? null,
      Object.hasOwn(accepted, id) ? accepted[id] : null,
    ]),
  );
}

/**
 * The data-driven selects whose value a dataset's request would carry, each with the cache key parts of its options
 * dataset (`[id, datasetId, lineage, view]`), as JSON: '' when there are none. A request waits until those choices
 * are checked (sync.ts), so a link to a value the data does not hold is reset before it reaches the server. An options
 * dataset that is gone is left out: its choices can never arrive, and the server answers.
 */
export function choiceChecks(doc: DashboardDoc, datasetId: string, raw: RawValues): string {
  const accepted = acceptedRaw(doc, raw);
  const checks = datasetParameters(doc, datasetId).flatMap((id) => {
    const p = doc.parameters?.find((x) => x.id === id);
    if (p?.type !== 'select' || !p.optionsFrom || !Object.hasOwn(accepted, id)) return [];
    const from = p.optionsFrom.dataset;
    if (!doc.datasets.some((d) => d.id === from)) return [];
    return [[id, from, lineageKey(doc, from), viewKey(doc, from, raw)]];
  });
  return checks.length > 0 ? JSON.stringify(checks) : '';
}

/** The query a view key asks the server for: `&p.region=eu`, or '' at the defaults. Read from the key itself, so a
 * request always carries exactly the values its cache entry is for. */
export function queryOfView(view: string): string {
  if (!view) return '';
  const entries = JSON.parse(view) as [string, unknown, string | null][];
  return entries
    .flatMap(([id, , text]) => (text === null ? [] : [`&p.${id}=${encodeURIComponent(text)}`]))
    .join('');
}

export const datasetKeyFor = (dashboardId: string, datasetId: string, lineage: string, view: string) =>
  ['data', dashboardId, datasetId, lineage, view] as const;

export const datasetKey = (dashboardId: string, doc: DashboardDoc, datasetId: string, raw: RawValues = {}) =>
  datasetKeyFor(dashboardId, datasetId, lineageKey(doc, datasetId), viewKey(doc, datasetId, raw));

/**
 * The server only knows saved definitions. A child whose parent has unsaved edits would come back computed from the
 * old parent and land under the new key, so it waits for the save like the parent does.
 */
export function datasetInSync(
  saved: DashboardDoc | null,
  doc: DashboardDoc | null,
  datasetId: string,
): boolean {
  if (!saved || !doc || !saved.datasets.some((d) => d.id === datasetId)) return false;
  if (!doc.datasets.some((d) => d.id === datasetId)) return false;
  // The server reads filter values against the saved declarations: a value of a new option waits for the save.
  return (
    lineageKey(saved, datasetId) === lineageKey(doc, datasetId) &&
    viewKey(saved, datasetId, {}) === viewKey(doc, datasetId, {})
  );
}

/** How long a result stays fresh, and the polling used only when the live channel is down. */
export function refreshTiming(refreshSec: number, live: boolean) {
  return {
    staleTime: refreshSec > 0 ? refreshSec * 1000 : 5 * 60_000,
    refetchInterval: refreshSec > 0 && !live ? Math.max(refreshSec, 5) * 1000 : (false as const),
  };
}

/** Rule, lineage and view: a change of any means the next result is only a baseline (CLAUDE.md). */
export function soundIdentity(
  doc: DashboardDoc | null | undefined,
  sound: SoundRule,
  datasetId: string,
  raw: RawValues = {},
): string | null {
  if (!doc?.datasets.some((d) => d.id === datasetId)) return null;
  return JSON.stringify([sound, lineageKey(doc, datasetId), viewKey(doc, datasetId, raw)]);
}

/** Whether the data moves with the calendar: a date range filter it uses is at a relative preset ("last7d"). */
export function followsCalendar(doc: DashboardDoc, datasetId: string, raw: RawValues): boolean {
  const accepted = acceptedRaw(doc, raw);
  return datasetParameters(doc, datasetId).some((id) => {
    const p = doc.parameters?.find((x) => x.id === id);
    if (p?.type !== 'dateRange') return false;
    const text = Object.hasOwn(accepted, id) ? accepted[id]! : defaultText(p);
    return !text.includes('..');
  });
}

const DAY_MS = 86_400_000;
/** A minute after midnight UTC: by then the server resolves a relative period to the new day. */
const ROLLOVER_MS = 60_000;
const CATCH_UP_MS = 60_000;

/**
 * Whether a relative period may still show yesterday's window: its last refetch failed, or its last good result is
 * older than the latest 00:01 UTC. Before that minute yesterday's result is still the current one.
 */
export function behindCalendar(now: number, last: { updatedAt: number; failed: boolean }): boolean {
  return last.failed || last.updatedAt < now - ((now - ROLLOVER_MS) % DAY_MS);
}

/**
 * What `behindCalendar` reads from a dataset's query. A failing upstream arrives as a 200 whose result carries
 * `error`, which query-core counts as a success: it is a failure all the same, or the error would stay up for a day.
 */
export function lastFetch(state: {
  dataUpdatedAt: number;
  status: string;
  data?: { error?: string | undefined } | undefined;
}): { updatedAt: number; failed: boolean } {
  return { updatedAt: state.dataUpdatedAt, failed: state.status === 'error' || Boolean(state.data?.error) };
}

/**
 * The next refetch: the live fallback interval, and for a relative period also the coming 00:01 UTC. Without it a
 * wall screen pinned to "last 7 days" on a dataset that never refreshes would show the old week forever.
 * Query-core asks again on every render and update and restarts its timer, so the delay must aim at the coming
 * boundary (inside the first minute that is today's 00:01, not tomorrow's), and a refetch that failed or has not
 * happened since that boundary is retried every minute instead of a day later.
 */
export function nextRefetch(
  interval: number | false,
  calendar: boolean,
  now: number,
  last?: { updatedAt: number; failed: boolean },
): number | false {
  if (!calendar) return interval;
  const rollover = DAY_MS - ((now - ROLLOVER_MS) % DAY_MS);
  // A regular refresh comes back on its own; only a dataset that never refreshes needs catching up.
  if (interval !== false) return Math.min(interval, rollover);
  return last && behindCalendar(now, last) ? Math.min(CATCH_UP_MS, rollover) : rollover;
}

/** The filters an unsaved draft depends on: its own references and those of the saved datasets it reads. */
export function draftParameterIds(
  doc: DashboardDoc | null,
  draft: Pick<LineageDataset, 'source' | 'transforms'>,
): string[] {
  const own = parameterRefs(draft).map((r) => r.id);
  const upstream = doc ? upstreamOf(draft).flatMap((id) => lineageParameters(doc, id)) : [];
  return [...new Set([...own, ...upstream].filter(Boolean))].sort();
}

/**
 * The view a preview of an unsaved draft sends, and the part of its query key that names it. The server reads the
 * values against the saved declarations, so those are in the key (a new default or a just-saved filter asks again)
 * and only values they accept are sent.
 */
export function draftView(
  saved: DashboardDoc | null,
  doc: DashboardDoc | null,
  draft: Pick<LineageDataset, 'source' | 'transforms'>,
  raw: RawValues,
): { values: Record<string, string>; key: string } {
  const ids = draftParameterIds(doc, draft);
  const values = saved ? pickRaw(acceptedRaw(saved, raw), ids) : {};
  const key = JSON.stringify(
    ids.map((id) => [id, saved?.parameters?.find((p) => p.id === id) ?? null, values[id] ?? null]),
  );
  return { values, key };
}
