/**
 * Which datasets of a dashboard read which (proposal 0005): through a `dataset` source and the `with` of join and
 * union steps. Pure functions, shared by validation (`integrityIssues`), the server's resolution and the editor.
 *
 * Only types are imported from the document schema: `schema.ts` imports this module for its limits and checks.
 */
import type { Source } from './schema.ts';
import type { TransformInput } from './transforms.ts';

/** Longest chain of datasets reading datasets. Generous for dashboards; bounds the work one request can cause. */
export const DATASET_DEPTH = 4;
/** Datasets one dataset reads, directly or through others. */
export const DATASET_INPUTS = 8;

export interface LineageDataset {
  id: string;
  source: Source;
  transforms: readonly TransformInput[];
}
export interface LineageDoc<D extends LineageDataset = LineageDataset> {
  readonly datasets: readonly D[];
}

/** The ids of the other datasets the join and union steps read. */
export function stepInputsOf(dataset: Pick<LineageDataset, 'transforms'>): string[] {
  const ids: string[] = [];
  for (const step of dataset.transforms) {
    if (step.type === 'join') ids.push(step.with);
    else if (step.type === 'union') ids.push(...step.with);
  }
  return [...new Set(ids)];
}

/** Everything a dataset reads directly: its source dataset first, then its steps' datasets. */
export function upstreamOf(dataset: Pick<LineageDataset, 'source' | 'transforms'>): string[] {
  const own = dataset.source.kind === 'dataset' ? [dataset.source.id] : [];
  return [...new Set([...own, ...stepInputsOf(dataset)])];
}

/** First definition per id: duplicates are reported by integrityIssues itself. */
function byId<D extends LineageDataset>(doc: LineageDoc<D>): Map<string, D> {
  const map = new Map<string, D>();
  for (const d of doc.datasets) if (!map.has(d.id)) map.set(d.id, d);
  return map;
}

/** Everything `id` reads, directly or not, nearest first; unknown ids and cycles are skipped. */
export function upstreamClosure(doc: LineageDoc, id: string): string[] {
  const map = byId(doc);
  const seen = new Set([id]);
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const d = map.get(queue.shift()!);
    if (!d) continue;
    for (const up of upstreamOf(d)) {
      if (seen.has(up) || !map.has(up)) continue;
      seen.add(up);
      out.push(up);
      queue.push(up);
    }
  }
  return out;
}

export function lineageDatasets<D extends LineageDataset>(doc: LineageDoc<D>, id: string): D[] {
  const map = byId(doc);
  const self = map.get(id);
  return self ? [self, ...upstreamClosure(doc, id).map((x) => map.get(x)!)] : [];
}

export function readersOf(doc: LineageDoc, id: string): string[] {
  return [...byId(doc).values()].filter((d) => d.id !== id && upstreamOf(d).includes(id)).map((d) => d.id);
}

/** Every dataset id, each after the ones it reads; datasets caught in a cycle come last, in document order. */
function topologicalOrder(doc: LineageDoc): string[] {
  const map = byId(doc);
  const ids = [...map.keys()];
  const needs = new Map(ids.map((i) => [i, upstreamOf(map.get(i)!).filter((u) => u !== i && map.has(u))]));
  const placed = new Set<string>();
  const out: string[] = [];
  for (let progress = true; progress; ) {
    progress = false;
    for (const i of ids) {
      if (placed.has(i) || !needs.get(i)!.every((u) => placed.has(u))) continue;
      placed.add(i);
      out.push(i);
      progress = true;
    }
  }
  return [...out, ...ids.filter((i) => !placed.has(i))];
}

export function dependentsOf(doc: LineageDoc, id: string): string[] {
  const readers = new Set(
    doc.datasets.filter((d) => d.id !== id && upstreamClosure(doc, d.id).includes(id)).map((d) => d.id),
  );
  return topologicalOrder(doc).filter((x) => readers.has(x));
}

export function hasLineage(doc: LineageDoc, id: string): boolean {
  const self = byId(doc).get(id);
  return Boolean(self && upstreamOf(self).length) || readersOf(doc, id).length > 0;
}

