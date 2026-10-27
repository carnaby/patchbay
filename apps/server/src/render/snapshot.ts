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
  buildMapOption,
  type ChartTheme,
  computeGauge,
  computeKpi,
  type DashboardDoc,
  type DatasetResult,
  formatNumber,
  formatValue,
  GRID_COLUMNS,
  mapTime,
  THEMES,
  type ThemeMode,
  type Widget,
  WORLD_MAP,
} from '@patchbay/core';
import world from '@patchbay/core/geo/world-110m.json' with { type: 'json' };
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import * as echarts from 'echarts';

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

/** Places an SVG document inside a parent SVG at (x, y). */
function nest(svg: string, x: number, y: number, width: number, height: number): string {
  const start = svg.indexOf('<svg');
  const end = svg.indexOf('>', start);
  const attrs = svg.slice(start + 4, end).replace(/\s(width|height|x|y)="[^"]*"/g, '');
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}"${attrs}>${svg.slice(end + 1)}`;
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
  if (!result) return text(0, 16, 'Loading…', { color: theme.muted });
  if (result.error && result.table.rows.length === 0) {
    return text(0, 16, truncate(`⚠ ${result.error}`, Math.floor(w / 6.5)), { color: theme.status.critical });
  }
  const table = result.table;
  switch (widget.type) {
    case 'chart':
      return nest(
        echartsSvg(buildChartOption(widget.config, table, theme, { animation: false, static: true }), w, h),
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
        color: theme.textPrimary,
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
      const cols = (
        widget.config.columns?.length ? widget.config.columns : table.columns.map((c) => c.name)
      ).slice(0, 8);
      const colW = w / Math.max(cols.length, 1);
      const maxChars = Math.max(4, Math.floor(colW / 7));
      const types = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
      let out = cols
        .map((c, i) =>
          text(i * colW, 12, truncate(c, maxChars), { size: 11, weight: 600, color: theme.muted }),
        )
        .join('');
      out += `<line x1="0" y1="20" x2="${w}" y2="20" stroke="${theme.grid}"/>`;
      const rows = table.rows.slice(0, Math.max(0, Math.floor((h - 26) / 20)));
      rows.forEach((row, r) => {
        cols.forEach((c, i) => {
          out += text(
            i * colW,
            38 + r * 20,
            truncate(formatValue(row[c] ?? null, types[c], widget.config.format), maxChars),
            {
              size: 12,
              color: theme.textPrimary,
            },
          );
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
): string {
  const pad = 14;
  const title = widget.title ?? widget.id;
  const bodyW = width - pad * 2;
  const bodyH = height - HEADER - pad;
  const border = theme.mode === 'light' ? 'rgba(11,11,11,0.10)' : 'rgba(255,255,255,0.10)';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.surface}" stroke="${border}"/>`,
    text(pad, 24, truncate(title, Math.floor(bodyW / 7.5)), {
      size: 14,
      weight: 600,
      color: theme.textPrimary,
    }),
    `<g transform="translate(${pad}, ${HEADER})">${widgetBody(widget, result, theme, bodyW, bodyH)}</g>`,
    '</svg>',
  ].join('');
}

function toPng(svg: string, scale = 1): Buffer {
  return new Resvg(svg, {
    font: FONT_OPTIONS,
    fitTo: scale === 1 ? { mode: 'original' } : { mode: 'zoom', value: scale },
  })
    .render()
    .asPng();
}

export function renderWidgetPng(
  widget: Widget,
  result: DatasetResult | undefined,
  options: { theme?: ThemeMode; width?: number; height?: number } = {},
): Buffer {
  const theme = THEMES[options.theme ?? 'light'];
  return toPng(card(widget, result, theme, options.width ?? 640, options.height ?? 360), 1.5);
}

export function renderDashboardPng(
  doc: DashboardDoc,
  results: Map<string, DatasetResult>,
  options: { theme?: ThemeMode; width?: number } = {},
): Buffer {
  const theme = THEMES[options.theme ?? 'light'];
  const width = options.width ?? 1280;
  const col = (width - GAP * (GRID_COLUMNS + 1)) / GRID_COLUMNS;
  const top = 64;
  const bottom = doc.layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const height = top + bottom * ROW_HEIGHT + GAP * 2;
  const page = theme.mode === 'light' ? '#f9f9f7' : '#0d0d0d';
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${page}"/>`,
    text(GAP + 4, 40, truncate(doc.title, 80), { size: 22, weight: 700, color: theme.textPrimary }),
  ];
  for (const item of doc.layout) {
    const widget = doc.widgets.find((w) => w.id === item.i);
    if (!widget) continue;
    const x = GAP + item.x * (col + GAP);
    const y = top + item.y * ROW_HEIGHT;
    const w = item.w * col + (item.w - 1) * GAP;
    const h = item.h * ROW_HEIGHT - GAP;
    const result = 'datasetId' in widget ? results.get(widget.datasetId) : undefined;
    parts.push(nest(card(widget, result, theme, w, h), x, y, w, h));
  }
  parts.push('</svg>');
  return toPng(parts.join(''));
}
