/** Aggregate functions, shared by the aggregate step and the whole-table expression functions (col_sum …). */
import type { Scalar } from './table.ts';

export const AGGREGATE_OPS = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'stddev',
  'first',
  'last',
] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

export const numeric = (values: Scalar[]) =>
  values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

/** Removes binary floating point noise (0.1 + 0.2) from aggregated results. */
const clean = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 1e9) / 1e9);

export function aggregate(op: AggregateOp, values: Scalar[]): Scalar {
  const result = aggregateRaw(op, values);
  return typeof result === 'number' ? clean(result) : result;
}

function aggregateRaw(op: AggregateOp, values: Scalar[]): Scalar {
  switch (op) {
    case 'count':
      return values.length;
    case 'count_distinct':
      return new Set(values.filter((v) => v !== null)).size;
    case 'first':
      return values.find((v) => v !== null) ?? null;
    case 'last':
      return values.findLast((v) => v !== null) ?? null;
  }
  const ns = numeric(values);
  if (ns.length === 0) return null;
  switch (op) {
    case 'sum':
      return ns.reduce((a, b) => a + b, 0);
    case 'avg':
      return ns.reduce((a, b) => a + b, 0) / ns.length;
    case 'min':
      return ns.reduce((a, b) => (b < a ? b : a));
    case 'max':
      return ns.reduce((a, b) => (b > a ? b : a));
    case 'median': {
      const s = [...ns].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
    case 'stddev': {
      const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
      return Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length);
    }
  }
}
