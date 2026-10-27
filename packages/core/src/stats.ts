import type { GaugeConfig, KpiConfig } from './schema.ts';
import type { DataTable } from './table.ts';

export interface KpiResult {
  value: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  /** Whether the change is good, according to `goodWhen`. */
  trend: 'good' | 'bad' | 'flat' | null;
  spark: number[];
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
    else trend = delta > 0 === (config.goodWhen === 'up') ? 'good' : 'bad';
  }
  const spark = config.sparkline ? series.slice(-60) : [];
  return { value, previous, delta, deltaPct, trend, spark };
}

export function computeGauge(config: GaugeConfig, table: DataTable): number | null {
  return reduceColumn(table, config.field, config.agg);
}
