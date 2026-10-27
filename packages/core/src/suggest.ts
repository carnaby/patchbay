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

export interface SuggestOptions {
  max?: number;
  /**
   * The dataset's own pipeline. Suggested steps are appended to it, so they must not repeat or
   * silently undo what it already does (a user's "newest first" sort, for instance).
   */
  transforms?: readonly TransformInput[];
  /** Epoch ms; injectable so "is this in the future?" is testable. */
  now?: number;
  /** The dataset keeps a rolling history (`accumulate`), so its rows are successive readings of one source. */
  accumulate?: boolean;
}

const DAY = 86_400_000;
/** A bar chart stays readable up to this many bars; above it only the top ones are shown. */
const MAX_BARS = 25;
const TOP_N = 15;
/** Clock skew and "fetched a minute ago" must not make ordinary data look like a forecast. */
const FUTURE_SLACK = 5 * 60_000;

function bucketFor(spanMs: number, rows: number): TimeUnit | null {
  if (rows <= 400) return null;
  if (spanMs > 3 * 365 * DAY) return 'month';
  if (spanMs > 120 * DAY) return 'week';
  if (spanMs > 4 * DAY) return 'day';
  if (spanMs > 6 * 3_600_000) return 'hour';
  return 'minute';
}

const label = (c: ColumnProfile) => c.name.replace(/[._]/g, ' ');

/** How a measure may be summarised across rows, and why, so the rationale can say it. */
export interface MeasureSummary {
  op: 'sum' | 'avg' | 'max' | 'count';
  why: string;
}

const words = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);

const set = (list: string) => new Set(list.split(' '));
/** Only the last word decides here: "customer_id" is an id, "id_count" is an amount. */
const ID_LIKE = set(
  'id uuid guid code zip zipcode postcode phone year yr month week weekday quarter hour rank ranking',
);
const LOG_SCALE = set('magnitude mag richter decibel decibels dba');
const SIZE = set(
  'width height depth thickness diameter radius elevation altitude resolution dpi lat lng lon long',
);
const LEVEL = set(
  'temperature temp celsius fahrenheit kelvin humidity pressure hpa speed velocity kmh mph rate ratio pct percent percentage % share proportion probability score rating stars index aqi avg average mean median density concentration price margin age cover visibility uv ph bpm deg degrees direction bearing heading angle per capita pm10 pm2 pm25 ozone',
);
/**
 * Weather-like readings where a rise is neither good nor bad. Colouring their change green or red would claim a
 * judgement the data does not make, so their KPIs get `goodWhen: "neutral"`.
 */
const NEUTRAL_CHANGE = set(
  'temperature temp celsius fahrenheit kelvin humidity pressure hpa wind direction bearing heading altitude elevation',
);
const neutralChange = (col: ColumnProfile) => words(col.name).some((w) => NEUTRAL_CHANGE.has(w));

/**
 * Decides from the column name whether totals of a measure mean anything. Summing magnitudes,
 * photo widths or temperatures produces a number nobody can read, so those get max/avg instead,
 * and id-like numbers are counted. Names are the only signal that survives every source; the
 * rules are deliberately few and visible so the rationale can quote them.
 */
export function summaryOf(col: ColumnProfile): MeasureSummary {
  const w = words(col.name);
  const last = w[w.length - 1] ?? '';
  if (ID_LIKE.has(last))
    return {
      op: 'count',
      why: `"${col.name}" looks like an identifier, code or calendar number, so rows are counted instead of adding it up`,
    };
  if (w.some((x) => LOG_SCALE.has(x)))
    return {
      op: 'max',
      why: `"${col.name}" is on a logarithmic scale, so values do not add up; the largest one is what stands out`,
    };
  if (w.some((x) => SIZE.has(x)))
    return {
      op: 'avg',
      why: `"${col.name}" is a per-item size or position, so a sum across rows has no meaning; the average does`,
    };
  if (w.some((x) => LEVEL.has(x)))
    return {
      op: 'avg',
      why: `"${col.name}" is a level or ratio (like a temperature, price or percentage), not an amount, so it is averaged instead of summed`,
    };
  return { op: 'sum', why: `"${col.name}" is an amount, so totals add up` };
}