export function lineageDepth(doc: LineageDoc, id: string): number {
  const map = byId(doc);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (x: string): number => {
    const known = memo.get(x);
    if (known !== undefined) return known;
    const d = map.get(x);
    // Cycles are reported separately; here they only must not recurse forever.
    if (!d || visiting.has(x)) return 0;
    visiting.add(x);
    const ups = upstreamOf(d).filter((u) => u !== x && map.has(u));
    const value = ups.length ? 1 + Math.max(...ups.map(depth)) : 0;
    visiting.delete(x);
    memo.set(x, value);
    return value;
  };
  return depth(id);
}

/** Changes exactly when the dataset or anything it reads changes: "the definition changed" for caches and cues. */
export function lineageKey(doc: LineageDoc, id: string): string {
  return JSON.stringify(lineageDatasets(doc, id));
}

/** How often the dataset's data can change on a timer: the shortest refreshSec in its lineage, 0 when none. */
export function effectiveRefreshSec(
  doc: LineageDoc<LineageDataset & { refreshSec: number }>,
  id: string,
): number {
  const live = lineageDatasets(doc, id)
    .map((d) => d.refreshSec)
    .filter((s) => s > 0);
  return live.length ? Math.min(...live) : 0;
}

export function lineageSecretIds(doc: LineageDoc, id: string): string[] {
  const ids = lineageDatasets(doc, id).flatMap((d) =>
    d.source.kind === 'http' ? (d.source.secrets ?? []) : [],
  );
  return [...new Set(ids)];
}

function findCycles(map: Map<string, LineageDataset>): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const found: string[][] = [];
  const keys = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 'open');
    stack.push(id);
    for (const up of upstreamOf(map.get(id)!)) {
      if (up === id || !map.has(up)) continue;
      if (state.get(up) === 'open') {
        const cycle = [...stack.slice(stack.indexOf(up)), up];
        const key = [...new Set(cycle)].sort().join('|');
        if (!keys.has(key)) {
          keys.add(key);
          found.push(cycle);
        }
      } else if (!state.has(up)) visit(up);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of map.keys()) if (!state.has(id)) visit(id);
  return found;
}

/**
 * Problems of the graph: unknown and self references, cycles, the depth and input limits, and an interval or a
 * history on a derived dataset (two loops on one chain would fetch the same thing twice, and a child could run ahead
 * of its parent).
 */
export function lineageIssues(
  doc: LineageDoc<LineageDataset & { refreshSec: number; accumulate: number }>,
): string[] {
  const map = byId(doc);
  const issues: string[] = [];
  let broken = false;
  for (const d of map.values()) {
    for (const up of upstreamOf(d)) {
      if (up === d.id) {
        issues.push(`Dataset "${d.id}" reads itself`);
        broken = true;
      } else if (!map.has(up)) {
        issues.push(`Dataset "${d.id}" reads unknown dataset "${up}"`);
        broken = true;
      }
    }
    if (d.source.kind === 'dataset') {
      const parent = d.source.id;
      if (d.refreshSec > 0)
        issues.push(
          `Dataset "${d.id}" takes its rows from "${parent}" and refreshes when it does; remove refreshSec.`,
        );
      if (d.accumulate > 0)
        issues.push(
          `Dataset "${d.id}" takes its rows from "${parent}" and keeps no history of its own; set accumulate on "${parent}" instead.`,
        );
    }
  }
  const cycles = findCycles(map);
  for (const c of cycles) issues.push(`Datasets ${c.map((id) => `"${id}"`).join(' → ')} form a cycle`);
  // Depth and fan-in of a broken graph would only repeat the problems above.
  if (broken || cycles.length) return issues;
  for (const d of map.values()) {
    const depth = lineageDepth(doc, d.id);
    if (depth > DATASET_DEPTH)
      issues.push(
        `Dataset "${d.id}" is ${depth} levels deep; chains of derived datasets are limited to ${DATASET_DEPTH}`,
      );
    const inputs = upstreamClosure(doc, d.id).length;
    if (inputs > DATASET_INPUTS)
      issues.push(
        `Dataset "${d.id}" reads ${inputs} other datasets, directly or through others; the limit is ${DATASET_INPUTS}`,
      );
  }
  return issues;
}
