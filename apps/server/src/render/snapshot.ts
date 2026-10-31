/**
 * Server-side PNG rendering of widgets and whole dashboards.
 *
 * This is how an MCP agent gets *visual* feedback: it changes a widget, asks
 * for a snapshot, looks at the image, and corrects itself. Charts use the same
 * option builder as the browser, rendered through ECharts' SSR SVG renderer
 * and rasterised with resvg (no headless browser needed).
 */

import { fileURLToPath } from 'node:url';
import {
  buildChartOption,
  buildGaugeOption,
  type ChartTheme,
  type ColorMap,
  cellStyle,
  clockModel,
  clockSvg,
  compact,
  compileTableRules,
  computeGauge,
  computeKpi,
  type DashboardDoc,
  type DatasetResult,
  formatNumber,
  formatRelative,
  GRID_COLUMNS,
  isDataWidgetType,
  MAX_SERIES,
  resolveColor,
  searchPlaceholder,
  THEMES,
  type ThemeMode,
  tableColumns,
  type Widget,
} from '@patchbay/core';
import world from '@patchbay/core/geo/world-110m.json' with { type: 'json' };
import { buildMapOption, mapTime, WORLD_MAP } from '@patchbay/core/map';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import * as echarts from 'echarts';
import { collectGarbage } from './gc.ts';

// The same Natural Earth countries the browser's map chunk registers: no tiles, so snapshots work offline too.
echarts.registerMap(WORLD_MAP, world as Parameters<typeof echarts.registerMap>[1]);

const FONT = 'Inter, sans-serif';

/**
 * The renderer brings its own fonts instead of asking the OS. resvg finds system fonts through
 * fontconfig, and the slim runtime image has no fonts.conf, so it found none and every text node
 * rendered empty while shapes still drew. On a desktop it picks whatever happens to be installed.
 * Inter covers Latin, Greek, Cyrillic and the symbols used below (▲ ▼ ■ ⚠ …); scripts it lacks
 * (CJK, Arabic) render as boxes, a fair price for snapshots that look the same on every host.
 */
const FONT_OPTIONS: ResvgRenderOptions['font'] = {
  loadSystemFonts: false,
  fontFiles: ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf'].map((file) =>
    fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)),
  ),
  defaultFontFamily: 'Inter',
  sansSerifFamily: 'Inter',
};
const ROW_HEIGHT = 80;
const GAP = 12;
const HEADER = 36;

/**
 * The most pixels any snapshot may have, device scale included. resvg holds the whole RGBA pixmap plus the PNG
 * encoder's buffers, about 4 to 9 bytes per pixel at peak, so this keeps one render to a few tens of MB. Without a
 * cap the raster followed the lowest widget: one widget stored at row 1 500 asked for 158 million pixels and took
 * 1.4 GB. 4 MP is a 1280 px wide dashboard about 37 grid rows tall; every template is under 16.
 */
export const MAX_PIXELS = 4_000_000;
const DASHBOARD_WIDTH = { default: 1280, min: 480, max: 2560 };
const WIDGET_SIZE = { width: 640, height: 360, min: 80, max: 1600, scale: 1.5 };
/** Room kept at the bottom of a cropped dashboard for the line saying what was left out. */
const CROP_NOTE = 40;
/**
 * Marks (dots, bars, cells) one snapshot may draw in charts and maps together. Each mark is an SVG element that
 * ECharts builds and resvg parses, about 400 bytes of SVG: 60 scatter charts of 10 000 rows took 15 s and 1.9 GB.
 * A chart of the default maxPoints (5 000) with two y fields fits; beyond that every widget keeps its newest rows, the
 * way maxPoints itself trims. 20 000 still let one heavy dashboard draw for 5 s (7 s on a small NAS).
 */
export const MARK_BUDGET = 10_000;
/**
 * Points (rows times series) line and area charts may read in one snapshot. They draw one sampled path per series,
 * so their SVG stays small, but ECharts still walks every point: 60 charts of 20 000 rows and nine series would take
 * half a minute. Twenty charts of 5 000 rows and one series fit.
 */
