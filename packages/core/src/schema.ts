/**
 * The dashboard document - the single source of truth shared by the web
 * editor, the REST API, the MCP server and the PNG renderer.
 *
 * Everything is strict (`z.strictObject`): unknown keys are rejected instead of
 * silently passed through, so a typo from an agent surfaces as an error rather
 * than a widget that mysteriously ignores its config.
 */
import { z } from 'zod';
import { SoundRuleSchema } from './sound.ts';
import { TransformSchema, withStepIds } from './transforms.ts';

export const SCHEMA_VERSION = 1;
export const GRID_COLUMNS = 12;
export const LIMITS = {
  datasets: 30,
  widgets: 60,
  inlineRows: 2000,
  transforms: 40,
  markdown: 20_000,
  title: 120,
  description: 1000,
} as const;

export const IdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    'Ids are 1-40 chars of a-z, 0-9, "_" or "-", starting with a letter or digit',
  );

/** Ids of saved secrets. Not secret themselves: they appear in public documents and grant nothing. */
export const SecretIdSchema = z
  .string()
  .regex(/^sec_[A-Za-z0-9]{16}$/, 'Secret ids look like "sec_…"; see list_secrets');

const scalar = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const field = z.string().min(1).max(200);

export const SourceSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('connector'),
      connector: z.string().min(1).max(80),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .describe('A built-in public API connector, see list_connectors'),
  z
    .strictObject({ kind: z.literal('upload'), fileId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) })
    .describe('A CSV/JSON file uploaded into this dashboard'),
  z
    .strictObject({
      kind: z.literal('inline'),
      rows: z.array(z.record(z.string(), scalar)).max(LIMITS.inlineRows),
    })
    .describe('Small data embedded directly in the dashboard'),
  z
    .strictObject({
      kind: z.literal('http'),
      url: z.url({ protocol: /^https$/ }).max(2000),
      path: z
        .string()
        .max(200)
        .optional()
        .describe('Dot path to the array inside the JSON response, e.g. "data.items"'),
      secrets: z
        .array(SecretIdSchema)
        .min(1)
        .max(3)
        .refine((ids) => new Set(ids).size === ids.length, 'Each secret once')
        .optional()
        .describe('Saved secret ids (list_secrets), sent only to the address each is bound to'),
    })
    .describe(
      'An HTTPS JSON endpoint. Private networks are blocked. Credentials only via "secrets", never in the URL',
    ),
]);
export type Source = z.infer<typeof SourceSchema>;

export const DatasetSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(120),
  source: SourceSchema,
  // Steps saved before ids existed get them on read, which doubles as the migration.
  transforms: z.array(TransformSchema).max(LIMITS.transforms).default([]).transform(withStepIds),
  refreshSec: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(0)
    .describe('Live refresh interval in seconds; 0 = only on load'),
  accumulate: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(0)
    .describe(
      'Keep the last N rows across refreshes (adds a "fetched_at" time column). Turns "current value" sources into live time series. 0 = off',
    ),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const FormatSchema = z.strictObject({
  style: z.enum(['number', 'compact', 'percent', 'currency']).default('number'),
  decimals: z.number().int().min(0).max(8).optional(),
  currency: z.string().length(3).optional(),
  prefix: z.string().max(12).optional(),
  suffix: z.string().max(12).optional(),
});
export type Format = z.infer<typeof FormatSchema>;

