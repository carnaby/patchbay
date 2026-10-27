/**
 * Grid layout helpers. There is exactly one placement algorithm and it lives
 * here, so a widget added by an agent over MCP lands in the same spot it would
 * if a human added it in the editor.
 */
import { GRID_COLUMNS, type LayoutItem, type WidgetType } from './schema.ts';

export const SIZE_HINTS: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  chart: { w: 6, h: 4 },
  table: { w: 6, h: 5 },
  map: { w: 6, h: 5 },
  text: { w: 4, h: 2 },
};

const overlaps = (a: Omit<LayoutItem, 'i'>, b: Omit<LayoutItem, 'i'>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Finds the first free top-left position (row-major scan) for a w x h box. */
export function findSlot(layout: LayoutItem[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(Math.max(1, w), GRID_COLUMNS);
  const bottom = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w: width, h };
      if (!layout.some((it) => overlaps(it, candidate))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

export function placeItem(
  layout: LayoutItem[],
  id: string,
  type: WidgetType,
  size?: Partial<Pick<LayoutItem, 'x' | 'y' | 'w' | 'h'>>,
): LayoutItem {
  const hint = SIZE_HINTS[type];
  const w = Math.min(size?.w ?? hint.w, GRID_COLUMNS);
  const h = size?.h ?? hint.h;
  if (size?.x !== undefined && size?.y !== undefined) {
    const x = Math.min(size.x, GRID_COLUMNS - w);
    const wanted = { i: id, x, y: size.y, w, h };
    if (!layout.some((it) => overlaps(it, wanted))) return wanted;
  }
  return { i: id, w, h, ...findSlot(layout, w, h) };
}

/** Pulls every item up as far as it can go without overlapping (vertical compaction). */
export function compact(layout: LayoutItem[]): LayoutItem[] {
  const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: LayoutItem[] = [];
  for (const item of sorted) {
    let y = item.y;
    while (y > 0 && !placed.some((p) => overlaps(p, { ...item, y: y - 1 }))) y--;
    while (placed.some((p) => overlaps(p, { ...item, y }))) y++;
    placed.push({ ...item, y });
  }
  const order = new Map(layout.map((it, idx) => [it.i, idx]));
  return placed.sort((a, b) => order.get(a.i)! - order.get(b.i)!);
}

/**
 * Makes a layout consistent with a widget list: drops orphans and duplicates,
 * clamps to the grid, resolves overlaps and appends missing widgets.
 */
export function normalizeLayout(
  layout: LayoutItem[],
  widgets: { id: string; type: WidgetType }[],
): LayoutItem[] {
  const ids = new Set(widgets.map((w) => w.id));
  const seen = new Set<string>();
  const kept: LayoutItem[] = [];
  for (const raw of layout) {
    if (!ids.has(raw.i) || seen.has(raw.i)) continue;
    seen.add(raw.i);
    const w = Math.min(Math.max(raw.w, 1), GRID_COLUMNS);
    kept.push({ ...raw, w, x: Math.min(Math.max(raw.x, 0), GRID_COLUMNS - w), h: Math.max(raw.h, 1) });
  }
  let result = compact(kept);
  for (const widget of widgets) {
    if (!seen.has(widget.id)) result = [...result, placeItem(result, widget.id, widget.type)];
  }
  return result;
}

/** Reading order used for the single-column mobile layout and for accessibility. */
export function readingOrder(layout: LayoutItem[]): string[] {
  return [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.i);
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Where a box at (x, y) comes to rest once vertical compaction pulls it up. */
function settle(placed: LayoutItem[], box: Omit<LayoutItem, 'i'>): number {
  let y = box.y;
  while (y > 0 && !placed.some((p) => overlaps(p, { ...box, y: y - 1 }))) y--;
  return y;
}

/**
 * Places `ids` one after another so their reading order is exactly the given order, even after compaction:
 * each widget takes the first free slot (scanning from just right of the previous one) whose resting place
 * still comes after the previous widget, starting with `after`.
 */
function flow(
  fixed: LayoutItem[],
  ids: string[],
  byId: Map<string, LayoutItem>,
  start: { x: number; y: number },
  after: LayoutItem | null,
): LayoutItem[] {
  const placed = [...fixed];
  let cursor = start;
  let last = after;
  for (const id of ids) {
    const item = byId.get(id)!;
    const w = Math.min(item.w, GRID_COLUMNS);
    const bottom = placed.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    let slot = { x: 0, y: bottom };
    // Below everything, a slot under the previous widget always qualifies, so the scan ends by `bottom`.
    search: for (let y = cursor.y; y <= bottom; y++) {
      for (let x = y === cursor.y ? cursor.x : 0; x + w <= GRID_COLUMNS; x++) {
        const box = { x, y, w, h: item.h };
        if (placed.some((p) => overlaps(p, box))) continue;
        const rest = settle(placed, box);
        if (last && (rest < last.y || (rest === last.y && x <= last.x))) continue;
        slot = { x, y: rest };
        break search;
      }
    }
    const next = { ...item, w, ...slot };
    placed.push(next);
    last = next;
    cursor = { x: slot.x + w, y: slot.y };
  }
  return placed;
}

/**
 * Moves a widget in reading order (the order widgets stack in on small screens) so it comes just before
 * `before`, or last when `before` is null. Sizes never change.
 *
 * The widgets between the old and the new place trade slots: the n-th of them in the new order takes the
 * top-left corner the n-th had before, and nothing outside that range moves. For widgets of the same size
 * (rows of KPI tiles) this is an exact swap or shift, which is what someone looking at the desktop grid expects.
 * When sizes differ, compaction can push widgets around until the order comes out wrong; then the range is
 * flowed in the new order around the untouched widgets, and failing that everything from the first moved
 * widget onwards. Widgets before the change never move. The result always has the requested reading order and
 * is already compacted, so `normalizeLayout` leaves it as it is.
 */
export function reorderLayout(layout: LayoutItem[], id: string, before: string | null): LayoutItem[] {
  const order = readingOrder(layout);
  if (!order.includes(id) || id === before) return layout;
  const without = order.filter((i) => i !== id);
  const at = before === null ? without.length : without.indexOf(before);
  if (at < 0) return layout;
  const wanted = [...without.slice(0, at), id, ...without.slice(at)];
  if (sameOrder(order, wanted)) return layout;

  const byId = new Map(layout.map((it) => [it.i, it]));
  let lo = 0;
  while (order[lo] === wanted[lo]) lo++;
  let hi = order.length - 1;
  while (order[hi] === wanted[hi]) hi--;
  const range = wanted.slice(lo, hi + 1);
  const rangeIds = new Set(range);
  const outside = layout.filter((it) => !rangeIds.has(it.i));
  const prefix = compact(order.slice(0, lo).map((i) => byId.get(i)!));
  const start = byId.get(order[lo]!)!;
  const previous = prefix.at(-1) ?? null;

  const candidates: (() => LayoutItem[])[] = [
    () =>
      outside.concat(
        range.map((rid, n) => {
          const item = byId.get(rid)!;
          const slot = byId.get(order[lo + n]!)!;
          return { ...item, x: Math.min(slot.x, GRID_COLUMNS - item.w), y: slot.y };
        }),
      ),
    () => flow(outside, range, byId, start, previous),
    // Everything placed here rests after the compacted prefix, so compaction cannot reorder it.
    () => flow(prefix, wanted.slice(lo), byId, start, previous),
  ];
  for (const candidate of candidates) {
    const result = compact(candidate());
    if (sameOrder(readingOrder(result), wanted)) return restoreOrder(result, layout);
  }
  // Unreachable given the last candidate; a single column keeps the promise if that reasoning is ever wrong.
  let y = 0;
  const stacked = wanted.map((i) => {
    const item = { ...byId.get(i)!, x: 0, y };
    y += item.h;
    return item;
  });
  return restoreOrder(stacked, layout);
}

/** Keeps the array order of the input, so a reorder only shows up in the diff as changed coordinates. */
function restoreOrder(result: LayoutItem[], original: LayoutItem[]): LayoutItem[] {
  const index = new Map(original.map((it, n) => [it.i, n]));
  return [...result].sort((a, b) => index.get(a.i)! - index.get(b.i)!);
}