export const POINT_BUDGET = 100_000;
/**
 * Backstops for what the budgets above do not foresee. Widgets left once the drawing has taken this long, or once the
 * SVG has grown this large (resvg's parse tree and time follow its size), are not drawn; their cards say so. The
 * worker's hard limit (render/worker-host.ts) leaves room for rasterising after this.
 */
export const DRAW_TIME_MS = 6_000;
export const SVG_BYTES = 8 * 1024 * 1024;

const ECHARTS_TYPES = new Set<Widget['type']>(['chart', 'map', 'gauge']);

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.round(value)));

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

function echartsSvg(option: Record<string, unknown>, width: number, height: number): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({
      ...option,
      animation: false,
      textStyle: { ...(option.textStyle as object), fontFamily: FONT },
    });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/**
 * Places an SVG document inside a parent SVG at (x, y). It clips to its box unless `clip` is false: resvg drops a
 * clipped `<svg>` inside another clipped `<svg>` altogether once its content reaches far beyond the box, which is
 * what a zoomed-in map is (the whole world's land, scaled up).
 */
function nest(svg: string, x: number, y: number, width: number, height: number, clip = true): string {
  const start = svg.indexOf('<svg');
  const end = svg.indexOf('>', start);
  const attrs = svg.slice(start + 4, end).replace(/\s(width|height|x|y|overflow)="[^"]*"/g, '');
  const overflow = clip ? '' : ' overflow="visible"';
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}"${overflow}${attrs}>${svg.slice(end + 1)}`;
}

function text(
  x: number,
  y: number,
  value: string,
  opts: { size?: number; color: string; weight?: number; anchor?: string },
) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? 12}" font-weight="${opts.weight ?? 400}" fill="${opts.color}" text-anchor="${opts.anchor ?? 'start'}">${esc(value)}</text>`;
}