export const CHART_KINDS = [
  'line',
  'area',
  'bar',
  'pie',
  'donut',
  'scatter',
  'heatmap',
  'funnel',
  'radar',
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const ChartConfigSchema = z.strictObject({
  kind: z.enum(CHART_KINDS),
  x: field.describe('Category/time column (pie: label column)'),
  y: z.array(field).min(1).max(12).describe('Value column(s)'),
  series: field
    .optional()
    .describe('Split long-format data into one series per distinct value of this column'),
  horizontal: z.boolean().default(false),
  stacked: z.boolean().default(false),
  smooth: z.boolean().default(false),
  showLegend: z.boolean().optional(),
  showLabels: z.boolean().default(false),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
  logScale: z.boolean().default(false),
  format: FormatSchema.optional(),
  colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
    .max(12)
    .optional(),
  maxPoints: z.number().int().min(10).max(20_000).default(5000),
});
export type ChartConfig = z.infer<typeof ChartConfigSchema>;

export const KPI_AGGS = ['last', 'first', 'sum', 'avg', 'min', 'max', 'count'] as const;

export const KpiConfigSchema = z.strictObject({
  field: field,
  agg: z.enum(KPI_AGGS).default('last'),
  compare: z
    .enum(['none', 'previous', 'first'])
    .default('none')
    .describe('Show change vs previous row or first row'),
  goodWhen: z.enum(['up', 'down']).default('up'),
  sparkline: z.boolean().default(false),
  format: FormatSchema.optional(),
});
export type KpiConfig = z.infer<typeof KpiConfigSchema>;

export const GaugeConfigSchema = z.strictObject({
  field: field,
  agg: z.enum(KPI_AGGS).default('last'),
  min: z.number().default(0),
  max: z.number().default(100),
  format: FormatSchema.optional(),
  bands: z
    .array(z.strictObject({ upTo: z.number(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
    .max(6)
    .optional(),
});
export type GaugeConfig = z.infer<typeof GaugeConfigSchema>;

export const TableConfigSchema = z.strictObject({
  columns: z.array(field).max(40).optional().describe('Columns to show; default all'),
  pageSize: z.number().int().min(5).max(200).default(25),
  format: FormatSchema.optional(),
});
export type TableConfig = z.infer<typeof TableConfigSchema>;

export const TextConfigSchema = z.strictObject({
  markdown: z.string().max(LIMITS.markdown),
});

const widgetBase = {
  id: IdSchema,
  title: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
};
// Text widgets have no data, so only data-bound widgets can make a sound.
const dataWidgetBase = { ...widgetBase, datasetId: IdSchema, sound: SoundRuleSchema.optional() };

export const WidgetSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...dataWidgetBase, type: z.literal('chart'), config: ChartConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('kpi'), config: KpiConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('gauge'), config: GaugeConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('table'), config: TableConfigSchema }),
  z.strictObject({ ...widgetBase, type: z.literal('text'), config: TextConfigSchema }),
]);
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetType = Widget['type'];
export type WidgetInput = z.input<typeof WidgetSchema>;

export const LayoutItemSchema = z.strictObject({
  i: IdSchema,
  x: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(40),
});
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

export const DashboardDocSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(LIMITS.title),
  description: z.string().max(LIMITS.description).default(''),
  datasets: z.array(DatasetSchema).max(LIMITS.datasets).default([]),
  widgets: z.array(WidgetSchema).max(LIMITS.widgets).default([]),
  layout: z.array(LayoutItemSchema).default([]),
});
export type DashboardDoc = z.infer<typeof DashboardDocSchema>;
export type DashboardDocInput = z.input<typeof DashboardDocSchema>;

export function emptyDashboard(title = 'Untitled dashboard'): DashboardDoc {
  return { schemaVersion: SCHEMA_VERSION, title, description: '', datasets: [], widgets: [], layout: [] };
}

/** Problems that a schema alone cannot express (cross references, duplicates, overlaps). */
export function integrityIssues(doc: DashboardDoc): string[] {
  const issues: string[] = [];
  const datasetIds = new Set<string>();
  for (const d of doc.datasets) {
    if (datasetIds.has(d.id)) issues.push(`Duplicate dataset id "${d.id}"`);
    datasetIds.add(d.id);
  }
  for (const d of doc.datasets) {
    const stepIds = new Set<string>();
    for (const step of d.transforms) {
      if (step.id && stepIds.has(step.id))
        issues.push(`Dataset "${d.id}" has two steps with id "${step.id}"`);
      if (step.id) stepIds.add(step.id);
    }
  }
  const widgetIds = new Set<string>();
  for (const w of doc.widgets) {
    if (widgetIds.has(w.id)) issues.push(`Duplicate widget id "${w.id}"`);
    widgetIds.add(w.id);
    if ('datasetId' in w && !datasetIds.has(w.datasetId)) {
      issues.push(`Widget "${w.id}" references unknown dataset "${w.datasetId}"`);
    }
  }
  const laidOut = new Set<string>();
  for (const item of doc.layout) {
    if (!widgetIds.has(item.i)) issues.push(`Layout entry "${item.i}" has no widget`);
    if (laidOut.has(item.i)) issues.push(`Widget "${item.i}" appears twice in the layout`);
    laidOut.add(item.i);
    if (item.x + item.w > GRID_COLUMNS)
      issues.push(`Widget "${item.i}" overflows the ${GRID_COLUMNS}-column grid`);
  }
  for (const id of widgetIds) if (!laidOut.has(id)) issues.push(`Widget "${id}" has no layout entry`);
  return issues;
}

export class DocumentError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'DocumentError';
    this.issues = issues;
  }
}

/** Parses untrusted input into a valid document or throws a readable error. */
export function parseDashboard(input: unknown): DashboardDoc {
  const result = DashboardDocSchema.safeParse(input);
  if (!result.success) throw new DocumentError(formatZodIssues(result.error));
  const issues = integrityIssues(result.data);
  if (issues.length) throw new DocumentError(issues);
  return result.data;
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
}
