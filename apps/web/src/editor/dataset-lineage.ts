/** Editor helpers for datasets that read other datasets (proposal 0005). Plain TypeScript so they can be tested. */
import {
  type DashboardDoc,
  type Dataset,
  dependentsOf,
  lineageDatasets,
  lineageSecretIds,
  readersOf,
} from '@patchbay/core';

export const formatInterval = (sec: number) =>
  sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 360) / 10} h`;

export function slug(text: string, taken: Set<string>) {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'data';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const nameOf = (doc: DashboardDoc, id: string) => doc.datasets.find((d) => d.id === id)?.name ?? id;
/** "A", "A and B", "A, B and C". */
const listed = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Datasets a draft may read: all but itself and those built on it, which would close a cycle. */
export function sourceCandidates(doc: DashboardDoc, editingId: string | null): Dataset[] {
  if (!editingId) return [...doc.datasets];
  const excluded = new Set([editingId, ...dependentsOf(doc, editingId)]);
  return doc.datasets.filter((d) => !excluded.has(d.id));
}

/** Why a dataset cannot be deleted yet, for the disabled button's tooltip; null when it can. */
export function deleteBlocker(doc: DashboardDoc, id: string): string | null {
  const readers = readersOf(doc, id);
  return readers.length
    ? `Used by ${readers.map((r) => nameOf(doc, r)).join(', ')}. Delete or re-point those first.`
    : null;
}

const hasSecrets = (d: Dataset) => d.source.kind === 'http' && (d.source.secrets?.length ?? 0) > 0;

/** The lock icon's tooltip: a derived dataset names the datasets whose secrets it reads through. */
export function secretsTooltip(doc: DashboardDoc, id: string): string | null {
  if (lineageSecretIds(doc, id).length === 0) return null;
  const [self, ...upstream] = lineageDatasets(doc, id);
  if (self && hasSecrets(self)) return 'Uses secrets';
  return `Uses secrets via ${listed(upstream.filter(hasSecrets).map((d) => d.name))}`;
}

/** What replaces the interval fields of a derived dataset: it refreshes when what it reads refreshes. */
export function refreshLine(doc: DashboardDoc, sourceId: string): string {
  const live = lineageDatasets(doc, sourceId).filter((d) => d.refreshSec > 0);
  if (live.length === 0) return 'Loads once';
  return `Refreshes with ${listed(live.map((d) => `${d.name} (every ${formatInterval(d.refreshSec)})`))}`;
}

/** "New dataset from this one": the one-click answer to "copy the dataset and add a step". */
export function derivedDraft(doc: DashboardDoc, parentId: string): Dataset {
  const name = nameOf(doc, parentId);
  return {
    id: slug(`${name} derived`, new Set(doc.datasets.map((d) => d.id))),
    name: `${name} (derived)`.slice(0, 120),
    source: { kind: 'dataset', id: parentId },
    transforms: [],
    refreshSec: 0,
    accumulate: 0,
  };
}