function widgetBody(
  widget: Widget,
  result: DatasetResult | undefined,
  theme: ChartTheme,
  w: number,
  h: number,
  entityColors?: ColorMap,
): string {
  if (widget.type === 'text') {
    const plain = widget.config.markdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#>*_`[\]]/g, '')
      .replace(/\(https?:[^)]+\)/g, '');
    const perLine = Math.max(10, Math.floor(w / 7));
    const lines: string[] = [];
    for (const para of plain.split(/\n+/)) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        if ((line + word).length > perLine) {
          lines.push(line.trim());
          line = '';
        }
        line += `${word} `;
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines
      .slice(0, Math.floor(h / 18))
      .map((l, i) => text(0, 14 + i * 18, l, { size: 13, color: theme.textSecondary }))
      .join('');
  }
  if (widget.type === 'clock') {
    // The server has no viewer: a clock without a zone is drawn in UTC and says so, rather than guessing.
    const model = clockModel(widget.config, Date.now(), { locale: 'en-GB', zone: 'UTC' });
    return nest(clockSvg(model, widget.config, theme, FONT), 0, 0, w, h);
  }
  if (widget.type === 'search') {
    const boxH = Math.min(40, h);
    return [
      `<rect x="0" y="0" width="${w}" height="${boxH}" rx="8" fill="${theme.mode === 'light' ? '#f1f0ec' : '#242423'}" stroke="${theme.grid}"/>`,
      `<circle cx="17" cy="${boxH / 2 - 1}" r="5.5" fill="none" stroke="${theme.muted}" stroke-width="1.6"/>`,
      `<line x1="21" y1="${boxH / 2 + 3}" x2="25" y2="${boxH / 2 + 7}" stroke="${theme.muted}" stroke-width="1.6" stroke-linecap="round"/>`,
      text(34, boxH / 2 + 4.5, truncate(searchPlaceholder(widget.config), Math.floor((w - 40) / 7)), {
        size: 13,
        color: theme.muted,
      }),
    ].join('');
  }
  if (!result) return text(0, 16, 'Loading…', { color: theme.muted });
  if (result.error && result.table.rows.length === 0) {
    return text(0, 16, truncate(`⚠ ${result.error}`, Math.floor(w / 6.5)), { color: theme.status.critical });
  }
  const table = result.table;
  switch (widget.type) {
    case 'chart':
      return nest(
        echartsSvg(
          buildChartOption(widget.config, table, theme, { animation: false, static: true, entityColors }),
          w,
          h,
        ),
        0,
        0,
        w,
        h,
      );
    case 'map':
      return nest(
        echartsSvg(
          buildMapOption(widget.config, table, theme, {
            animation: false,
            static: true,
            at: mapTime(table, result.fetchedAt),
            entityColors,
          }),
          w,
          h,
        ),
        0,
        0,
        w,
        h,
      );
    case 'gauge':
      return nest(
        echartsSvg(buildGaugeOption(widget.config, computeGauge(widget.config, table), theme), w, h),
        0,
        0,
        w,
        h,
      );
    case 'kpi': {
      const kpi = computeKpi(widget.config, table);
      const size = Math.min(40, Math.max(22, h / 2.6));
      let out = text(0, size, formatNumber(kpi.value, widget.config.format), {
        size,
        weight: 600,
        color: kpi.valueColor ? resolveColor(kpi.valueColor, theme, 'text') : theme.textPrimary,
      });
      if (kpi.delta !== null) {
        const color =
          kpi.trend === 'good' ? theme.deltaGood : kpi.trend === 'bad' ? theme.deltaBad : theme.muted;
        const arrow = kpi.delta > 0 ? '▲' : kpi.delta < 0 ? '▼' : '■';
        const pct =
          kpi.deltaPct === null ? '' : ` (${kpi.deltaPct > 0 ? '+' : ''}${kpi.deltaPct.toFixed(1)}%)`;
        out += text(
          0,
          size + 22,
          `${arrow} ${formatNumber(Math.abs(kpi.delta), widget.config.format)}${pct}`,
          { size: 13, color },
        );
      }
      if (kpi.spark.length > 1) {
        const min = Math.min(...kpi.spark);
        const max = Math.max(...kpi.spark);
        const sh = Math.max(20, h - size - 36);
        const points = kpi.spark
          .map(
            (v, i) =>
              `${((i / (kpi.spark.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min || 1)) * sh).toFixed(1)}`,
          )
          .join(' ');
        out += `<polyline points="${points}" fill="none" stroke="${theme.categorical[0]}" stroke-width="2" stroke-linejoin="round"/>`;
      }
      return out;
    }
    case 'table': {
      const cols = tableColumns(widget.config, table).slice(0, 8);
      const rules = compileTableRules(widget.config);
      if (widget.config.style === 'list' && cols.length) {
        // Headlines: the first column as the title, the others muted under it; times relative to the render time.
        const now = Date.now();
        const first = cols[0]!;
        const rest = cols.slice(1);
        const perLine = Math.max(10, Math.floor(w / 7));
        let out = '';
        table.rows.slice(0, Math.max(0, Math.floor(h / 42))).forEach((row, r) => {
          const y = r * 42;
          out += text(0, y + 15, truncate(cellStyle(row, first, rules, theme).text, perLine), {
            size: 13,
            weight: 600,
            color: theme.textPrimary,
          });
          const meta = rest
            .map((c) => {
              const v = row[c.field] ?? null;
              if (v === null || v === '') return '';
              return c.type === 'time' && typeof v === 'number'
                ? formatRelative(v, now)
                : cellStyle(row, c, rules, theme).text;
            })
            .filter(Boolean)
            .join(' · ');
          if (meta)
            out += text(0, y + 31, truncate(meta, Math.floor(w / 6)), { size: 11, color: theme.muted });
          if (r > 0) out += `<line x1="0" y1="${y - 4}" x2="${w}" y2="${y - 4}" stroke="${theme.grid}"/>`;
        });
        return out;
      }
      const colW = w / Math.max(cols.length, 1);
      const maxChars = Math.max(4, Math.floor(colW / 7));
      let out = cols
        .map((c, i) =>
          text(i * colW, 12, truncate(c.label, maxChars), { size: 11, weight: 600, color: theme.muted }),
        )
        .join('');
      out += `<line x1="0" y1="20" x2="${w}" y2="20" stroke="${theme.grid}"/>`;
      const rows = table.rows.slice(0, Math.max(0, Math.floor((h - 26) / 20)));
      rows.forEach((row, r) => {
        cols.forEach((c, i) => {
          const cell = cellStyle(row, c, rules, theme);
          // The same tint the browser draws: a wash behind the cell, the text keeps the normal ink.
          if (cell.background)
            out += `<rect x="${i * colW - 4}" y="${24 + r * 20}" width="${colW - 2}" height="19" rx="3" fill="${cell.background}"/>`;
          out += text(i * colW, 38 + r * 20, truncate(cell.text, maxChars), {
            size: 12,
            color: cell.color ?? theme.textPrimary,
          });
        });
      });
      return out;
    }
  }
}

