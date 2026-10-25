/**
 * A deterministic, explainable suggestion engine.
 *
 * Given a dataset profile it proposes widgets (and any extra transforms they
 * need). It runs without an LLM so the editor can offer good defaults to every
 * visitor for free; an MCP agent gets the same suggestions plus the profile and
 * can refine them with its own judgement.
 */
import type { ColumnProfile, TableProfile } from './profile.ts';
import type { WidgetInput } from './schema.ts';
import type { TimeUnit, TransformInput } from './transforms.ts';

export interface Suggestion {
  title: string;
  rationale: string;
  /** Widget without an id; the caller assigns one. */
  widget: Omit<WidgetInput, 'id' | 'datasetId'> & { datasetId?: string };
  /** Extra steps appended to the dataset's pipeline, materialised as a derived dataset. */
  transforms: TransformInput[];
  score: number;
}

const DAY = 86_400_000;

function bucketFor(spanMs: number, rows: number): TimeUnit | null {
  if (rows <= 400) return null;
  if (spanMs > 3 * 365 * DAY) return 'month';
  if (spanMs > 120 * DAY) return 'week';
  if (spanMs > 4 * DAY) return 'day';
  if (spanMs > 6 * 3_600_000) return 'hour';
  return 'minute';
}

const label = (c: ColumnProfile) => c.name.replace(/[._]/g, ' ');

