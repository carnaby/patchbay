/**
 * Turns a chart widget config + a data table into an ECharts option object.
 *
 * This is pure and framework-free on purpose: the browser feeds the result to
 * a canvas renderer, while the server feeds the exact same object to ECharts'
 * SSR SVG renderer to produce PNG snapshots an agent can look at.
 */
import { type ColorMap, mappedColor, seriesColors } from './colors.ts';
import { formatNumber, formatTime } from './format.ts';
import { type ChartConfig, type GaugeConfig, REFERENCE_LINE_KINDS } from './schema.ts';
import { referenceLineValue } from './stats.ts';
import { columnType, type DataTable, type Scalar } from './table.ts';
import { type ChartTheme, MAX_SERIES, resolveColor } from './theme.ts';

type Option = Record<string, unknown>;

export interface ChartBuildOptions {
  animation?: boolean;
  /** Static renders (snapshots) have no hover, so a few direct labels help. */
  static?: boolean;
  /** Dashboard-wide entity colours (`doc.colors`). */
  entityColors?: ColorMap | undefined;
}

const OTHER = 'Other';

function baseOption(theme: ChartTheme, opts: ChartBuildOptions): Option {
  return {
    animation: opts.animation ?? true,
    animationDuration: 300,
    animationDurationUpdate: 300,
    backgroundColor: 'transparent',
    color: theme.categorical,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: theme.textSecondary },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
  };
}

function axisStyle(theme: ChartTheme) {
  return {
    axisLine: { lineStyle: { color: theme.axis } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, hideOverlap: true },
    splitLine: { lineStyle: { color: theme.grid, type: 'solid' } },
  };
}

function tooltip(theme: ChartTheme, trigger: 'axis' | 'item', config: ChartConfig) {
  return {
    trigger,
    confine: true,
    backgroundColor: theme.surface,
    borderColor: theme.axis,
    textStyle: { color: theme.textPrimary },
    axisPointer: { type: trigger === 'axis' ? 'line' : 'none', lineStyle: { color: theme.axis } },
    valueFormatter: (v: unknown) =>
      typeof v === 'number' ? formatNumber(v, config.format) : String(v ?? '-'),
  };
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * Distinct values sorted by name, folding the tail into "Other". Keys with a colour of their own are kept out of
 * "Other" first: someone named that entity, so it should stay visible.
 */
function seriesKeys(values: Scalar[], named: (key: string) => boolean): { keys: string[]; folded: boolean } {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const v of values) {
    const k = v === null ? '(empty)' : String(v);
    if (!set.has(k)) {
      set.add(k);
      seen.push(k);
    }
  }
  seen.sort(byName);
  if (seen.length <= MAX_SERIES) return { keys: seen, folded: false };
  const kept = [...seen.filter(named), ...seen.filter((k) => !named(k))].slice(0, MAX_SERIES - 1);
  return { keys: [...kept.sort(byName), OTHER], folded: true };
}

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

export function buildChartOption(
  config: ChartConfig,
  input: DataTable,
  theme: ChartTheme,
  opts: ChartBuildOptions = {},
): Option {
  if (input.rows.length === 0) return emptyOption(theme, 'No data');
  const missing = [config.x, ...config.y, ...(config.series ? [config.series] : [])].filter(
    (f) => !input.columns.some((c) => c.name === f),
  );
  if (missing.length) return emptyOption(theme, `Missing column: ${missing.join(', ')}`);

  const table: DataTable =
    input.rows.length > config.maxPoints ? { ...input, rows: input.rows.slice(-config.maxPoints) } : input;
  const xType = columnType(table, config.x);
  const base = baseOption(theme, opts);

  switch (config.kind) {
    case 'pie':
    case 'donut':
    case 'funnel':
      return proportionOption(config, table, theme, base, opts);
    case 'heatmap':
      return heatmapOption(config, table, theme, base);
    case 'radar':
      return radarOption(config, table, theme, base, opts);
    default:
      return cartesianOption(config, table, theme, base, xType, opts);
  }
}

