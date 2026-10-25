/**
 * Declarative data-processing pipeline.
 *
 * A pipeline is plain JSON, so it can be stored in a dashboard file, diffed,
 * versioned, and - crucially - written by an AI agent and validated before it
 * ever runs. Each step is a pure `DataTable -> DataTable` function.
 */
import { z } from 'zod';
import { compile, ExprError, isTruthy, parse, referencedFields } from './expr.ts';
import { type ColumnType, type DataTable, type Row, retype, type Scalar } from './table.ts';

const field = z.string().min(1).max(200);
const expression = z
  .string()
  .min(1)
  .max(2000)
  .superRefine((src, ctx) => {
    try {
      parse(src);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof ExprError ? e.message : 'Invalid expression' });
    }
  });

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

export const TIME_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

export const WINDOW_OPS = ['rolling_avg', 'rolling_sum', 'cumsum', 'diff', 'pct_change', 'rank'] as const;

/**
 * Steps carry a stable id so edits can address "the filter step" rather than
 * "step #3": concurrent changes to different steps then merge instead of one
 * overwriting the other. Ids are filled in automatically when missing.
 */
export const StepIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Step ids are 1-40 chars of a-z, 0-9, "_" or "-"');

export const TransformSchema = z.discriminatedUnion('type', [
  z
    .object({ id: StepIdSchema.optional(), type: z.literal('filter'), expr: expression })
    .describe('Keep rows where the expression is truthy, e.g. `mag >= 4 && contains(place, "Japan")`'),
  z
    .object({ id: StepIdSchema.optional(), type: z.literal('select'), fields: z.array(field).min(1) })
    .describe('Keep only these columns, in order'),
  z
    .object({ id: StepIdSchema.optional(), type: z.literal('drop'), fields: z.array(field).min(1) })
    .describe('Remove these columns'),
  z
    .object({ id: StepIdSchema.optional(), type: z.literal('rename'), map: z.record(field, field) })
    .describe('Rename columns: { "old": "new" }'),
  z
    .object({ id: StepIdSchema.optional(), type: z.literal('derive'), as: field, expr: expression })
    .describe('Add or overwrite a column computed per row, e.g. `round(price * qty, 2)`'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('sort'),
      by: z.array(z.object({ field, dir: z.enum(['asc', 'desc']).default('asc') })).min(1),
    })
    .describe('Sort rows'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('limit'),
      n: z.number().int().min(1).max(100_000),
      from: z.enum(['start', 'end']).default('start'),
    })
    .describe('Keep the first (or last) n rows'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('aggregate'),
      groupBy: z.array(field).default([]),
      metrics: z
        .array(z.object({ op: z.enum(AGGREGATE_OPS), field: field.optional(), as: field.optional() }))
        .min(1),
    })
    .describe('Group rows and compute metrics; `count` needs no field'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('timeBucket'),
      field,
      unit: z.enum(TIME_UNITS),
      as: field.optional(),
    })
    .describe('Truncate a time column to the start of its bucket (UTC), usually followed by aggregate'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('window'),
      op: z.enum(WINDOW_OPS),
      field,
      as: field.optional(),
      size: z.number().int().min(2).max(1000).optional(),
      partitionBy: z.array(field).optional(),
    })
    .describe('Running calculations in current row order (sort first)'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('fillNull'),
      fields: z.array(field).min(1),
      value: z.union([z.number(), z.string(), z.boolean()]),
    })
    .describe('Replace nulls with a constant'),
]);

export type Transform = z.infer<typeof TransformSchema>;
export type TransformInput = z.input<typeof TransformSchema>;

export class TransformError extends Error {
  readonly step: number;
  constructor(message: string, step: number) {
    super(`Step ${step + 1}: ${message}`);
    this.name = 'TransformError';
    this.step = step;
  }
}

const numeric = (values: Scalar[]) =>
  values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

/** Removes binary floating point noise (0.1 + 0.2) from aggregated results. */
const clean = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 1e9) / 1e9);

