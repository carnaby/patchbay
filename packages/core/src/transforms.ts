/**
 * Declarative data-processing pipeline.
 *
 * A pipeline is plain JSON, so it can be stored in a dashboard file, diffed,
 * versioned, and - crucially - written by an AI agent and validated before it
 * ever runs. Each step is a pure `DataTable -> DataTable` function.
 */
import { z } from 'zod';
import { AGGREGATE_OPS, aggregate, numeric } from './aggregate.ts';
import {
  compileFor,
  ExprError,
  fieldRef,
  isTruthy,
  MAX_BOUND_EXPRESSION,
  parse,
  referencedFields,
} from './expr.ts';
import { IdSchema } from './ids.ts';
import { type ColumnType, cellOf, type DataTable, type Row, retype, type Scalar, setCell } from './table.ts';

const field = z.string().min(1).max(200);
/** An expression that parses; shared with table rules so they validate exactly like pipeline steps. */
export const ExpressionSchema = z
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
const expression = ExpressionSchema;

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
      // Optional rather than defaulted, so the steps of existing documents do not all gain a `false` on the next save.
      dropPartial: z.boolean().optional(),
    })
    .describe(
      'Truncate a time column to the start of its bucket (UTC), usually followed by aggregate; dropPartial skips partial edge buckets',
    ),
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
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('join'),
      with: IdSchema,
      on: z
        .array(z.union([field, z.strictObject({ left: field, right: field })]))
        .min(1)
        .max(4),
      how: z.enum(['left', 'inner']).default('left'),
      fields: z.array(field).max(40).optional(),
    })
    .describe('Add columns from another dataset of this dashboard where the keys match'),
  z
    .object({
      id: StepIdSchema.optional(),
      type: z.literal('union'),
      with: z.array(IdSchema).min(1).max(4),
      origin: field.optional(),
      labels: z.record(IdSchema, z.string().min(1).max(80)).optional(),
    })
    .describe('Append the rows of other datasets of this dashboard; columns are matched by name'),
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