function card(
  widget: Widget,
  result: DatasetResult | undefined,
  theme: ChartTheme,
  width: number,
  height: number,
  entityColors?: ColorMap,
  /** Drawn in place of the body, for a widget the snapshot had no budget left for. */
  note?: string,
): string {
  const pad = 14;
  const title = widget.title ?? (isDataWidgetType(widget.type) ? widget.id : '');
  // As in the browser: an untitled search box is one line, without an empty title row above it.
  const top = widget.type === 'search' && !widget.title ? pad : HEADER;
  const bodyW = width - pad * 2;
  const bodyH = height - top - pad;
  const border = theme.mode === 'light' ? 'rgba(11,11,11,0.10)' : 'rgba(255,255,255,0.10)';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.surface}" stroke="${border}"/>`,
    text(pad, 24, truncate(title, Math.floor(bodyW / 7.5)), {
      size: 14,
      weight: 600,
      color: theme.textPrimary,
    }),
    `<g transform="translate(${pad}, ${top})">${
      note
        ? text(0, 16, truncate(note, Math.floor(bodyW / 6.5)), { color: theme.muted })
        : widgetBody(widget, result, theme, bodyW, bodyH, entityColors)
    }</g>`,
    '</svg>',
  ].join('');
}

/** The only way to a raster, so no caller can ask for more than MAX_PIXELS. */
function toPng(svg: string, width: number, height: number, scale = 1): Buffer {
  if (width * height * scale * scale > MAX_PIXELS + 1) {
    throw new Error(`Snapshot of ${width}x${height} at ${scale}x exceeds the pixel budget`);
  }
  return new Resvg(svg, {
    font: FONT_OPTIONS,
    fitTo: scale === 1 ? { mode: 'original' } : { mode: 'zoom', value: scale },
  })
    .render()
    .asPng();
}

type Marked = Extract<Widget, { type: 'chart' | 'map' }>;
type Pool = 'marks' | 'points';

interface Demand {
  pool: Pool;
  /** Rows the widget would read (its maxPoints at most). */
  rows: number;
  /** What one row costs: a mark per y field, or a point per series of a line. */
  perRow: number;
}

/** Distinct values of `field` in the newest `rows` rows, as many as a chart keeps apart (the rest fold into one). */
function seriesCount(result: DatasetResult, field: string, rows: number): number {
  const seen = new Set<unknown>();
  const all = result.table.rows;
  for (let i = Math.max(0, all.length - rows); i < all.length && seen.size <= MAX_SERIES; i++)
    seen.add(all[i]![field] ?? null);
  return Math.max(1, seen.size);
}

/**
 * What a widget would draw unless a budget trims it. Pie, donut, funnel and radar charts are not counted: they
 * aggregate into a few slices or read the first 24 rows, so trimming would only change their totals.
 */