function cartesianOption(
  config: ChartConfig,
  table: DataTable,
  theme: ChartTheme,
  base: Option,
  xType: string | undefined,
  opts: ChartBuildOptions,
): Option {
  const isTime = xType === 'time';
  const isScatter = config.kind === 'scatter';
  const valueX = isScatter && xType === 'number';
  const axisKind = isTime ? 'time' : valueX ? 'value' : 'category';
  const markType = config.kind === 'area' ? 'line' : config.kind;
  const categories =
    axisKind === 'category' ? [...new Set(table.rows.map((r) => String(r[config.x] ?? '')))] : null;

  type Series = { name: string; points: [Scalar, Scalar][] };
  const groups: Series[] = [];
  let folded = false;
  if (config.series) {
    const split = seriesKeys(
      table.rows.map((r) => r[config.series!] ?? null),
      (k) => mappedColor(k, config.colors, opts.entityColors) !== undefined,
    );
    const keys = split.keys;
    folded = split.folded;
    const keySet = new Set(keys);
    const y = config.y[0]!;
    const byKey = new Map<string, Series>(keys.map((k) => [k, { name: k, points: [] }]));
    for (const row of table.rows) {
      const raw = row[config.series] === null ? '(empty)' : String(row[config.series]);
      const key = keySet.has(raw) ? raw : folded ? OTHER : raw;
      byKey.get(key)?.points.push([row[config.x] ?? null, row[y] ?? null]);
    }
    groups.push(...byKey.values());
  } else {
    for (const y of config.y) {
      groups.push({ name: y, points: table.rows.map((r) => [r[config.x] ?? null, r[y] ?? null]) });
    }
  }

  const multi = groups.length > 1;
  const colors = seriesColors(
    groups.map((g) => g.name),
    config.colors,
    theme,
    { entityColors: opts.entityColors, other: folded ? OTHER : undefined },
  );
  const series = groups.map((g, idx) => {
    const data =
      axisKind === 'category'
        ? // Align to the shared category list so split series line up.
          (() => {
            const map = new Map<string, Scalar>();
            for (const [x, y] of g.points) {
              const k = String(x ?? '');
              const prev = map.get(k);
              map.set(k, typeof prev === 'number' && typeof y === 'number' ? prev + y : y);
            }
            return categories!.map((c) => map.get(c) ?? null);
          })()
        : g.points;
    const s: Option = {
      name: g.name,
      type: markType,
      data,
      showSymbol: markType === 'scatter' || (markType === 'line' && table.rows.length <= 40),
      symbolSize: markType === 'scatter' ? 8 : 6,
      emphasis: { focus: 'series' },
    };
    if (markType === 'line') {
      s.smooth = config.smooth;
      s.lineStyle = { width: 2 };
      s.sampling = 'lttb';
      s.connectNulls = false;
      if (config.kind === 'area') s.areaStyle = { opacity: multi && !config.stacked ? 0.12 : 0.2 };
    }
    if (markType === 'bar') {
      s.barMaxWidth = 36;
      s.barGap = '10%';
      s.itemStyle = {
        borderRadius: config.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        borderColor: theme.surface,
        borderWidth: 1,
      };
    }
    if (markType === 'scatter') s.itemStyle = { borderColor: theme.surface, borderWidth: 1, opacity: 0.85 };
    if (config.stacked && markType !== 'scatter') s.stack = 'total';
    if (config.showLabels || (opts.static && !multi && table.rows.length <= 12 && markType === 'bar')) {
      s.label = {
        show: true,
        position: config.horizontal ? 'right' : 'top',
        color: theme.textSecondary,
        formatter: (p: { value: unknown }) => {
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          return typeof v === 'number' ? formatNumber(v, config.format) : '';
        },
      };
    }
    // Set per series rather than through `option.color`, so the colour belongs to the entity, not the rank.
    s.itemStyle = { ...(s.itemStyle as object), color: colors[idx] };
    return s;
  });

  const showLegend = config.showLegend ?? multi;
  const categoryAxis: Option = {
    type: axisKind,
    ...axisStyle(theme),
    splitLine: { show: false },
    ...(categories ? { data: categories } : {}),
    ...(isTime ? { axisLabel: { color: theme.muted, hideOverlap: true } } : {}),
    boundaryGap: markType === 'bar' || axisKind === 'category' ? markType === 'bar' : false,
    // Fixed bounds keep a lat/lon scatter "map" from rescaling every time the data moves.
    ...(valueX ? { min: config.xMin, max: config.xMax } : {}),
  };
  const valueAxis: Option = {
    type: config.logScale ? 'log' : 'value',
    ...axisStyle(theme),
    min: config.yMin,
    max: config.yMax,
    scale: config.yMin === undefined && markType !== 'bar' && config.kind !== 'area',
    axisLabel: {
      color: theme.muted,
      formatter: (v: number) =>
        formatNumber(
          v,
          config.format
            ? { ...config.format, style: config.format.style === 'number' ? 'compact' : config.format.style }
            : { style: 'compact' },
        ),
    },
  };
  const horizontal = config.horizontal && markType === 'bar';
  const marks = referenceMarks(config, table, theme, horizontal);
  if (marks && series[0]) {
    series[0].markLine = marks.markLine;
    widenForLines(valueAxis, config, marks.values);
  }
  return {
    ...base,
    tooltip: tooltip(theme, isScatter ? 'item' : 'axis', config),
    legend: showLegend
      ? {
          show: true,
          top: 0,
          type: 'scroll',
          icon: 'roundRect',
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: theme.textSecondary },
        }
      : { show: false },
    grid: { left: 8, right: 16, top: showLegend ? 32 : 16, bottom: 8, containLabel: true },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series,
  };
}