export function suggestWidgets(profile: TableProfile, max = 6): Suggestion[] {
  const out: Suggestion[] = [];
  const by = (role: ColumnProfile['role']) => profile.columns.filter((c) => c.role === role);
  const times = by('time');
  const measures = by('measure').filter((c) => c.distinct > 1 || profile.rows === 1);
  const dims = by('dimension').filter((c) => c.distinct >= 2);
  const lat = by('latitude')[0];
  const lon = by('longitude')[0];
  const time = times[0];

  if (profile.rows === 0) return [];

  // A single row is a set of headline numbers, not a chart.
  if (profile.rows === 1) {
    for (const m of by('measure').slice(0, 4)) {
      out.push({
        title: label(m),
        rationale: 'The dataset has a single row, so each number is best shown as a KPI tile.',
        widget: { type: 'kpi', title: label(m), config: { field: m.name, agg: 'last' } },
        transforms: [],
        score: 90,
      });
    }
    return out.slice(0, max);
  }

  if (time && measures.length) {
    const span = (time.max ?? 0) - (time.min ?? 0);
    const unit = bucketFor(span, profile.rows);
    const ys = measures.slice(0, 3);
    const transforms: TransformInput[] = unit
      ? [
          { type: 'timeBucket', field: time.name, unit },
          {
            type: 'aggregate',
            groupBy: [time.name],
            metrics: ys.map((m) => ({ op: 'avg' as const, field: m.name, as: m.name })),
          },
          { type: 'sort', by: [{ field: time.name, dir: 'asc' }] },
        ]
      : [{ type: 'sort', by: [{ field: time.name, dir: 'asc' }] }];
    // Several measures on one axis only make sense with a comparable scale.
    const comparable = ys.filter((m) => {
      const ref = ys[0]!;
      const a = Math.abs(ref.max ?? 0) || 1;
      const b = Math.abs(m.max ?? 0) || 1;
      return Math.max(a, b) / Math.min(a, b) < 10;
    });
    out.push({
      title: `${comparable.map(label).join(', ')} over time`,
      rationale: `"${time.name}" is a time column and ${comparable.length > 1 ? 'these measures share a scale' : `"${comparable[0]!.name}" is numeric`}, so a line chart shows the trend.${unit ? ` ${profile.rows} rows are bucketed by ${unit} to keep it readable.` : ''}`,
      widget: {
        type: 'chart',
        title: `${comparable.map(label).join(', ')} over time`,
        config: { kind: 'line', x: time.name, y: comparable.map((m) => m.name) },
      },
      transforms,
      score: 95,
    });
    const headline = measures[0]!;
    out.push({
      title: `Latest ${label(headline)}`,
      rationale:
        'A time series has a meaningful "current value"; a KPI with change vs the previous point and a sparkline gives the headline.',
      widget: {
        type: 'kpi',
        title: `Latest ${label(headline)}`,
        config: { field: headline.name, agg: 'last', compare: 'previous', sparkline: true },
      },
      transforms: [{ type: 'sort', by: [{ field: time.name, dir: 'asc' }] }],
      score: 88,
    });
    if (dims[0] && dims[0].distinct <= 8) {
      out.push({
        title: `${label(measures[0]!)} by ${label(dims[0])} over time`,
        rationale: `"${dims[0].name}" has ${dims[0].distinct} categories, so the series can be split per category.`,
        widget: {
          type: 'chart',
          title: `${label(measures[0]!)} by ${label(dims[0])}`,
          config: { kind: 'line', x: time.name, y: [measures[0]!.name], series: dims[0].name },
        },
        transforms: [{ type: 'sort', by: [{ field: time.name, dir: 'asc' }] }],
        score: 80,
      });
    }
  }

  for (const dim of dims.slice(0, 2)) {
    const m = measures[0];
    const transforms: TransformInput[] = m
      ? [
          { type: 'aggregate', groupBy: [dim.name], metrics: [{ op: 'sum', field: m.name, as: m.name }] },
          { type: 'sort', by: [{ field: m.name, dir: 'desc' }] },
          { type: 'limit', n: 15 },
        ]
      : [
          { type: 'aggregate', groupBy: [dim.name], metrics: [{ op: 'count', as: 'count' }] },
          { type: 'sort', by: [{ field: 'count', dir: 'desc' }] },
          { type: 'limit', n: 15 },
        ];
    const y = m ? m.name : 'count';
    out.push({
      title: `${m ? label(m) : 'Count'} by ${label(dim)}`,
      rationale: `"${dim.name}" is a category with ${dim.distinct} values; a sorted bar chart compares ${m ? `total "${m.name}"` : 'row counts'} across them.`,
      widget: {
        type: 'chart',
        title: `${m ? label(m) : 'Count'} by ${label(dim)}`,
        config: { kind: 'bar', x: dim.name, y: [y], horizontal: dim.distinct > 6 },
      },
      transforms,
      score: time ? 75 : 92,
    });
    if (m && dim.distinct >= 2 && dim.distinct <= 6) {
      out.push({
        title: `Share of ${label(m)} by ${label(dim)}`,
        rationale: `Only ${dim.distinct} categories, so a donut can show part-to-whole at a glance.`,
        widget: {
          type: 'chart',
          title: `Share of ${label(m)}`,
          config: { kind: 'donut', x: dim.name, y: [m.name] },
        },
        transforms: [
          { type: 'aggregate', groupBy: [dim.name], metrics: [{ op: 'sum', field: m.name, as: m.name }] },
        ],
        score: 60,
      });
    }
  }

  if (lat && lon) {
    out.push({
      title: 'Locations',
      rationale: 'Latitude and longitude columns can be plotted as a scatter map.',
      widget: {
        type: 'chart',
        title: 'Locations',
        config: {
          kind: 'scatter',
          x: lon.name,
          y: [lat.name],
          ...(dims[0] && dims[0].distinct <= 3 ? { series: dims[0].name } : {}),
        },
      },
      transforms: [],
      score: 70,
    });
  } else if (!time && measures.length >= 2) {
    out.push({
      title: `${label(measures[0]!)} vs ${label(measures[1]!)}`,
      rationale: 'Two numeric columns without a time axis: a scatter plot reveals correlation.',
      widget: {
        type: 'chart',
        title: `${label(measures[0]!)} vs ${label(measures[1]!)}`,
        config: { kind: 'scatter', x: measures[0]!.name, y: [measures[1]!.name] },
      },
      transforms: [],
      score: 65,
    });
  }

  if (!time && measures[0]) {
    out.push({
      title: `Total ${label(measures[0])}`,
      rationale: 'A single headline number summarising the main measure.',
      widget: {
        type: 'kpi',
        title: `Total ${label(measures[0])}`,
        config: { field: measures[0].name, agg: 'sum', format: { style: 'compact' } },
      },
      transforms: [],
      score: 55,
    });
  }

  out.push({
    title: 'Raw data',
    rationale: 'A table is always a faithful view and an accessible alternative to charts.',
    widget: { type: 'table', title: 'Data', config: { pageSize: 25 } },
    transforms: [],
    score: 30,
  });

  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