function demand(widget: Widget, result: DatasetResult | undefined): Demand | undefined {
  if (!result || (widget.type !== 'chart' && widget.type !== 'map')) return undefined;
  const rows = Math.min(result.table.rows.length, widget.config.maxPoints);
  if (rows === 0) return undefined;
  if (widget.type === 'map') return { pool: 'marks', rows, perRow: 1 };
  const { kind, series, y } = widget.config;
  if (kind === 'line' || kind === 'area')
    return { pool: 'points', rows, perRow: series ? seriesCount(result, series, rows) : y.length };
  if (kind === 'heatmap') return { pool: 'marks', rows, perRow: 1 };
  if (kind === 'scatter' || kind === 'bar') return { pool: 'marks', rows, perRow: series ? 1 : y.length };
  return undefined;
}

/**
 * Splits `budget` fairly: widgets asking for less than an equal share keep all of theirs, the rest share what is left.
 * Returns the limit per widget id, only for widgets that have to give something up.
 */
export function shareMarks(demands: Map<string, number>, budget = MARK_BUDGET): Map<string, number> {
  const limits = new Map<string, number>();
  const asking = [...demands].filter(([, d]) => d > 0).sort((a, b) => a[1] - b[1]);
  let left = budget;
  asking.forEach(([id, demand], n) => {
    const share = Math.max(1, Math.floor(left / (asking.length - n)));
    if (demand > share) limits.set(id, share);
    left -= Math.min(demand, share);
  });
  return limits;
}

export interface Budgets {
  marks: number;
  points: number;
}

/**
 * The maxPoints each widget is drawn with so the whole snapshot stays within both budgets, for the widgets that have
 * to give something up. A trimmed widget keeps its newest rows, as maxPoints does in the browser.
 */
export function drawLimits(
  entries: { widget: Widget; result: DatasetResult | undefined }[],
  budgets: Budgets = { marks: MARK_BUDGET, points: POINT_BUDGET },
): Map<string, number> {
  const demands = new Map<string, Demand>();
  for (const { widget, result } of entries) {
    const d = demand(widget, result);
    if (d) demands.set(widget.id, d);
  }
  const limits = new Map<string, number>();
  for (const pool of ['marks', 'points'] as const) {
    const asking = new Map(
      [...demands].filter(([, d]) => d.pool === pool).map(([id, d]) => [id, d.rows * d.perRow]),
    );
    for (const [id, share] of shareMarks(asking, budgets[pool]))
      limits.set(id, Math.max(1, Math.floor(share / demands.get(id)!.perRow)));
  }
  return limits;
}

const trimmed = (widget: Widget, limit: number | undefined): Widget =>
  limit === undefined ? widget : ({ ...widget, config: { ...widget.config, maxPoints: limit } } as Marked);

/**
 * Draws one widget, within the same budgets as a whole dashboard. Synchronous and memory-hungry: request handlers
 * never call it themselves but go through `snapshotGate` (render/gate.ts), which draws in the render worker.
 */
export function renderWidgetPng(
  widget: Widget,
  result: DatasetResult | undefined,
  options: { theme?: ThemeMode; width?: number; height?: number; entityColors?: ColorMap | undefined } = {},
): Buffer {
  const theme = THEMES[options.theme ?? 'light'];
  const { min, max } = WIDGET_SIZE;
  const width = clamp(options.width, WIDGET_SIZE.width, min, max);
  const height = clamp(options.height, WIDGET_SIZE.height, min, max);
  // Large cards trade sharpness for pixels instead of growing past the budget.
  const scale = Math.min(WIDGET_SIZE.scale, Math.sqrt(MAX_PIXELS / (width * height)));
  const drawn = trimmed(widget, drawLimits([{ widget, result }]).get(widget.id));
  return toPng(card(drawn, result, theme, width, height, options.entityColors), width, height, scale);
}

export interface DashboardRenderOptions {
  theme?: ThemeMode;
  width?: number;
  /** For tests: other budgets, draw time and SVG size than the defaults above. */
  budgets?: Budgets;
  drawTimeMs?: number;
  svgBytes?: number;
}