const STAT_NAMES = { avg: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum' } as const;

/** Dashed benchmark lines on the value axis, drawn as a markLine on the first series. */
function referenceMarks(
  config: ChartConfig,
  table: DataTable,
  theme: ChartTheme,
  horizontal: boolean,
): { markLine: Option; values: number[] } | null {
  if (!config.referenceLines?.length) return null;
  if (!(REFERENCE_LINE_KINDS as readonly string[]).includes(config.kind)) return null;
  const values: number[] = [];
  const data = config.referenceLines.flatMap((line) => {
    const value = referenceLineValue(line, config, table);
    if (value === null) return [];
    values.push(value);
    const color = line.color ?? 'neutral';
    const name = line.label ?? (line.stat ? STAT_NAMES[line.stat] : '');
    const text = `${name ? `${name} · ` : ''}${formatNumber(value, config.format)}`;
    return [
      {
        [horizontal ? 'xAxis' : 'yAxis']: value,
        lineStyle: { color: resolveColor(color, theme, 'mark'), type: 'dashed', width: 1.5 },
        label: {
          show: true,
          // A function, not a template string: a label like "{a}" must stay literal.
          formatter: () => text,
          color: resolveColor(color, theme, 'text'),
          fontSize: 11,
          position: horizontal ? 'end' : 'insideEndTop',
        },
      },
    ];
  });
  if (!data.length) return null;
  return { markLine: { silent: true, symbol: 'none', animation: false, data }, values };
}

/**
 * ECharts sizes the axis to the data only, so a benchmark outside the data range would be invisible. The bound is
 * moved just past the line, rounded to a step of the range; bounds the author fixed are left alone, and returning
 * undefined keeps ECharts' own rounding whenever the line is inside the data already.
 */
function widenForLines(axis: Option, config: ChartConfig, values: number[]) {
  if (config.logScale || !values.length) return;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = (e: { min: number; max: number }) => {
    const span = Math.max(e.max, hi) - Math.min(e.min, lo) || Math.abs(hi) || 1;
    return { span, unit: 10 ** Math.floor(Math.log10(span / 5)) };
  };
  if (config.yMin === undefined) {
    axis.min = (e: { min: number; max: number }) => {
      if (lo >= e.min) return undefined;
      const { span, unit } = step(e);
      return Math.floor((lo - span * 0.05) / unit) * unit;
    };
  }
  if (config.yMax === undefined) {
    axis.max = (e: { min: number; max: number }) => {
      if (hi <= e.max) return undefined;
      const { span, unit } = step(e);
      return Math.ceil((hi + span * 0.05) / unit) * unit;
    };
  }
}

function proportionOption(
  config: ChartConfig,
  table: DataTable,
  theme: ChartTheme,
  base: Option,
  opts: ChartBuildOptions,
): Option {
  const y = config.y[0]!;
  const totals = new Map<string, number>();
  for (const row of table.rows) {
    const k = String(row[config.x] ?? '(empty)');
    const v = row[y];
    if (typeof v === 'number') totals.set(k, (totals.get(k) ?? 0) + v);
  }
  let items: { name: string; value: number; itemStyle?: { color: string | undefined } }[] = [
    ...totals.entries(),
  ].map(([name, value]) => ({ name, value }));
  if (config.kind !== 'funnel') {
    items.sort((a, b) => b.value - a.value);
    const limit = config.kind === 'pie' || config.kind === 'donut' ? 6 : MAX_SERIES;
    if (items.length > limit) {
      const rest = items.slice(limit - 1).reduce((s, i) => s + i.value, 0);
      items = [...items.slice(0, limit - 1), { name: OTHER, value: rest }];
    }
  }
  if (config.kind !== 'funnel') {
    // Slices stay sorted by value but take their colour from the label, so two slices whose values cross keep
    // their colours. The surface-coloured border keeps neighbours apart now that they are not adjacent slots.
    const folded = items.some((i) => i.name === OTHER) && !totals.has(OTHER);
    const names = items.map((i) => i.name).sort(byName);
    const colors = seriesColors(names, config.colors, theme, {
      entityColors: opts.entityColors,
      other: folded ? OTHER : undefined,
    });
    const colorOf = new Map(names.map((n, i) => [n, colors[i]!]));
    items = items.map((i) => ({ ...i, itemStyle: { color: colorOf.get(i.name) } }));
  }
  const label = {
    show: true,
    color: theme.textSecondary,
    formatter: (p: { name: string; percent?: number; value: number }) =>
      config.kind === 'funnel'
        ? `${p.name}: ${formatNumber(p.value, config.format)}`
        : // Names live in the legend; labels carry only the share so they never clip in small cards.
          `${Math.round(p.percent ?? 0)}%`,
  };
  const series: Option =
    config.kind === 'funnel'
      ? {
          type: 'funnel',
          data: items,
          left: '10%',
          width: '80%',
          gap: 2,
          label: { ...label, position: 'inside', color: '#ffffff' },
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          // Funnel stages are ordered, so they take the ordinal blue ramp.
          color: theme.mode === 'light' ? theme.sequential.slice(2).reverse() : theme.sequential.slice(0, 5),
        }
      : {
          type: 'pie',
          data: items,
          radius: config.kind === 'donut' ? ['44%', '68%'] : [0, '68%'],
          center: ['50%', '45%'],
          padAngle: 1,
          itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
          label: { ...label, show: opts.static || items.length <= 6 },
          labelLine: { lineStyle: { color: theme.axis } },
        };
  return {
    ...base,
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.surface,
      borderColor: theme.axis,
      textStyle: { color: theme.textPrimary },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? formatNumber(v, config.format) : String(v)),
    },
    legend: {
      show: config.showLegend ?? config.kind !== 'funnel',
      bottom: 0,
      type: 'scroll',
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.textSecondary },
    },
    series: [series],
  };
}

