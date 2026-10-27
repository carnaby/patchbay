/**
 * Turns a map widget config + a data table into an ECharts option object drawn on the `geo` component.
 *
 * Pure like `buildChartOption`, and used by the browser and the snapshot renderer alike. The base map is referenced
 * by name (`WORLD_MAP`) and registered by those two callers: importing the geo data here would put it into every
 * bundle that uses core, map or not. For the same reason this module is its own entry (`@patchbay/core/map`) rather
 * than part of the index: a bundler places a module by who imports it, so through the index it would ride along
 * with every page instead of the browser's lazily loaded map chunk.
 */

import { type ChartBuildOptions, OTHER, seriesKeys } from './chart.ts';
import { mappedColor, seriesColors } from './colors.ts';
import { formatNumber, formatTime } from './format.ts';
import type { MapConfig } from './schema.ts';
import { nightPolygon } from './solar.ts';

export { nightPolygon, subsolarPoint } from './solar.ts';

import type { DataTable, Row, Scalar } from './table.ts';
import type { ChartTheme } from './theme.ts';

type Option = Record<string, unknown>;
type Point = [number, number];

/** The name both callers register the bundled Natural Earth countries under. */
export const WORLD_MAP = 'pb-world';
/** The `world` view: little data lives under the Antarctic coastline, and leaving it out saves a third of the height. */
export const WORLD_VIEW = { lonMin: -180, lonMax: 180, latMin: -60, latMax: 84 } as const;
/** `fit` never zooms in further than this, so a single point does not end up at street level. */
const MIN_SPAN = { lon: 30, lat: 15 };
const SIZE_RANGE = { min: 4, max: 24 };
/** Over this many plain dots ECharts' large mode draws them in one pass. */
const LARGE = 2000;
// Unquoted: graphic text lands in an SVG style attribute in snapshots, where double quotes would end it.
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

/** ECharts tooltips are HTML in the browser, and every label comes from upstream data. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

const isLat = (v: Scalar | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 90;
const isLon = (v: Scalar | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180;

/**
 * The rows a map draws, in table order: the newest `maxPoints` (as charts keep them), minus rows whose coordinates
 * are missing or out of range. `skipped` counts those, so a wrong column choice shows up in the description.
 */
export function mapRows(config: MapConfig, table: DataTable): { rows: Row[]; skipped: number } {
  const recent = table.rows.length > config.maxPoints ? table.rows.slice(-config.maxPoints) : table.rows;
  const rows = recent.filter((r) => isLat(r[config.lat]) && isLon(r[config.lon]));
  return { rows, skipped: recent.length - rows.length };
}

/**
 * Splits a track wherever it crosses the antimeridian, so it is not drawn as a line across the whole map: the
 * crossing latitude is interpolated, one segment ends at ±180° and the next starts at ∓180°. Two consecutive
 * positions more than 180° of longitude apart are taken to have crossed it, which holds for any track sampled more
 * often than every half revolution.
 */
export function trackSegments(points: readonly Point[]): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  const push = (p: Point) => {
    const last = current[current.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) current.push(p);
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 180) {
      const east = p[0] < prev[0];
      const edge = east ? 180 : -180;
      const unwrapped = p[0] + (east ? 360 : -360);
      const t = unwrapped === prev[0] ? 0 : (edge - prev[0]) / (unwrapped - prev[0]);
      const lat = prev[1] + t * (p[1] - prev[1]);
      push([edge, lat]);
      segments.push(current);
      current = [[-edge, lat]];
    }
    push(p);
  }
  segments.push(current);
  return segments.filter((s) => s.length > 1);
}

/**
 * The time the night shading is drawn for: the newest value of the table's first time column, else when the result
 * was fetched. Never the clock, so a snapshot and a live screen of the same data agree.
 */
export function mapTime(table: DataTable, fetchedAt?: string): number | undefined {
  const time = table.columns.find((c) => c.type === 'time');
  if (time) {
    let newest = Number.NEGATIVE_INFINITY;
    for (const r of table.rows) {
      const v = r[time.name];
      if (typeof v === 'number' && v > newest) newest = v;
    }
    if (Number.isFinite(newest)) return newest;
  }
  const fetched = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  return Number.isFinite(fetched) ? fetched : undefined;
}