/** Draws a whole dashboard, at most MAX_PIXELS. Like renderWidgetPng, request handlers go through `snapshotGate`. */
export function renderDashboardPng(
  doc: DashboardDoc,
  results: Map<string, DatasetResult>,
  options: DashboardRenderOptions = {},
): Buffer {
  const started = Date.now();
  const drawTimeMs = options.drawTimeMs ?? DRAW_TIME_MS;
  const svgBytes = options.svgBytes ?? SVG_BYTES;
  const theme = THEMES[options.theme ?? 'light'];
  const width = clamp(options.width, DASHBOARD_WIDTH.default, DASHBOARD_WIDTH.min, DASHBOARD_WIDTH.max);
  const col = (width - GAP * (GRID_COLUMNS + 1)) / GRID_COLUMNS;
  const top = 64;
  // The browser grid compacts vertically, so empty rows a stored layout may have (the schema allows y up to
  // 10 000) are never on screen. Compacting here keeps the image faithful and keeps those rows out of the budget.
  const layout = compact(doc.layout.filter((it) => doc.widgets.some((w) => w.id === it.i)));
  const bottom = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const fullHeight = top + bottom * ROW_HEIGHT + GAP * 2;
  const maxHeight = Math.floor(MAX_PIXELS / width);
  const cropped = fullHeight > maxHeight;
  const height = cropped ? maxHeight : fullHeight;
  // Cards starting below this line are left out; one crossing it is cut off by the note.
  const visibleTo = cropped ? height - CROP_NOTE : height;
  const page = theme.mode === 'light' ? '#f9f9f7' : '#0d0d0d';
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${page}"/>`,
    text(GAP + 4, 40, truncate(doc.title, 80), { size: 22, weight: 700, color: theme.textPrimary }),
  ];
  const visible = layout.flatMap((item) => {
    const y = top + item.y * ROW_HEIGHT;
    if (y >= visibleTo) return [];
    const widget = doc.widgets.find((w) => w.id === item.i)!;
    const result = 'datasetId' in widget ? results.get(widget.datasetId) : undefined;
    return [{ item, y, widget, result }];
  });
  const hidden = layout.length - visible.length;
  const limits = drawLimits(visible, options.budgets);
  let size = parts.reduce((sum, part) => sum + part.length, 0);
  for (const { item, y, widget, result } of visible) {
    const x = GAP + item.x * (col + GAP);
    const w = item.w * col + (item.w - 1) * GAP;
    const h = item.h * ROW_HEIGHT - GAP;
    const heavy = ECHARTS_TYPES.has(widget.type) && result !== undefined;
    // Text, KPI and table cards are drawn anyway: their size bounds them, and they keep the page readable.
    const late = heavy && (Date.now() - started > drawTimeMs || size > svgBytes);
    const note = late ? 'Not drawn: this snapshot had too much to draw' : undefined;
    const drawn = trimmed(widget, limits.get(widget.id));
    // A map card is bounded by construction (title, then the map, which clips itself), so it may stay unclipped.
    const svg = nest(card(drawn, result, theme, w, h, doc.colors, note), x, y, w, h, widget.type !== 'map');
    parts.push(svg);
    size += svg.length;
    // ECharts leaves megabytes of short-lived objects per chart; without this a dashboard of many maps peaked at the
    // sum of all of them before V8 got round to collecting.
    if (heavy && !late) collectGarbage();
  }
  if (cropped) {
    const note = hidden
      ? `Cut off at ${height} px: ${hidden} more widget${hidden === 1 ? '' : 's'} below not shown`
      : `Cut off at ${height} px: the rest of the dashboard is not shown`;
    parts.push(
      `<rect x="0" y="${visibleTo}" width="${width}" height="${CROP_NOTE}" fill="${page}"/>`,
      `<line x1="0" y1="${visibleTo + 0.5}" x2="${width}" y2="${visibleTo + 0.5}" stroke="${theme.grid}"/>`,
      text(width / 2, visibleTo + 25, note, { size: 13, color: theme.muted, anchor: 'middle' }),
    );
  }
  parts.push('</svg>');
  return toPng(parts.join(''), width, height);
}