const OP_TITLE = { sum: 'Total', avg: 'Average', max: 'Max', count: 'Count' } as const;

type Order = { field: string; dir: 'asc' | 'desc' }[];

/** The row order a pipeline leaves behind, or null when nothing defines one any more. */
function finalOrder(steps: readonly TransformInput[]): Order | null {
  let order: Order | null = null;
  const touches = (field: string | undefined) => !!field && !!order?.some((o) => o.field === field);
  for (const s of steps) {
    switch (s.type) {
      case 'sort':
        order = s.by.map((b) => ({ field: b.field, dir: b.dir ?? 'asc' }));
        break;
      case 'aggregate':
        order = null;
        break;
      case 'rename':
        if (order)
          order = order.map((o) => ({
            ...o,
            field: Object.hasOwn(s.map, o.field) ? s.map[o.field]! : o.field,
          }));
        break;
      case 'derive':
        if (touches(s.as)) order = null;
        break;
      case 'timeBucket':
        // Truncating the sorted column in place keeps it sorted; writing over another sorted one does not.
        if (s.as && s.as !== s.field && touches(s.as)) order = null;
        break;
      case 'fillNull':
        if (s.fields.some(touches)) order = null;
        break;
      default:
        // filter, select, drop, limit and window keep the row order.
        break;
    }
  }
  return order;
}

/**
 * Chronological order for a time widget: reuse the order the pipeline already has on that field
 * (whether oldest or newest first) instead of appending a sort that repeats or reverses it.
 */
function timeOrder(before: readonly TransformInput[], field: string) {
  const current = finalOrder(before)?.[0];
  if (current?.field === field) return { steps: [] as TransformInput[], dir: current.dir, kept: true };
  const steps: TransformInput[] = [{ type: 'sort', by: [{ field, dir: 'asc' }] }];
  return { steps, dir: 'asc' as const, kept: false };
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'and', 'or', 'not']);
const fieldRef = (name: string) =>
  IDENT.test(name) && !RESERVED.has(name) ? name : `\`${name.replace(/[\\`]/g, '\\$&')}\``;

