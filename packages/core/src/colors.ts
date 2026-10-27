/**
 * Which colour each series, pie slice or other entity gets. "Colour follows the entity": a colour named for a key
 * (by the widget or the whole dashboard) wins, and the remaining keys share the palette slots nobody claimed, so a
 * mapped colour never shows up on a second entity.
 */
import type { ChartConfig, DashboardDoc, Widget } from './schema.ts';
import type { Scalar } from './table.ts';
import {
  type ChartTheme,
  type Color,
  contrastRatio,
  isHexColor,
  MARK_CONTRAST,
  MAX_SERIES,
  resolveColor,
  THEMES,
} from './theme.ts';

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

/** Every colour a widget sets, with where it is set, for the checks below. */
function widgetColors(widget: Widget): { where: string; color: Color }[] {
  const out: { where: string; color: Color }[] = [];
  const bands = (where: string, list: readonly { color: Color }[] | undefined) => {
    for (const b of list ?? []) out.push({ where, color: b.color });
  };
  switch (widget.type) {
    case 'chart': {
      const c = widget.config.colors;
      if (Array.isArray(c)) for (const color of c) out.push({ where: 'colors', color });
      else if (c) for (const [key, color] of Object.entries(c)) out.push({ where: `colors "${key}"`, color });
      widget.config.referenceLines?.forEach((l, i) => {
        if (l.color) out.push({ where: `reference line ${i + 1}`, color: l.color });
      });
      break;
    }
    case 'kpi':
    case 'gauge':
      bands('bands', widget.config.bands);
      break;
    case 'table':
      for (const col of widget.config.columns ?? [])
        if (typeof col !== 'string') bands(`column "${col.field}" bands`, col.bands);
      widget.config.rules?.forEach((r, i) => {
        out.push({ where: `rule ${i + 1}`, color: r.color });
      });
      break;
    default:
      break;
  }
  return out;
}

const ratio = (n: number) => n.toFixed(1);

function contrastWarnings(subject: string, colors: { where: string; color: Color }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { where, color } of colors) {
    if (!isHexColor(color) || seen.has(color.toLowerCase())) continue;
    seen.add(color.toLowerCase());
    const light = contrastRatio(color, THEMES.light.surface);
    const dark = contrastRatio(color, THEMES.dark.surface);
    if (Math.min(light, dark) >= MARK_CONTRAST) continue;
    out.push(
      `${subject}: ${where} ${color} has ${ratio(light)}:1 contrast in light and ${ratio(dark)}:1 in dark mode, below ${MARK_CONTRAST}:1 (hard to see). Named colours adapt to dark mode; prefer one.`,
    );
  }
  return out;
}

/** Two entities with one colour defeat the map's purpose: a reader cannot tell them apart. */
function duplicateWarnings(subject: string, map: ColorMap | undefined): string[] {
  if (!map) return [];
  // Keyed by the clashing entities, so a clash in both themes is reported once.
  const out = new Map<string, string>();
  for (const mode of ['light', 'dark'] as const) {
    const byColor = new Map<string, string[]>();
    for (const [key, color] of Object.entries(map)) {
      const hex = resolveColor(color, THEMES[mode], 'mark').toLowerCase();
      byColor.set(hex, [...(byColor.get(hex) ?? []), key]);
    }
    for (const [hex, keys] of byColor) {
      const names = keys.map((k) => `"${k}"`).join(', ');
      if (keys.length > 1 && !out.has(names))
        out.set(
          names,
          `${subject}: ${names} get the same colour (${hex} in ${mode} mode); give each entity its own.`,
        );
    }
  }
  return [...out.values()];
}

/**
 * Advice for colours and axes that are valid but hurt the reader, for `apply_operations` warnings. Only the
 * widgets a batch touched are checked (and the dashboard map when it changed), so old choices do not nag on every
 * call; hex stays a warning, never an error, because existing documents and brand colours use it.
 */
export function formattingWarnings(
  doc: DashboardDoc,
  touched: { widgets: ReadonlySet<string>; colors: boolean },
): string[] {
  const out: string[] = [];
  if (touched.colors && doc.colors) {
    const subject = 'Dashboard colors';
    const entries = Object.entries(doc.colors).map(([key, color]) => ({ where: `"${key}"`, color }));
    out.push(...contrastWarnings(subject, entries), ...duplicateWarnings(subject, doc.colors));
  }
  for (const widget of doc.widgets) {
    if (!touched.widgets.has(widget.id)) continue;
    const subject = `Widget "${widget.id}"`;
    out.push(...contrastWarnings(subject, widgetColors(widget)));
    if (widget.type !== 'chart') continue;
    const c = widget.config;
    if (c.colors && !Array.isArray(c.colors)) out.push(...duplicateWarnings(subject, c.colors));
    const bars = c.kind === 'bar' || (c.kind === 'area' && c.stacked);
    if (bars && c.yMin !== undefined && c.yMin > 0 && !c.logScale) {
      out.push(
        `${subject}: ${c.kind === 'bar' ? 'bars' : 'stacked areas'} should start at zero, or their lengths exaggerate differences (yMin is ${c.yMin}). To show a benchmark, add a reference line (referenceLines) instead.`,
      );
    }
  }
  return out;
}