/** Start of the bucket after the one starting at `start`. */
export function bucketEnd(start: number, unit: TimeUnit): number {
  const d = new Date(start);
  switch (unit) {
    case 'minute':
      return start + 60_000;
    case 'hour':
      return start + 3_600_000;
    case 'day':
      return start + 86_400_000;
    case 'week':
      return start + 7 * 86_400_000;
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}

/**
 * Starts of the first and last bucket when the data does not cover them. A rolling 7-day window bucketed by day has
 * 8 buckets, the first and the last only partly filled, and the last one looks like a sudden drop.
 *
 * The data cannot say what it was cut from, so its own rhythm decides: with the sampling interval taken as the median
 * gap between distinct times, the first bucket is partial when the data starts at least one interval after the
 * bucket starts (the reading before it would have fallen inside), the last when it ends more than one interval
 * before the bucket ends (the next reading would still have fallen inside). Fewer than two distinct times give no
 * rhythm, and nothing is dropped.
 */
function partialEdgeBuckets(rows: Row[], field: string, unit: TimeUnit): Set<number> {
  const times = [
    ...new Set(rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number')),
  ].sort((a, b) => a - b);
  const partial = new Set<number>();
  if (times.length < 2) return partial;
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .sort((a, b) => a - b);
  const interval = gaps[gaps.length >> 1]!;
  const first = times[0]!;
  const last = times[times.length - 1]!;
  const firstStart = bucketStart(first, unit);
  const lastStart = bucketStart(last, unit);
  if (first - firstStart >= interval) partial.add(firstStart);
  if (bucketEnd(lastStart, unit) - last > interval) partial.add(lastStart);
  return partial;
}

function typesOf(table: DataTable): Record<string, ColumnType> {
  return Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
}

/** How one step treats a column the table lacks: lenient only on an open input that still has no rows (runPipeline). */
interface FieldCheck {
  lenient: boolean;
  /** Columns the step read without checking, in the trace entry. */
  unchecked: string[];
}

function requireFields(table: DataTable, fields: (string | undefined)[], step: number, check: FieldCheck) {
  const names = new Set(table.columns.map((c) => c.name));
  for (const f of fields) {
    if (f !== undefined && !names.has(f)) {
      if (check.lenient) {
        if (!check.unchecked.includes(f)) check.unchecked.push(f);
        continue;
      }
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

/**
 * Approximate size of a cell in the table's JSON: the key with its quotes, colon and comma, then the value (text with
 * its quotes, or a typical number). JSON is what every result becomes, and it tracks memory closely enough: V8 keeps
 * text at one or two bytes per character, a number or a reference at eight to sixteen bytes.
 */
function cellSize(name: string, value: Scalar | undefined): number {
  return name.length + 4 + (typeof value === 'string' ? value.length + 2 : 6);
}

/** Approximate size of a table as JSON, in characters; see `PIPELINE_LIMITS.maxSize`. */
export function tableSize(table: DataTable): number {
  let size = 0;
  for (const row of table.rows) for (const c of table.columns) size += cellSize(c.name, row[c.name]);
  return size;
}

const millionChars = (n: number) => `${(n / 1_000_000).toLocaleString('en')} million characters`;

const tooSlow = (step: number) =>
  new TransformError(
    `Processing took longer than ${PIPELINE_LIMITS.maxMillis / 1000} s; simplify the rules or filter earlier`,
    step,
  );

/**
 * Size and time of the table a run is building. Heavy steps charge every value as they produce it, so one step
 * cannot allocate far past the limit (or run far past the deadline) before anyone checks.
 */
class RunBudget {
  /** Size of the table the current step starts from, then of the one it is building. */
  size = 0;
  step = 0;
  private readonly deadline: number;

  constructor(deadline: number) {
    this.deadline = deadline;
  }

  add(n: number) {
    this.size += n;
    if (this.size > PIPELINE_LIMITS.maxSize) {
      throw new TransformError(
        `The data grew past ${millionChars(PIPELINE_LIMITS.maxSize)} (about its size as JSON); filter, aggregate ` +
          'or limit rows earlier, keep fewer columns (select or drop), or shorten text with substr()',
        this.step,
      );
    }
    this.tick();
  }

  /** Date.now() costs tens of nanoseconds, far less than the row copy or expression it accompanies. */
  tick() {
    if (Date.now() > this.deadline) throw tooSlow(this.step);
  }

  /** Fails before a step adds `extra` characters, without allocating them first. */
  ensure(extra: number) {
    this.add(extra);
    this.size -= extra;
  }

  /** Re-measures after a step that cannot grow its input by more than a bounded amount. */
  measure(table: DataTable): DataTable {
    this.size = 0;
    this.add(tableSize(table));
    return table;
  }
}

export type JoinKeyInput = string | { left: string; right: string };

/** A join's keys as pairs; a plain name means the same column on both sides. */
export function joinKeys(on: readonly JoinKeyInput[]): { left: string; right: string }[] {
  return on.map((k) => (typeof k === 'string' ? { left: k, right: k } : { left: k.left, right: k.right }));
}

/**
 * The columns a join brings, in order: `fields`, or every column of the other side except its keys. A name this side
 * already has gets `_<dataset id>` (and a number if that is taken too), so nothing is overwritten silently.
 */
export function joinedColumns(
  left: readonly string[],
  right: readonly string[],
  step: { with: string; on: readonly JoinKeyInput[]; fields?: readonly string[] | undefined },
): { name: string; from: string }[] {
  const rightKeys = new Set(joinKeys(step.on).map((k) => k.right));
  const wanted = step.fields ?? right.filter((c) => !rightKeys.has(c));
  const taken = new Set(left);
  return wanted.map((from) => {
    let name = taken.has(from) ? `${from}_${step.with}` : from;
    for (let n = 2; taken.has(name); n++) name = `${from}_${step.with}_${n}`;
    taken.add(name);
    return { name, from };
  });
}

/** The columns of a union: every name in the order first seen, then the origin column. */
export function unionColumns(tables: readonly (readonly string[])[], origin?: string): string[] {
  const names = [...new Set(tables.flat())];
  return origin ? [...names, origin] : names;
}

/**
 * The other datasets' processed tables that join and union steps read, resolved by the caller before the run so a
 * worker stays a pure function of its message. `self` names the rows the pipeline starts with, for union's origin
 * column: the parent of a derived dataset, otherwise the dataset itself.
 */
export interface PipelineInputs {
  /** open: no rows, from a source that returned none (see runPipeline); when absent, whether the table has no rows. */
  tables: Record<string, { name: string; table: DataTable; open?: boolean }>;
  self: { id: string; name: string };
}

const TYPE_WORDS: Record<ColumnType, string> = {
  number: 'a number',
  string: 'text',
  boolean: 'true/false',
  time: 'a time',
};

/** Times are epoch numbers at runtime, and date() makes a number column: they compare as the same type. */
const sameKeyType = (a: ColumnType, b: ColumnType) =>
  a === b || (a !== 'string' && a !== 'boolean' && b !== 'string' && b !== 'boolean');

/** The derive that makes two key columns comparable: the text side takes the other side's type. */
function keyConversion(k: { left: string; right: string }, mine: ColumnType, theirs: ColumnType): string {
  if (mine === 'string' || theirs === 'string') {
    const text = mine === 'string' ? k.left : k.right;
    const target = mine === 'string' ? theirs : mine;
    if (target === 'time') return `date(${fieldRef(text)})`;
    if (target === 'number') return `number(${fieldRef(text)})`;
    return `string(${fieldRef(mine === 'boolean' ? k.left : k.right)})`;
  }
  return `number(${fieldRef(mine === 'boolean' ? k.left : k.right)})`;
}

function inputTable(inputs: PipelineInputs | undefined, id: string, step: number) {
  if (!inputs)
    throw new TransformError(
      'Steps that read other datasets (join, union) only run inside their dashboard',
      step,
    );
  // Own properties only: "constructor" is a valid dataset id.
  if (!Object.hasOwn(inputs.tables, id))
    throw new TransformError(`Dataset "${id}" is not available here`, step);
  return inputs.tables[id]!;
}

function requireFieldsIn(
  table: DataTable,
  fields: readonly string[],
  datasetId: string,
  step: number,
  check: FieldCheck,
  otherOpen: boolean,
) {
  const names = new Set(table.columns.map((c) => c.name));
  for (const f of fields) {
    if (!names.has(f)) {
      // The other side's own openness decides, whatever this table is: its columns are known once it had rows.
      if (otherOpen) {
        const name = `${datasetId}.${f}`;
        if (!check.unchecked.includes(name)) check.unchecked.push(name);
        continue;
      }
      throw new TransformError(
        `Unknown column "${f}" in "${datasetId}". Available: ${[...names].join(', ') || '(none)'}`,
        step,
      );
    }
  }
}

const rowCap = () => PIPELINE_LIMITS.maxRows.toLocaleString('en');

/** Filter and derive steps run with filter values bound in, which may make them longer than an authored expression. */
const BOUND = { maxLength: MAX_BOUND_EXPRESSION };

function applyStep(
  table: DataTable,
  t: Transform,
  step: number,
  budget: RunBudget,
  inputs: PipelineInputs | undefined,
  check: FieldCheck,
): DataTable {
  const known = typesOf(table);
  const order = table.columns.map((c) => c.name);
  switch (t.type) {
    case 'filter': {
      requireFields(table, [...referencedFields(parse(t.expr, BOUND))], step, check);
      const fn = compileFor(t.expr, table, () => budget.tick(), BOUND);
      return budget.measure({
        columns: table.columns,
        rows: table.rows.filter((r) => {
          budget.tick();
          return isTruthy(fn(r));
        }),
      });
    }
    case 'select': {
      requireFields(table, t.fields, step, check);
      return budget.measure({
        // A field the table lacks passed only as unchecked: there are no rows, so every value is null.
        columns: t.fields.map(
          (f) => table.columns.find((c) => c.name === f) ?? { name: f, type: 'string' as const },
        ),
        rows: table.rows.map((r) => Object.fromEntries(t.fields.map((f) => [f, r[f] ?? null]))),
      });
    }
    case 'drop': {
      const dropped = new Set(t.fields);
      const keep = table.columns.filter((c) => !dropped.has(c.name));
      return budget.measure({
        columns: keep,
        rows: table.rows.map((r) => Object.fromEntries(keep.map((c) => [c.name, r[c.name] ?? null]))),
      });
    }
    case 'rename': {
      requireFields(table, Object.keys(t.map), step, check);
      // Own entries only: a plain lookup turns a "__proto__" or "constructor" column into Object's members.
      const to = (n: string) => (Object.hasOwn(t.map, n) ? t.map[n]! : n);
      // Checked on the final names so a swap stays legal; a collision would silently merge two columns' values.
      const finalNames = new Map<string, string>();
      for (const c of table.columns) {
        const name = to(c.name);
        const first = finalNames.get(name);
        if (first !== undefined) {
          const both = Object.hasOwn(t.map, first) && Object.hasOwn(t.map, c.name);
          throw new TransformError(
            both
              ? `Columns "${first}" and "${c.name}" would both be named "${name}"; pick another name`
              : `Column "${name}" already exists; rename it too or pick another name`,
            step,
          );
        }
        finalNames.set(name, c.name);
      }
      // Longer names lengthen every row of the JSON, but the rows themselves share the same values.
      return budget.measure({
        columns: table.columns.map((c) => ({ ...c, name: to(c.name) })),
        rows: table.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [to(k), v]))),
      });
    }
    case 'derive': {
      requireFields(table, [...referencedFields(parse(t.expr, BOUND))], step, check);
      const fn = compileFor(t.expr, table, () => budget.tick(), BOUND);
      const replaces = order.includes(t.as);
      // Charged row by row: text built by an expression is new memory, and 40 derive steps of long text over a
      // few thousand rows would otherwise pass the cell limit and still reach gigabytes.
      const rows = table.rows.map((r) => {
        const value = fn(r);
        budget.add(cellSize(t.as, value) - (replaces ? cellSize(t.as, r[t.as]) : 0));
        return { ...r, [t.as]: value };
      });
      const nextOrder = replaces ? order : [...order, t.as];
      const { [t.as]: _replaced, ...rest } = known;
      return retype(rows, nextOrder, rest);
    }
    case 'sort': {
      requireFields(
        table,
        t.by.map((b) => b.field),
        step,
        check,
      );
      let compares = 0;
      // Text compares with localeCompare, about a microsecond each; a large sort can take seconds on its own.
      const rows = [...table.rows].sort((a, b) => {
        if ((++compares & 1023) === 0) budget.tick();
        for (const { field: f, dir } of t.by) {
          const c = compareScalars(a[f] ?? null, b[f] ?? null);
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
        return 0;
      });
      return { columns: table.columns, rows };
    }
    case 'limit':
      return budget.measure({
        columns: table.columns,
        rows: t.from === 'end' ? table.rows.slice(-t.n) : table.rows.slice(0, t.n),
      });
    case 'aggregate': {
      requireFields(table, [...t.groupBy, ...t.metrics.map((m) => m.field)], step, check);
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
      // The output is groups x metrics cells, and the number of metrics has no fixed cap: charge each one.
      budget.size = 0;
      const rows: Row[] = [...groups.values()].map((bucket) => {
        // Cells and types are written with setCell: a column may be called "__proto__".
        const out: Row = {};
        for (const g of t.groupBy) {
          const value = bucket[0]?.[g] ?? null;
          setCell(out, g, value);
          budget.add(cellSize(g, value));
        }
        for (const m of t.metrics) {
          const name = metricName(m);
          const value = aggregate(
            m.op,
            m.field ? bucket.map((r) => r[m.field!] ?? null) : bucket.map(() => 1),
          );
          setCell(out, name, value);
          budget.add(cellSize(name, value));
        }
        return out;
      });
      const keepTypes: Record<string, ColumnType> = {};
      for (const g of t.groupBy) if (known[g]) setCell(keepTypes, g, known[g]);
      for (const m of t.metrics) {
        if (
          m.field &&
          known[m.field] === 'time' &&
          ['min', 'max', 'first', 'last', 'median'].includes(m.op)
        ) {
          setCell(keepTypes, metricName(m), 'time');
        }
      }
      return retype(rows, [...t.groupBy, ...t.metrics.map(metricName)], keepTypes);
    }
    case 'timeBucket': {
      requireFields(table, [t.field], step, check);
      // With no rows a column's type is a guess from no values: one derived from an unchecked column is typed text.
      if (!check.lenient && known[t.field] !== 'time' && known[t.field] !== 'number') {
        throw new TransformError(`Column "${t.field}" is not a time column`, step);
      }
      const as = t.as ?? t.field;
      // One number per row at most: check the worst case up front, then measure what is left.
      if (!order.includes(as)) budget.ensure(table.rows.length * cellSize(as, 0));
      const partial = t.dropPartial ? partialEdgeBuckets(table.rows, t.field, t.unit) : new Set<number>();
      const rows = table.rows.flatMap((r) => {
        const v = r[t.field];
        const bucket = typeof v === 'number' ? bucketStart(v, t.unit) : null;
        return bucket !== null && partial.has(bucket) ? [] : [{ ...r, [as]: bucket }];
      });
      return budget.measure(
        retype(rows, order.includes(as) ? order : [...order, as], { ...known, [as]: 'time' }),
      );
    }
    case 'window': {
      requireFields(table, [t.field, ...(t.partitionBy ?? [])], step, check);
      const as = t.as ?? `${t.op}_${t.field}`;
      if (!order.includes(as)) budget.ensure(table.rows.length * cellSize(as, 0));
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
      return budget.measure(retype(rows, order.includes(as) ? order : [...order, as], known));
    }
    case 'fillNull': {
      requireFields(table, t.fields, step, check);
      // The value is one shared string in memory but is repeated in every row of the JSON.
      const grows = cellSize('', t.value) - cellSize('', null);
      const rows = table.rows.map((r) => {
        const out = { ...r };
        let filled = 0;
        for (const f of t.fields) {
          if (out[f] === null || out[f] === undefined) {
            setCell(out, f, t.value);
            filled++;
          }
        }
        budget.add(filled * grows);
        return out;
      });
      return retype(rows, order, known);
    }
    case 'join': {
      const entry = inputTable(inputs, t.with, step);
      const other = entry.table;
      const otherOpen = entry.open ?? other.rows.length === 0;
      const keys = joinKeys(t.on);
      requireFields(
        table,
        keys.map((k) => k.left),
        step,
        check,
      );
      requireFieldsIn(
        other,
        keys.map((k) => k.right),
        t.with,
        step,
        check,
        otherOpen,
      );
      if (t.fields) requireFieldsIn(other, t.fields, t.with, step, check, otherOpen);
      const theirs = typesOf(other);
      for (const k of keys) {
        const mine = known[k.left];
        const their = theirs[k.right];
        // An open side has no rows, so no values that could mismatch, and its column types are guesses.
        if (mine === undefined || their === undefined || check.lenient || otherOpen) continue;
        if (!sameKeyType(mine, their)) {
          throw new TransformError(
            `Key "${k.left}" is ${TYPE_WORDS[mine]} here and ${TYPE_WORDS[their]} in "${t.with}"; convert one side with derive ${keyConversion(k, mine, their)}`,
            step,
          );
        }
      }
      const brought = joinedColumns(
        order,
        other.columns.map((c) => c.name),
        t,
      );
      // A null key is an unknown value, never equal to another: as in SQL, it matches nothing.
      const keyOf = (row: Row, side: 'left' | 'right') => {
        const values = keys.map((k) => row[k[side]] ?? null);
        return values.some((v) => v === null || (typeof v === 'number' && Number.isNaN(v)))
          ? null
          : JSON.stringify(values);
      };
      const index = new Map<string, Row[]>();
      for (const r of other.rows) {
        const key = keyOf(r, 'right');
        if (key === null) continue;
        const list = index.get(key);
        if (list) list.push(r);
        else index.set(key, [r]);
      }
      // Repeated keys multiply rows: the output is charged row by row, and capped before it is built past the limit.
      budget.size = 0;
      const rows: Row[] = [];
      const emit = (row: Row, match: Row | null) => {
        if (rows.length >= PIPELINE_LIMITS.maxRows) {
          throw new TransformError(
            `The join produced more than ${rowCap()} rows: the keys repeat on both sides. Aggregate one side first.`,
            step,
          );
        }
        const out: Row = { ...row };
        for (const c of order) budget.add(cellSize(c, out[c]));
        for (const b of brought) {
          const value = match ? (match[b.from] ?? null) : null;
          setCell(out, b.name, value);
          budget.add(cellSize(b.name, value));
        }
        rows.push(out);
      };
      for (const row of table.rows) {
        const key = keyOf(row, 'left');
        const matches = key === null ? undefined : index.get(key);
        if (matches) for (const m of matches) emit(row, m);
        else if (t.how === 'left') emit(row, null);
      }
      const types: Record<string, ColumnType> = { ...known };
      for (const b of brought) if (theirs[b.from] !== undefined) setCell(types, b.name, theirs[b.from]!);
      return retype(rows, [...order, ...brought.map((b) => b.name)], types);
    }
    case 'union': {
      if (t.origin && order.includes(t.origin)) {
        throw new TransformError(
          `Column "${t.origin}" already exists; name the origin column differently`,
          step,
        );
      }
      const self = inputs?.self ?? { id: '', name: '' };
      const sources = [
        { key: self.id, name: self.name, table },
        ...t.with.map((id) => ({ key: id, ...inputTable(inputs, id, step) })),
      ];
      const total = sources.reduce((n, s) => n + s.table.rows.length, 0);
      if (total > PIPELINE_LIMITS.maxRows) {
        throw new TransformError(
          `The union produced more than ${rowCap()} rows; filter or aggregate the datasets first.`,
          step,
        );
      }
      const names = unionColumns(sources.map((s) => s.table.columns.map((c) => c.name)));
      if (t.origin && names.includes(t.origin)) {
        throw new TransformError(
          `Column "${t.origin}" already exists; name the origin column differently`,
          step,
        );
      }
      const seen = new Map<string, Set<ColumnType>>();
      // A table without rows has no values that could disagree: its column types are guesses (text, when made from
      // columns it never had), and an empty list must not turn a time column of the whole union into text.
      const withRows = sources.filter((s) => s.table.rows.length > 0);
      for (const s of withRows.length ? withRows : sources) {
        for (const c of s.table.columns) {
          const set = seen.get(c.name) ?? new Set<ColumnType>();
          set.add(c.type);
          seen.set(c.name, set);
        }
      }
      const unionTypes: Record<string, ColumnType> = {};
      // A time column meeting text becomes text; epoch numbers in it would read as nonsense, ISO dates read back
      // with date().
      const timeAsText = new Set<string>();
      for (const [name, set] of seen) {
        if (set.size === 1) setCell(unionTypes, name, [...set][0]!);
        else if (set.has('time') && set.has('string')) timeAsText.add(name);
      }
      budget.size = 0;
      const rows: Row[] = [];
      for (const s of sources) {
        const label = t.origin
          ? t.labels && Object.hasOwn(t.labels, s.key)
            ? t.labels[s.key]!
            : s.name
          : null;
        const types = typesOf(s.table);
        for (const r of s.table.rows) {
          const out: Row = {};
          for (const n of names) {
            // A source without this column reads it as empty, also when it is called "constructor".
            const v = cellOf(r, n) ?? null;
            const value =
              timeAsText.has(n) && types[n] === 'time' && typeof v === 'number'
                ? new Date(v).toISOString()
                : v;
            setCell(out, n, value);
            budget.add(cellSize(n, value));
          }
          if (t.origin) {
            setCell<Scalar>(out, t.origin, label);
            budget.add(cellSize(t.origin, label));
          }
          rows.push(out);
        }
      }
      if (t.origin) setCell(unionTypes, t.origin, 'string');
      return retype(rows, t.origin ? [...names, t.origin] : names, unionTypes);
    }
  }
}

export interface PipelineResult {
  table: DataTable;
  /** Row count after each step - handy for explaining a pipeline to a human or an agent. */
  trace: { step: number; type: Transform['type']; rows: number; unchecked?: string[] }[];
  /** The run was open and its result has no rows: datasets reading it do not check columns either. */
  open?: boolean;
}

/**
 * Hard limits per pipeline run, so a hostile or careless pipeline cannot stall the server or exhaust its memory.
 *
 * Cells alone do not bound memory: 2,000 rows with 40 columns of long text are only 80,000 cells but close to a
 * gigabyte. `maxSize` caps every table of a run (the input and the result of each step) at about 20 million
 * characters of JSON: 20-40 MB of strings plus the row objects, and as much again when the result is serialised.
 * The input, the previous step and the one being built are alive together, so even a run at the limit stays well
 * inside the 256 MB heap of a small instance. Real sources are far below it: fetches and uploads are capped at 5 MB
 * and 100,000 rows, and 100,000 rows of ten numbers come to about 16 million.
 *
 * `maxRows` caps what a join or union may produce: they are the only steps that add rows, and failing beats
 * truncating silently.
 */
export const PIPELINE_LIMITS = {
  maxCells: 5_000_000,
  maxMillis: 3_000,
  maxSize: 20_000_000,
  maxRows: 100_000,
};

export function runPipeline(
  input: DataTable,
  transforms: Transform[],
  inputs?: PipelineInputs,
  options: { open?: boolean } = {},
): PipelineResult {
  let table = input;
  // A source with no rows has no columns to check; a table emptied by a step, here or in the dataset it reads, still
  // has them, so the caller passes the lineage's openness down instead of it being read off this input.
  const open = options.open ?? input.rows.length === 0;
  const trace: PipelineResult['trace'] = [];
  const budget = new RunBudget(Date.now() + PIPELINE_LIMITS.maxMillis);
  // Only a run with steps is measured, matching the pool, which hands a table without steps back untouched.
  if (transforms.length > 0) {
    budget.size = tableSize(input);
    if (budget.size > PIPELINE_LIMITS.maxSize) {
      throw new TransformError(
        `The source data is larger than ${millionChars(PIPELINE_LIMITS.maxSize)} (about its size as JSON), too ` +
          'large to process; ask the source for fewer rows or columns, or use a smaller file',
        0,
      );
    }
  }
  transforms.forEach((t, i) => {
    budget.step = i;
    budget.tick();
    if (table.rows.length * Math.max(table.columns.length, 1) > PIPELINE_LIMITS.maxCells) {
      throw new TransformError('Too much data to process; filter or aggregate earlier', i);
    }
    const check: FieldCheck = { lenient: open && table.rows.length === 0, unchecked: [] };
    try {
      table = applyStep(table, t, i, budget, inputs, check);
    } catch (e) {
      if (e instanceof TransformError) throw e;
      throw new TransformError(e instanceof Error ? e.message : String(e), i);
    }
    trace.push({
      step: i,
      type: t.type,
      rows: table.rows.length,
      ...(check.unchecked.length ? { unchecked: check.unchecked } : {}),
    });
  });
  return { table, trace, ...(open && table.rows.length === 0 ? { open: true } : {}) };
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