function duration(ms: number): string {
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY)} days`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The headline KPI for a time series. "Last row" is only "now" when no row lies in the future:
 * over a forecast it would be the end of the forecast, so those rows are filtered out first.
 */
function latestKpi(
  time: ColumnProfile,
  m: ColumnProfile,
  existing: readonly TransformInput[],
  now: number,
): Suggestion {
  const ahead = (time.max ?? Number.NEGATIVE_INFINITY) - now;
  const future = ahead > FUTURE_SLACK;
  const allFuture = future && (time.min ?? Number.POSITIVE_INFINITY) > now + FUTURE_SLACK;
  const steps: TransformInput[] = [];
  if (future && !allFuture) steps.push({ type: 'filter', expr: `${fieldRef(time.name)} <= now()` });
  const order = timeOrder([...existing, ...steps], time.name);
  steps.push(...order.steps);
  const newestLast = order.dir === 'asc';
  // The row closest to now: the newest past row, or the earliest one when everything is ahead.
  const agg = allFuture !== newestLast ? 'last' : 'first';
  // Change vs previous and the sparkline read the rows in order, so they only make sense oldest first.
  const trend = newestLast && !allFuture;
  const title = `${allFuture ? 'Next' : future ? 'Current' : 'Latest'} ${label(m)}`;
  const reasons = [
    trend
      ? 'A time series has a meaningful "current value"; a KPI with change vs the previous point and a sparkline gives the headline.'
      : 'A time series has a meaningful "current value"; a KPI gives the headline.',
  ];
  if (future && !allFuture)
    reasons.push(
      `"${time.name}" runs ${duration(ahead)} into the future (a forecast), so the KPI keeps rows up to now() and shows the one closest to the present instead of the end of the forecast.`,
    );
  if (allFuture)
    reasons.push(
      `Every row of "${time.name}" is in the future (a forecast), so the KPI shows the first upcoming value.`,
    );
  const neutral = trend && neutralChange(m);
  if (neutral)
    reasons.push(
      `A rise in "${m.name}" is neither good nor bad, so the change is shown in a neutral colour (goodWhen "neutral").`,
    );
  if (order.kept && order.dir === 'desc')
    reasons.push(
      `The pipeline already sorts "${time.name}" newest first; that order is kept, so the KPI reads the ${agg} row${trend ? '' : ' and has no change indicator or sparkline'}.`,
    );
  return {
    title,
    rationale: reasons.join(' '),
    widget: {
      type: 'kpi',
      title,
      config: {
        field: m.name,
        agg,
        ...(trend ? { compare: 'previous' as const, sparkline: true } : {}),
        ...(neutral ? { goodWhen: 'neutral' as const } : {}),
      },
    },
    transforms: steps,
    score: 88,
  };
}

/**
 * Coordinates belong on a map. Successive readings of one moving thing (an accumulated "current position", or rows
 * stamped with fetched_at) form a path, drawn as a track in time order; anything else is a set of points.
 */
function mapSuggestion(
  profile: TableProfile,
  options: SuggestOptions,
  lat: ColumnProfile,
  lon: ColumnProfile,
): Suggestion {
  const time = profile.columns.find((c) => c.role === 'time' && c.type === 'time');
  const readings = Boolean(options.accumulate) || profile.columns.some((c) => c.name === 'fetched_at');
  if (time && readings) {
    return {
      title: 'Track',
      rationale: `Latitude and longitude read again and again from one source form a path: a track in "${time.name}" order shows where it went and where it is now, with the night side shaded for the time of the data.`,
      widget: {
        type: 'map',
        title: 'Track',
        config: { lat: lat.name, lon: lon.name, mode: 'track', terminator: true },
      },
      transforms: timeOrder(options.transforms ?? [], time.name).steps,
      score: 85,
    };
  }
  const measure = profile.columns.find(
    (c) => c.role === 'measure' && c.distinct > 1 && summaryOf(c).op !== 'count',
  );
  const name = profile.columns.find((c) => c.role === 'text' || c.role === 'dimension');
  const group = profile.columns.find((c) => c.role === 'dimension' && c.distinct >= 2 && c.distinct <= 3);
  const title = measure ? `${label(measure)} by location` : 'Locations';
  return {
    title,
    rationale: `Latitude and longitude columns belong on a map${measure ? `; dot area shows "${measure.name}", so the largest values stand out` : ''}.`,
    widget: {
      type: 'map',
      title,
      config: {
        lat: lat.name,
        lon: lon.name,
        ...(measure ? { size: measure.name } : {}),
        ...(name ? { label: name.name } : {}),
        ...(group ? { series: group.name } : {}),
      },
    },
    transforms: [],
    score: 70,
  };
}

export function suggestWidgets(profile: TableProfile, options: SuggestOptions = {}): Suggestion[] {
  const max = options.max ?? 6;
  const existing = options.transforms ?? [];
  const now = options.now ?? Date.now();
  const out: Suggestion[] = [];
  const by = (role: ColumnProfile['role']) => profile.columns.filter((c) => c.role === role);
  const times = by('time');
  const measures = by('measure').filter((c) => c.distinct > 1 || profile.rows === 1);
  // Id-like numbers are measures by type only; charting or adding them up shows nothing.
  const values = measures.filter((c) => summaryOf(c).op !== 'count');
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

  if (time && values.length) {
    const span = (time.max ?? 0) - (time.min ?? 0);
    const unit = bucketFor(span, profile.rows);
    const ys = values.slice(0, 3);
    const bucketed: TransformInput[] = unit
      ? [
          { type: 'timeBucket', field: time.name, unit },
          {
            type: 'aggregate',
            groupBy: [time.name],
            metrics: ys.map((m) => ({ op: 'avg' as const, field: m.name, as: m.name })),
          },
        ]
      : [];
    const order = timeOrder([...existing, ...bucketed], time.name);
    const transforms = [...bucketed, ...order.steps];
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
    out.push(latestKpi(time, values[0]!, existing, now));
    if (dims[0] && dims[0].distinct <= 8) {
      out.push({
        title: `${label(values[0]!)} by ${label(dims[0])} over time`,
        rationale: `"${dims[0].name}" has ${dims[0].distinct} categories, so the series can be split per category.`,
        widget: {
          type: 'chart',
          title: `${label(values[0]!)} by ${label(dims[0])}`,
          config: { kind: 'line', x: time.name, y: [values[0]!.name], series: dims[0].name },
        },
        transforms: timeOrder(existing, time.name).steps,
        score: 80,
      });
    }
  }

  for (const dim of dims.slice(0, 2)) {
    const m = values[0];
    const summary = m ? summaryOf(m) : null;
    const y = m ? m.name : 'count';
    // Nulls form their own group in aggregate, so they count as a bar.
    const groups = dim.distinct + (dim.nulls ? 1 : 0);
    const limited = groups > MAX_BARS;
    const what =
      !m || !summary ? 'Count' : summary.op === 'sum' ? label(m) : `${OP_TITLE[summary.op]} ${label(m)}`;
    const title = `${what} by ${label(dim)}${limited ? `: top ${TOP_N} of ${groups}` : ''}`;
    const metric =
      m && summary ? { op: summary.op, field: m.name, as: m.name } : { op: 'count' as const, as: 'count' };
    const compared = !m || !summary ? 'row counts' : `${OP_TITLE[summary.op].toLowerCase()} "${m.name}"`;
    const rationale = [
      `"${dim.name}" is a category with ${groups} values; a sorted bar chart compares ${compared} across them.`,
      summary && summary.op !== 'sum' ? `${summary.why}.` : '',
      limited
        ? `Only the top ${TOP_N} of ${groups} are shown and the other ${groups - TOP_N} are left out; remove the limit step to see all of them.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    out.push({
      title,
      rationale,
      widget: {
        type: 'chart',
        title,
        config: { kind: 'bar', x: dim.name, y: [y], horizontal: groups > 6 },
      },
      transforms: [
        { type: 'aggregate', groupBy: [dim.name], metrics: [metric] },
        { type: 'sort', by: [{ field: y, dir: 'desc' }] },
        ...(limited ? [{ type: 'limit' as const, n: TOP_N }] : []),
      ],
      score: time ? 75 : 92,
    });
    // Shares only exist for amounts: the "share" of an average temperature is meaningless.
    if (m && summary?.op === 'sum' && dim.distinct >= 2 && dim.distinct <= 6) {
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

  // One point (a single weather station, say) is not worth a map.
  if (lat && lon && (lat.distinct > 1 || lon.distinct > 1)) {
    out.push(mapSuggestion(profile, options, lat, lon));
  } else if (!time && values.length >= 2) {
    out.push({
      title: `${label(values[0]!)} vs ${label(values[1]!)}`,
      rationale: 'Two numeric columns without a time axis: a scatter plot reveals correlation.',
      widget: {
        type: 'chart',
        title: `${label(values[0]!)} vs ${label(values[1]!)}`,
        config: { kind: 'scatter', x: values[0]!.name, y: [values[1]!.name] },
      },
      transforms: [],
      score: 65,
    });
  }

  if (!time && values[0]) {
    const m = values[0];
    const summary = summaryOf(m);
    // `values` holds no id-like columns, so this is sum, avg or max.
    const agg = summary.op;
    const title = `${OP_TITLE[agg]} ${label(m)}`;
    out.push({
      title,
      rationale:
        agg === 'sum'
          ? 'A single headline number summarising the main measure.'
          : `A single headline number summarising the main measure. ${summary.why}.`,
      widget: {
        type: 'kpi',
        title,
        config: { field: m.name, agg, ...(agg === 'sum' ? { format: { style: 'compact' as const } } : {}) },
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
