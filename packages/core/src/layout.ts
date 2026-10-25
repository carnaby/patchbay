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