const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const degrees = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(1)}°${v < 0 ? neg : pos}`;
export const formatCoords = (lat: number, lon: number) =>
  `${degrees(lat, 'N', 'S')}, ${degrees(lon, 'E', 'W')}`;

/** Columns of the table alternative, in the order a reader needs them. */
export function mapTableColumns(config: MapConfig, table: DataTable): string[] {
  const time = config.mode === 'track' ? table.columns.find((c) => c.type === 'time')?.name : undefined;
  const all = [config.label, time, config.lat, config.lon, config.series, config.size, config.color];
  return [...new Set(all.filter((c): c is string => Boolean(c)))];
}

/** One sentence for screen readers and the snapshot's caller, e.g. "Map of 312 points between 62°S and 71°N". */
export function describeMap(config: MapConfig, table: DataTable, at?: number): string {
  const { rows, skipped } = mapRows(config, table);
  const parts: string[] = [];
  if (rows.length === 0) parts.push('Map with no points');
  else if (config.mode === 'track') {
    const last = rows[rows.length - 1]!;
    const time = table.columns.find((c) => c.type === 'time')?.name;
    const when = time && typeof last[time] === 'number' ? ` at ${clock(last[time] as number)}` : '';
    const tracks = config.series ? new Set(rows.map((r) => String(r[config.series!] ?? ''))).size : 1;
    parts.push(
      `${tracks > 1 ? `${tracks} tracks` : 'Track'} of ${rows.length} position${rows.length === 1 ? '' : 's'}; latest ${formatCoords(last[config.lat] as number, last[config.lon] as number)}${when}`,
    );
  } else {
    const lats = rows.map((r) => r[config.lat] as number);
    const extras = [
      config.size ? `sized by ${config.size}` : '',
      config.color ? `coloured by ${config.color}` : '',
      config.series ? `one colour per ${config.series}` : '',
    ].filter(Boolean);
    parts.push(
      `Map of ${rows.length} point${rows.length === 1 ? '' : 's'} between ${degrees(Math.min(...lats), 'N', 'S')} and ${degrees(Math.max(...lats), 'N', 'S')}${extras.length ? `, ${extras.join(', ')}` : ''}`,
    );
  }
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'row' : 'rows'} without coordinates left out`);
  if (config.terminator && at !== undefined) parts.push(`Night shading for ${clock(at)}`);
  return `${parts.join('. ')}.`;
}

/** [[west, north], [east, south]], as ECharts' `boundingCoords` wants them. */
export function mapBounds(config: MapConfig, points: readonly Point[]): [Point, Point] {
  const world: [Point, Point] = [
    [WORLD_VIEW.lonMin, WORLD_VIEW.latMax],
    [WORLD_VIEW.lonMax, WORLD_VIEW.latMin],
  ];
  if (config.view === 'world' || points.length === 0) return world;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  // 10 % padding on each side, but never less than the minimum span, and never more than the world.
  const span = (lo: number, hi: number, min: number, max: number) =>
    Math.min(max, Math.max((hi - lo) * 1.2, min));
  const fit = (lo: number, hi: number, size: number, limit: number): [number, number] => {
    let from = (lo + hi) / 2 - size / 2;
    from = Math.min(Math.max(from, -limit), limit - size);
    return [from, from + size];
  };
  const [w, e] = fit(west, east, span(west, east, MIN_SPAN.lon, 360), 180);
  const [s, n] = fit(south, north, span(south, north, MIN_SPAN.lat, 180), 90);
  return [
    [w, n],
    [e, s],
  ];
}

/** "#rrggbb" at the given opacity. */
const translucent = (hex: string, alpha: number) =>
  `rgba(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(',')},${alpha})`;

function emptyOption(theme: ChartTheme, message: string): Option {
  return {
    backgroundColor: 'transparent',
    title: {
      text: message,
      left: 'center',
      top: 'middle',
      textStyle: { color: theme.muted, fontSize: 13, fontWeight: 'normal' },
    },
  };
}

