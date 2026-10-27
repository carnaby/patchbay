import { bandFor } from './colors.ts';
import type { ChartConfig, GaugeConfig, KpiConfig, ReferenceLine } from './schema.ts';
import type { DataTable } from './table.ts';
import type { Color } from './theme.ts';

export interface KpiResult {
  value: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  /**
   * Whether the change is good, according to `goodWhen`. "neutral": it changed, but up is neither good nor bad
   * (`goodWhen: "neutral"`), so it is shown muted and the arrow alone carries the direction.
   */
  trend: 'good' | 'bad' | 'flat' | 'neutral' | null;
  spark: number[];
  /** The colour of the value from `bands`; null when uncoloured. */
  valueColor: Color | null;
}

type Agg = KpiConfig['agg'];

/**
 * `count` without a field counts rows; with one, the rows where that field has a value (any type), like COUNT(col)
 * in SQL. Every other aggregate reads the field's numbers; the schema guarantees there is a field for them.
 */
export function reduceColumn(table: DataTable, field: string | undefined, agg: Agg): number | null {
  if (agg === 'count') {
    if (field === undefined) return table.rows.length;
    return table.rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
  }
  if (field === undefined) return null;
  const values = table.rows
    .map((r) => r[field])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  switch (agg) {
    case 'last':
      return values[values.length - 1]!;
    case 'first':
      return values[0]!;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

export function computeKpi(config: KpiConfig, table: DataTable): KpiResult {
  const field = config.field;
  const series =
    field === undefined
      ? []
      : table.rows
          .map((r) => r[field])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const value = reduceColumn(table, config.field, config.agg);
  let previous: number | null = null;
  if (config.compare === 'previous') previous = series.length >= 2 ? series[series.length - 2]! : null;
  if (config.compare === 'first') previous = series.length >= 2 ? series[0]! : null;
  const delta = value !== null && previous !== null ? value - previous : null;
  const deltaPct = delta !== null && previous ? (delta / Math.abs(previous)) * 100 : null;
  let trend: KpiResult['trend'] = null;
  if (delta !== null) {
    if (delta === 0) trend = 'flat';
    else if (config.goodWhen === 'neutral') trend = 'neutral';
    else trend = delta > 0 === (config.goodWhen === 'up') ? 'good' : 'bad';
  }
  const spark = config.sparkline ? series.slice(-60) : [];
  const valueColor = bandFor(config.bands, value)?.color ?? null;
  return { value, previous, delta, deltaPct, trend, spark, valueColor };
}

/**
 * Where a reference line sits: its constant, or a statistic of one of the plotted columns over the rows the chart
 * draws, with the same numeric rules as KPIs (non-numbers are skipped), so browser, snapshot and MCP data agree.
 */
export function referenceLineValue(
  line: ReferenceLine,
  config: ChartConfig,
  table: DataTable,
): number | null {
  if (line.value !== undefined) return line.value;
  if (!line.stat) return null;
  const field = line.field ?? config.y[0];
  if (line.stat !== 'median') return reduceColumn(table, field, line.stat);
  if (field === undefined) return null;
  const values = table.rows
    .map((r) => r[field])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

export function computeGauge(config: GaugeConfig, table: DataTable): number | null {
  return reduceColumn(table, config.field, config.agg);
}