function heatmapOption(config: ChartConfig, table: DataTable, theme: ChartTheme, base: Option): Option {
  const yField = config.series;
  if (!yField) return emptyOption(theme, 'Heatmap needs a "series" column for the Y axis');
  const valueField = config.y[0]!;
  const xIsTime = columnType(table, config.x) === 'time';
  const label = (v: Scalar) => (xIsTime && typeof v === 'number' ? formatTime(v) : String(v ?? ''));
  const xs = [...new Set(table.rows.map((r) => label(r[config.x] ?? null)))];
  const ys = [...new Set(table.rows.map((r) => String(r[yField] ?? '')))];
  const data: [number, number, number][] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of table.rows) {
    const v = row[valueField];
    if (typeof v !== 'number') continue;
    data.push([xs.indexOf(label(row[config.x] ?? null)), ys.indexOf(String(row[yField] ?? '')), v]);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return {
    ...base,
    tooltip: {
      position: 'top',
      backgroundColor: theme.surface,
      borderColor: theme.axis,
      textStyle: { color: theme.textPrimary },
    },
    grid: { left: 8, right: 16, top: 16, bottom: 48, containLabel: true },
    xAxis: { type: 'category', data: xs, ...axisStyle(theme), splitArea: { show: false } },
    yAxis: { type: 'category', data: ys, ...axisStyle(theme) },
    visualMap: {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      inRange: { color: theme.mode === 'light' ? theme.sequential : [...theme.sequential].reverse() },
      textStyle: { color: theme.muted },
    },
    series: [
      {
        type: 'heatmap',
        data,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: theme.textPrimary, borderWidth: 1 } },
      },
    ],
  };
}