function aggregate(op: AggregateOp, values: Scalar[]): Scalar {
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

/** Start of the UTC bucket containing `ms`. Weeks start on Monday (ISO). */
export function bucketStart(ms: number, unit: TimeUnit): number {
  const d = new Date(ms);
  switch (unit) {
    case 'minute':
      return Math.floor(ms / 60_000) * 60_000;
    case 'hour':
      return Math.floor(ms / 3_600_000) * 3_600_000;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return day - ((d.getUTCDay() + 6) % 7) * 86_400_000;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

function typesOf(table: DataTable): Record<string, ColumnType> {
  return Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
}

function requireFields(table: DataTable, fields: (string | undefined)[], step: number) {
  const names = new Set(table.columns.map((c) => c.name));
  for (const f of fields) {
    if (f !== undefined && !names.has(f)) {
      throw new TransformError(
        `Unknown column "${f}". Available: ${[...names].join(', ') || '(none)'}`,
        step,
      );
    }
  }
}

function compareScalars(a: Scalar, b: Scalar): number {
  if (a === b) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function applyStep(table: DataTable, t: Transform, step: number): DataTable {
  const known = typesOf(table);
  const order = table.columns.map((c) => c.name);
  switch (t.type) {
    case 'filter': {
      requireFields(table, [...referencedFields(parse(t.expr))], step);
      const fn = compile(t.expr);
      return { columns: table.columns, rows: table.rows.filter((r) => isTruthy(fn(r))) };
    }
    case 'select': {
      requireFields(table, t.fields, step);
      return {
        columns: t.fields.map((f) => table.columns.find((c) => c.name === f)!),
        rows: table.rows.map((r) => Object.fromEntries(t.fields.map((f) => [f, r[f] ?? null]))),
      };
    }
    case 'drop': {
      const dropped = new Set(t.fields);
      const keep = table.columns.filter((c) => !dropped.has(c.name));
      return {
        columns: keep,
        rows: table.rows.map((r) => Object.fromEntries(keep.map((c) => [c.name, r[c.name] ?? null]))),
      };
    }
    case 'rename': {
      requireFields(table, Object.keys(t.map), step);
      const to = (n: string) => t.map[n] ?? n;
      return {
        columns: table.columns.map((c) => ({ ...c, name: to(c.name) })),
        rows: table.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [to(k), v]))),
      };
    }
    case 'derive': {
      requireFields(table, [...referencedFields(parse(t.expr))], step);
      const fn = compile(t.expr);
      const rows = table.rows.map((r) => ({ ...r, [t.as]: fn(r) }));
      const nextOrder = order.includes(t.as) ? order : [...order, t.as];
      const { [t.as]: _replaced, ...rest } = known;
      return retype(rows, nextOrder, rest);
    }
    case 'sort': {
      requireFields(
        table,
        t.by.map((b) => b.field),
        step,
      );
      const rows = [...table.rows].sort((a, b) => {
        for (const { field: f, dir } of t.by) {
          const c = compareScalars(a[f] ?? null, b[f] ?? null);
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
        return 0;
      });
      return { columns: table.columns, rows };
    }
    case 'limit':
      return {
        columns: table.columns,
        rows: t.from === 'end' ? table.rows.slice(-t.n) : table.rows.slice(0, t.n),
      };
    case 'aggregate': {
      requireFields(table, [...t.groupBy, ...t.metrics.map((m) => m.field)], step);
      for (const m of t.metrics) {
        if (m.op !== 'count' && !m.field) throw new TransformError(`Metric "${m.op}" needs a field`, step);
      }
      const groups = new Map<string, Row[]>();
      for (const row of table.rows) {
        const key = JSON.stringify(t.groupBy.map((g) => row[g] ?? null));
        let bucket = groups.get(key);
        if (!bucket) {
          bucket = [];
          groups.set(key, bucket);
        }
        bucket.push(row);
      }
      if (groups.size === 0 && t.groupBy.length === 0) groups.set('[]', []);
      const metricName = (m: (typeof t.metrics)[number]) => m.as ?? (m.field ? `${m.op}_${m.field}` : m.op);
      const rows: Row[] = [...groups.values()].map((bucket) => {
        const out: Row = {};
        for (const g of t.groupBy) out[g] = bucket[0]?.[g] ?? null;
        for (const m of t.metrics) {
          out[metricName(m)] = aggregate(
            m.op,
            m.field ? bucket.map((r) => r[m.field!] ?? null) : bucket.map(() => 1),
          );
        }
        return out;
      });
      const keepTypes: Record<string, ColumnType> = {};
      for (const g of t.groupBy) if (known[g]) keepTypes[g] = known[g];
      for (const m of t.metrics) {
        if (
          m.field &&
          known[m.field] === 'time' &&
          ['min', 'max', 'first', 'last', 'median'].includes(m.op)
        ) {
          keepTypes[metricName(m)] = 'time';
        }
      }
      return retype(rows, [...t.groupBy, ...t.metrics.map(metricName)], keepTypes);
    }
    case 'timeBucket': {
      requireFields(table, [t.field], step);
      if (known[t.field] !== 'time' && known[t.field] !== 'number') {
        throw new TransformError(`Column "${t.field}" is not a time column`, step);
      }
      const as = t.as ?? t.field;
      const rows = table.rows.map((r) => {
        const v = r[t.field];
        return { ...r, [as]: typeof v === 'number' ? bucketStart(v, t.unit) : null };
      });
      return retype(rows, order.includes(as) ? order : [...order, as], { ...known, [as]: 'time' });
    }
    case 'window': {
      requireFields(table, [t.field, ...(t.partitionBy ?? [])], step);
      const as = t.as ?? `${t.op}_${t.field}`;
      const size = t.size ?? 7;
      const partitions = new Map<string, number[]>();
      table.rows.forEach((r, i) => {
        const key = JSON.stringify((t.partitionBy ?? []).map((p) => r[p] ?? null));
        let list = partitions.get(key);
        if (!list) {
          list = [];
          partitions.set(key, list);
        }
        list.push(i);
      });
      const result: Scalar[] = new Array(table.rows.length).fill(null);
      for (const indexes of partitions.values()) {
        const values = indexes.map((i) => {
          const v = table.rows[i]![t.field];
          return typeof v === 'number' ? v : null;
        });
        let running = 0;
        // Descending sorted copy for rank: rank = 1 + number of strictly greater values.
        const desc =
          t.op === 'rank' ? values.filter((x): x is number => x !== null).sort((a, b) => b - a) : [];
        const rankOf = (v: number) => {
          let lo = 0;
          let hi = desc.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (desc[mid]! > v) lo = mid + 1;
            else hi = mid;
          }
          return lo + 1;
        };
        values.forEach((v, j) => {
          const target = indexes[j]!;
          switch (t.op) {
            case 'cumsum':
              running += v ?? 0;
              result[target] = running;
              break;
            case 'diff': {
              const prev = values[j - 1];
              result[target] = v !== null && prev !== null && prev !== undefined ? v - prev : null;
              break;
            }
            case 'pct_change': {
              const prev = values[j - 1];
              result[target] = v !== null && prev ? ((v - prev) / Math.abs(prev)) * 100 : null;
              break;
            }
            case 'rank': {
              // Precomputed below in O(n log n); a per-row scan would be O(n²).
              result[target] = v === null ? null : rankOf(v);
              break;
            }
            default: {
              const win = numeric(values.slice(Math.max(0, j - size + 1), j + 1));
              const sum = win.reduce((a, b) => a + b, 0);
              result[target] = win.length === 0 ? null : t.op === 'rolling_sum' ? sum : sum / win.length;
            }
          }
        });
      }
      const rows = table.rows.map((r, i) => ({ ...r, [as]: result[i] ?? null }));
      return retype(rows, order.includes(as) ? order : [...order, as], known);
    }
    case 'fillNull': {
      requireFields(table, t.fields, step);
      const rows = table.rows.map((r) => {
        const out = { ...r };
        for (const f of t.fields) if (out[f] === null || out[f] === undefined) out[f] = t.value;
        return out;
      });
      return retype(rows, order, known);
    }
  }
}

export interface PipelineResult {
  table: DataTable;
  /** Row count after each step - handy for explaining a pipeline to a human or an agent. */
  trace: { step: number; type: Transform['type']; rows: number }[];
}

/** Hard limits per pipeline run, so a hostile or careless pipeline cannot stall the server. */
export const PIPELINE_LIMITS = { maxCells: 5_000_000, maxMillis: 3_000 };

export function runPipeline(input: DataTable, transforms: Transform[]): PipelineResult {
  let table = input;
  const trace: PipelineResult['trace'] = [];
  const started = Date.now();
  transforms.forEach((t, i) => {
    if (Date.now() - started > PIPELINE_LIMITS.maxMillis) {
      throw new TransformError(
        `Processing took longer than ${PIPELINE_LIMITS.maxMillis / 1000} s; simplify the rules or filter earlier`,
        i,
      );
    }
    if (table.rows.length * Math.max(table.columns.length, 1) > PIPELINE_LIMITS.maxCells) {
      throw new TransformError('Too much data to process; filter or aggregate earlier', i);
    }
    try {
      table = applyStep(table, t, i);
    } catch (e) {
      if (e instanceof TransformError) throw e;
      throw new TransformError(e instanceof Error ? e.message : String(e), i);
    }
    trace.push({ step: i, type: t.type, rows: table.rows.length });
  });
  return { table, trace };
}

/** Gives every step without an id a deterministic one (`s1`, `s2`, ...), unique within the pipeline. */
export function withStepIds<T extends { id?: string | undefined }>(steps: T[]): (T & { id: string })[] {
  const taken = new Set(steps.map((s) => s.id).filter((id): id is string => Boolean(id)));
  let n = 1;
  return steps.map((step) => {
    if (step.id) return step as T & { id: string };
    while (taken.has(`s${n}`)) n++;
    const id = `s${n}`;
    taken.add(id);
    return { ...step, id };
  });
}