function numericRange(rows: Row[], field: string): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Dot diameter whose area grows linearly with the value, from 4 px at the minimum to 24 px at the maximum. */
function dotSize(value: Scalar | undefined, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIZE_RANGE.min;
  const t = range.max === range.min ? 0.5 : (value - range.min) / (range.max - range.min);
  const a = SIZE_RANGE.min ** 2;
  const b = SIZE_RANGE.max ** 2;
  return Math.sqrt(a + (b - a) * Math.min(1, Math.max(0, t)));
}

export function buildMapOption(
  config: MapConfig,
  table: DataTable,
  theme: ChartTheme,
  opts: ChartBuildOptions & { at?: number } = {},
): Option {
  const wanted = [config.lat, config.lon, config.series, config.size, config.color, config.label].filter(
    (f): f is string => Boolean(f),
  );
  const missing = wanted.filter((f) => !table.columns.some((c) => c.name === f));
  if (missing.length) return emptyOption(theme, `Missing column: ${missing.join(', ')}`);

  const { rows } = mapRows(config, table);
  const at = opts.at ?? mapTime(table);
  const types = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
  const timeField = table.columns.find((c) => c.type === 'time')?.name;
  const fmt = (v: Scalar | undefined) =>
    typeof v === 'number' ? formatNumber(v, config.format) : String(v ?? '-');
  const night = config.terminator && at !== undefined ? `Night shading for ${clock(at)}` : '';
  const sizeRange = config.size ? numericRange(rows, config.size) : null;
  const colorRange = config.color && !config.series ? numericRange(rows, config.color) : null;

  const tip = (row: Row) => {
    const lines: string[] = [];
    if (config.label) lines.push(`<b>${escapeHtml(String(row[config.label] ?? '-'))}</b>`);
    if (config.series) lines.push(escapeHtml(String(row[config.series] ?? '(empty)')));
    lines.push(formatCoords(row[config.lat] as number, row[config.lon] as number));
    if (timeField && typeof row[timeField] === 'number' && types[timeField] === 'time')
      lines.push(escapeHtml(formatTime(row[timeField] as number)));
    for (const f of [config.size, config.color]) {
      if (f) lines.push(`${escapeHtml(f)}: ${escapeHtml(fmt(row[f]))}`);
    }
    if (night) lines.push(night);
    return lines.join('<br/>');
  };

  // Group rows by entity exactly as charts split series, and colour them the same way: the widget's colour map,
  // then the dashboard's, then the palette slots left free. An entity keeps its colour on charts and maps alike.
  const named = (k: string) => mappedColor(k, config.colors, opts.entityColors) !== undefined;
  const { keys, folded } = config.series
    ? seriesKeys(
        rows.map((r) => r[config.series!] ?? null),
        named,
      )
    : { keys: [''], folded: false };
  const keySet = new Set(keys);
  const groupOf = (row: Row) => {
    if (!config.series) return '';
    const raw =
      row[config.series] === null || row[config.series] === undefined
        ? '(empty)'
        : String(row[config.series]);
    return keySet.has(raw) ? raw : folded ? OTHER : raw;
  };
  const palette = seriesColors(keys, config.colors, theme, {
    entityColors: opts.entityColors,
    other: folded ? OTHER : undefined,
  });
  const colorOf = (key: string) => palette[keys.indexOf(key)] ?? theme.muted;

  const series: Option[] = [];
  // Tooltip texts per series and data index, built with the data so they stay in the same order.
  const tips: string[][] = [];

  if (config.terminator && at !== undefined) {
    const ring = nightPolygon(at);
    series.push({
      id: 'night',
      type: 'custom',
      coordinateSystem: 'geo',
      silent: true,
      z: 1,
      data: [[0, 0]],
      renderItem: (_params: unknown, api: { coord: (p: Point) => number[] }) => ({
        type: 'polygon',
        shape: { points: ring.map((p) => api.coord(p)) },
        style: { fill: theme.mode === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.35)' },
      }),
      tooltip: { show: false },
    });
  }

  const dots = config.mode === 'points' || config.size || config.color;
  for (const key of keys) {
    const groupRows = rows.filter((r) => groupOf(r) === key);
    const color = colorOf(key);
    if (dots) {
      // Big dots first, so they do not hide the small ones drawn on top of them.
      const ordered = sizeRange
        ? [...groupRows].sort(
            (a, b) => dotSize(b[config.size!], sizeRange) - dotSize(a[config.size!], sizeRange),
          )
        : groupRows;
      const id = `points:${key}`;
      tips[series.length] = ordered.map(tip);
      const plain = !sizeRange && !colorRange;
      series.push({
        id,
        name: key,
        type: 'scatter',
        coordinateSystem: 'geo',
        z: 3,
        large: plain && ordered.length > LARGE,
        symbolSize: sizeRange ? undefined : config.mode === 'track' ? 5 : 7,
        itemStyle: {
          color: colorRange ? theme.muted : color,
          borderColor: theme.surface,
          borderWidth: plain && ordered.length > LARGE ? 0 : 1,
          opacity: 0.85,
        },
        emphasis: { scale: 1.4 },
        data: ordered.map((r) => {
          const c = config.color ? r[config.color] : null;
          const value = [r[config.lon], r[config.lat], typeof c === 'number' ? c : '-'];
          return sizeRange ? { value, symbolSize: dotSize(r[config.size!], sizeRange) } : value;
        }),
      });
    }
    if (config.mode === 'track') {
      // Several entities folded into "Other" are still separate tracks, one polyline each.
      const byEntity = new Map<string, Row[]>();
      for (const r of groupRows) {
        const entity = config.series ? String(r[config.series] ?? '') : '';
        const list = byEntity.get(entity) ?? [];
        list.push(r);
        byEntity.set(entity, list);
      }
      const lines = [...byEntity.values()].flatMap((list) =>
        trackSegments(list.map((r) => [r[config.lon] as number, r[config.lat] as number])),
      );
      series.push({
        id: `track:${key}`,
        name: key,
        type: 'lines',
        coordinateSystem: 'geo',
        polyline: true,
        silent: true,
        z: 2,
        lineStyle: { color, width: 2, opacity: 0.9, cap: 'round', join: 'round' },
        data: lines.map((coords) => ({ coords })),
      });
      const newest = [...byEntity.values()].map((list) => list[list.length - 1]!);
      // Each newest position twice: a ring around it, then the dot on top, so it reads as "here now".
      tips[series.length] = newest.flatMap((r) => [tip(r), tip(r)]);
      series.push({
        id: `latest:${key}`,
        name: key,
        type: 'scatter',
        coordinateSystem: 'geo',
        z: 4,
        data: newest.flatMap((r) => [
          {
            value: [r[config.lon], r[config.lat]],
            symbolSize: 20,
            itemStyle: { color: 'transparent', borderColor: color, borderWidth: 1.5, opacity: 0.7 },
          },
          {
            value: [r[config.lon], r[config.lat]],
            symbolSize: 10,
            itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
          },
        ]),
      });
    }
  }

  const points = rows.map((r): Point => [r[config.lon] as number, r[config.lat] as number]);
  const [northWest, southEast] = mapBounds(config, points);
  const showLegend = Boolean(config.series);
  const bottomLegend = Boolean(sizeRange || colorRange);
  const muted = { fill: theme.muted, fontSize: 11, fontFamily: FONT };

  const graphic: Option[] = [];
  if (night) {
    // Spare room on the right: the snapshot renderer estimates text widths, and Inter runs wider than the estimate.
    graphic.push({
      id: 'night-caption',
      type: 'text',
      right: 12,
      top: 4,
      z: 10,
      style: { ...muted, text: night },
    });
  }
  if (sizeRange && config.size) {
    // A size legend of its own: colour is never the only carrier, and dot areas need a key to be read.
    const steps =
      sizeRange.max === sizeRange.min
        ? [sizeRange.min]
        : [sizeRange.min, (sizeRange.min + sizeRange.max) / 2, sizeRange.max];
    // Every element gets its own z: a group's z does not carry over to its children, and land would cover them.
    const children: Option[] = [{ type: 'text', x: 0, y: 6, z: 11, style: { ...muted, text: config.size } }];
    let x = config.size.length * 6.5 + 8;
    for (const v of steps) {
      const d = dotSize(v, sizeRange);
      const label = fmt(v);
      children.push({
        type: 'circle',
        z: 11,
        shape: { cx: x + d / 2, cy: 12, r: d / 2 },
        // Neutral when colour carries something else, so the key does not read as one of the groups.
        style: {
          fill: config.series || colorRange ? theme.muted : theme.categorical[0],
          opacity: 0.85,
          stroke: theme.surface,
          lineWidth: 1,
        },
      });
      children.push({ type: 'text', x: x + d + 4, y: 6, z: 11, style: { ...muted, text: label } });
      x += d + 4 + label.length * 6.5 + 10;
    }
    // A backing in the card colour keeps the key readable where the map runs underneath it.
    children.unshift({
      type: 'rect',
      z: 10,
      shape: { x: -4, y: -1, width: x - 4, height: 26, r: 4 },
      style: { fill: translucent(theme.surface, 0.85) },
    });
    graphic.push({ id: 'size-legend', type: 'group', left: 2, bottom: 2, children });
  }

  const option: Option = {
    animation: opts.animation ?? true,
    animationDuration: 300,
    animationDurationUpdate: 300,
    backgroundColor: 'transparent',
    color: theme.categorical,
    textStyle: { fontFamily: FONT, color: theme.textSecondary },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.axis,
      textStyle: { color: theme.textPrimary },
      formatter: (p: { seriesIndex: number; dataIndex: number }) => tips[p.seriesIndex]?.[p.dataIndex] ?? '',
    },
    legend: showLegend
      ? {
          show: true,
          top: 0,
          left: 0,
          right: night ? 170 : 0,
          type: 'scroll',
          icon: 'roundRect',
          itemWidth: 10,
          itemHeight: 10,
          data: keys,
          textStyle: { color: theme.textSecondary },
        }
      : { show: false },
    geo: {
      map: WORLD_MAP,
      nameProperty: 'iso_a3',
      roam: false,
      silent: true,
      // Equirectangular: longitude and latitude are linear, the classic ground-track look.
      aspectScale: 1,
      boundingCoords: [northWest, southEast],
      // Without it a box given by all four margins stretches the map to the card's shape.
      preserveAspect: 'contain',
      left: 4,
      right: 4,
      top: showLegend || night ? 26 : 4,
      bottom: bottomLegend ? 30 : 4,
      label: { show: false },
      itemStyle: {
        areaColor: config.basemap === 'none' ? 'transparent' : theme.grid,
        // Land-only draws the borders in the land colour, which also hides the seams between countries.
        borderColor:
          config.basemap === 'countries'
            ? theme.surface
            : config.basemap === 'land'
              ? theme.grid
              : 'transparent',
        borderWidth: 0.5,
      },
      emphasis: { disabled: true },
      select: { disabled: true },
      // No tooltip settings here: the series drawn on the geo inherit them, so hiding its tooltip hides theirs.
    },
    series,
    graphic,
  };
  if (colorRange && config.color) {
    option.visualMap = {
      type: 'continuous',
      dimension: 2,
      seriesIndex: series.findIndex((s) => typeof s.id === 'string' && s.id.startsWith('points:')),
      min: colorRange.min,
      max: colorRange.max === colorRange.min ? colorRange.min + 1 : colorRange.max,
      calculable: false,
      orient: 'horizontal',
      right: 2,
      bottom: 2,
      itemWidth: 10,
      itemHeight: 90,
      // The two lightest steps would vanish against the land colour; the theme orders the ramp per mode.
      inRange: { color: theme.sequential.slice(2) },
      outOfRange: { color: theme.muted },
      text: [fmt(colorRange.max), `${config.color} ${fmt(colorRange.min)}`],
      textGap: 6,
      textStyle: { color: theme.muted, fontSize: 11 },
      backgroundColor: translucent(theme.surface, 0.85),
      padding: [4, 6],
      borderRadius: 4,
    };
  }
  return option;
}