function radarOption(
  config: ChartConfig,
  table: DataTable,
  theme: ChartTheme,
  base: Option,
  opts: ChartBuildOptions,
): Option {
  const rows = table.rows.slice(0, 24);
  const colors = seriesColors(config.y, config.colors, theme, { entityColors: opts.entityColors });
  const indicators = rows.map((r) => {
    const max = Math.max(...config.y.map((y) => (typeof r[y] === 'number' ? (r[y] as number) : 0)));
    return { name: String(r[config.x] ?? ''), max: max > 0 ? max * 1.15 : 1 };
  });
  const globalMax = Math.max(...indicators.map((i) => i.max));
  return {
    ...base,
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.surface,
      borderColor: theme.axis,
      textStyle: { color: theme.textPrimary },
    },
    legend: { show: config.y.length > 1, top: 0, textStyle: { color: theme.textSecondary } },
    radar: {
      indicator: indicators.map((i) => ({ ...i, max: globalMax })),
      axisName: { color: theme.muted },
      splitLine: { lineStyle: { color: theme.grid } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        type: 'radar',
        data: config.y.map((y, i) => ({
          name: y,
          value: rows.map((r) => (typeof r[y] === 'number' ? r[y] : 0)),
          itemStyle: { color: colors[i] },
          areaStyle: { opacity: 0.15 },
          lineStyle: { width: 2 },
        })),
      },
    ],
  };
}

export function buildGaugeOption(
  config: GaugeConfig,
  value: number | null,
  theme: ChartTheme,
  opts: ChartBuildOptions = {},
): Option {
  const range = config.max - config.min || 1;
  const bands = config.bands?.length
    ? config.bands.map((b) => [
        Math.min(Math.max((b.upTo - config.min) / range, 0), 1),
        resolveColor(b.color, theme, 'mark'),
      ])
    : [[1, theme.categorical[0]]];
  return {
    ...baseOption(theme, opts),
    series: [
      {
        type: 'gauge',
        min: config.min,
        max: config.max,
        startAngle: 210,
        endAngle: -30,
        radius: '92%',
        center: ['50%', '58%'],
        progress: {
          show: !config.bands?.length,
          width: 10,
          roundCap: true,
          itemStyle: { color: theme.categorical[0] },
        },
        axisLine: {
          roundCap: true,
          lineStyle: { width: 10, color: config.bands?.length ? bands : [[1, theme.grid]] },
        },
        pointer: {
          show: Boolean(config.bands?.length),
          length: '55%',
          width: 4,
          itemStyle: { color: theme.textSecondary },
        },
        anchor: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '10%'],
          fontSize: 26,
          fontWeight: 600,
          color: theme.textPrimary,
          formatter: (v: number) => formatNumber(v, config.format),
        },
        data: [{ value: value ?? 0 }],
      },
    ],
  };
}
