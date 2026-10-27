/**
 * Which colour each series, pie slice or other entity gets. "Colour follows the entity": a colour named for a key
 * (by the widget or the whole dashboard) wins, and the remaining keys share the palette slots nobody claimed, so a
 * mapped colour never shows up on a second entity.
 */
import type { ChartConfig } from './schema.ts';
import type { Scalar } from './table.ts';
import { type ChartTheme, type Color, MAX_SERIES, resolveColor } from './theme.ts';

export type ColorMap = Record<string, Color>;

export interface SeriesColorOptions {
  /** Dashboard-wide entity colours (`doc.colors`), consulted after the widget's own map. */
  entityColors?: ColorMap | undefined;
  /** The key that stands for folded keys ("Other"); it is muted, since it is not an entity. */
  other?: string | undefined;
}

/** The first band whose upTo is >= the value; above the last band there is none (uncoloured). */
export function bandFor<B extends { upTo: number }>(
  bands: readonly B[] | undefined,
  value: Scalar,
): B | null {
  if (!bands?.length || typeof value !== 'number' || !Number.isFinite(value)) return null;
  return bands.find((b) => value <= b.upTo) ?? null;
}

/** The categorical slot a colour occupies in this theme, or -1. */
function paletteSlot(color: Color, theme: ChartTheme): number {
  const accent = /^accent-([1-8])$/.exec(color);
  if (accent) return Number(accent[1]) - 1;
  return theme.categorical.findIndex((c) => c.toLowerCase() === color.toLowerCase());
}

/** The colour named for a key by the widget's map or the dashboard's, if any. */
export function mappedColor(
  key: string,
  colors: ChartConfig['colors'],
  entityColors?: ColorMap,
): Color | undefined {
  if (colors && !Array.isArray(colors) && Object.hasOwn(colors, key)) return colors[key];
  if (entityColors && Object.hasOwn(entityColors, key)) return entityColors[key];
  return undefined;
}

/**
 * Mark colours for `keys`, which arrive in automatic order (series values sorted, y columns as configured).
 * The array form of `colors` keeps its original meaning, a palette cycled in series order, so documents written
 * before colour maps existed render exactly as they did.
 */
export function seriesColors(
  keys: readonly string[],
  colors: ChartConfig['colors'],
  theme: ChartTheme,
  opts: SeriesColorOptions = {},
): string[] {
  const palette =
    Array.isArray(colors) && colors.length ? colors.map((c) => resolveColor(c, theme, 'mark')) : null;
  const explicit = keys.map((k) =>
    k === opts.other ? undefined : mappedColor(k, colors, opts.entityColors),
  );
  const taken = new Set(explicit.flatMap((c) => (c ? [paletteSlot(c, theme)] : [])));
  const free = theme.categorical.map((_, i) => i).filter((i) => !taken.has(i));
  let auto = 0;
  return keys.map((key, idx) => {
    const named = explicit[idx];
    if (named) return resolveColor(named, theme, 'mark');
    if (key === opts.other || idx >= MAX_SERIES) return theme.muted;
    if (palette) return palette[idx % palette.length]!;
    // Once every slot is claimed, more hues would be unvalidated pairs: the rest stay muted.
    const slot = free[auto++];
    return slot === undefined ? theme.muted : theme.categorical[slot]!;
  });
}
