/**
 * Identities of dataset results in the web app (proposal 0005). A derived dataset's data changes when anything it
 * reads changes, so keys, the "saved yet?" check and sound baselines all use its lineage, not its own definition.
 */
import { lineageKey as computeLineageKey, type DashboardDoc, type SoundRule } from '@patchbay/core';

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

export const datasetKeyFor = (dashboardId: string, datasetId: string, lineage: string) =>
  ['data', dashboardId, datasetId, lineage] as const;

export const datasetKey = (dashboardId: string, doc: DashboardDoc, datasetId: string) =>
  datasetKeyFor(dashboardId, datasetId, lineageKey(doc, datasetId));

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
  return lineageKey(saved, datasetId) === lineageKey(doc, datasetId);
}

/** How long a result stays fresh, and the polling used only when the live channel is down. */
export function refreshTiming(refreshSec: number, live: boolean) {
  return {
    staleTime: refreshSec > 0 ? refreshSec * 1000 : 5 * 60_000,
    refetchInterval: refreshSec > 0 && !live ? Math.max(refreshSec, 5) * 1000 : (false as const),
  };
}

/** Rule plus lineage: a change of either means the next result is only a baseline (CLAUDE.md). */
export function soundIdentity(
  doc: DashboardDoc | null | undefined,
  sound: SoundRule,
  datasetId: string,
): string | null {
  if (!doc?.datasets.some((d) => d.id === datasetId)) return null;
  return JSON.stringify([sound, lineageKey(doc, datasetId)]);
}
