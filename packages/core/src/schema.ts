/**
 * The dashboard document - the single source of truth shared by the web
 * editor, the REST API, the MCP server and the PNG renderer.
 *
 * Everything is strict (`z.strictObject`): unknown keys are rejected instead of
 * silently passed through, so a typo from an agent surfaces as an error rather
 * than a widget that mysteriously ignores its config.
 */
import { z } from 'zod';
import { isValidTimeZone } from './clock.ts';
import { SEARCH_ENGINES } from './search.ts';
import { SoundRuleSchema } from './sound.ts';
import { COLOR_TOKENS } from './theme.ts';
import { ExpressionSchema, TransformSchema, withStepIds } from './transforms.ts';

export const SCHEMA_VERSION = 1;
export const GRID_COLUMNS = 12;
export const LIMITS = {
  datasets: 30,
  widgets: 60,
  inlineRows: 2000,
  /**
   * Characters per inline text value and per inline column name. Checked on writes only (DashboardService), not in
   * this schema, which also reads stored documents: those saved before the limits must keep loading.
   */
  inlineText: 1000,
  inlineColumnName: 200,
  transforms: 40,
  markdown: 20_000,
  title: 120,
  description: 1000,
  /**
   * Serialised size of a whole document in bytes. Below the 1 MiB request body limit, so every document the server
   * accepts can still be saved whole from the editor; larger data belongs in uploads, which are stored on their own.
   */
  documentBytes: 1_000_000,
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

/** Feeds are fetched at most this often per address, whatever a dataset's refreshSec says. */
export const FEED_MIN_REFRESH_SEC = 300;
/** HTTP sources are cached this long per address, so a faster refresh would only re-read the cache. */
export const HTTP_MIN_REFRESH_SEC = 30;

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
  z
    .strictObject({
      kind: z.literal('feed'),
      url: z.url({ protocol: /^https$/ }).max(2000),
      limit: z.number().int().min(1).max(200).default(30),
    })
    .describe('An RSS, Atom or JSON Feed, or a web page that announces one'),
]);
export type Source = z.infer<typeof SourceSchema>;

/**
 * Uploaded files and inline rows change only when someone edits the dashboard, never on a timer, so a live refresh
 * of them would only repeat the same work.
 */
export function isStaticSource(source: Source): boolean {
  return source.kind === 'upload' || source.kind === 'inline';
}

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

/** Hex stays valid so every existing document (and deliberate brand colours) keeps loading; tokens are preferred. */
export const ColorSchema = z
  .union([z.enum(COLOR_TOKENS), z.string().regex(/^#[0-9a-fA-F]{6}$/)])
  .describe('Named colour or #rrggbb');

export const MAX_COLOR_ENTRIES = 60;
export const ColorMapSchema = z
  .record(field, ColorSchema)
  .refine((m) => Object.keys(m).length <= MAX_COLOR_ENTRIES, `At most ${MAX_COLOR_ENTRIES} colours`);

/**
 * Ascending `upTo`; a value takes the first band whose upTo is >= it. Field descriptions for the colour features
 * live in the MCP reference text, not here: every byte of these schemas is paid on each MCP connection.
 */
export const BandsSchema = z.array(z.strictObject({ upTo: z.number(), color: ColorSchema })).max(6);
export type Bands = z.infer<typeof BandsSchema>;

export const REFERENCE_STATS = ['avg', 'median', 'min', 'max'] as const;
/** Only these kinds have a value axis to draw a reference line on. */
export const REFERENCE_LINE_KINDS = ['line', 'area', 'bar', 'scatter'] as const;
export const ReferenceLineSchema = z.strictObject({
  value: z.number().optional(),
  stat: z.enum(REFERENCE_STATS).optional(),
  /** The column the statistic is computed on; default the first y. */
  field: field.optional(),
  label: z.string().max(60).optional(),
  color: ColorSchema.optional(),
});
export type ReferenceLine = z.infer<typeof ReferenceLineSchema>;

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
  xMin: z.number().optional().describe('Scatter with a numeric x: fixed lower bound of the x axis'),
  xMax: z.number().optional().describe('Scatter with a numeric x: fixed upper bound of the x axis'),
  logScale: z.boolean().default(false),
  format: FormatSchema.optional(),
  colors: z.union([z.array(ColorSchema).max(12), ColorMapSchema]).optional(),
  maxPoints: z.number().int().min(10).max(20_000).default(5000),
  referenceLines: z.array(ReferenceLineSchema).max(3).optional(),
});
export type ChartConfig = z.infer<typeof ChartConfigSchema>;

export const KPI_AGGS = ['last', 'first', 'sum', 'avg', 'min', 'max', 'count'] as const;

/**
 * `count` counts rows, so it needs no column; given one, it counts that column's non-null values. Every other
 * aggregate reads a column, which a JSON Schema `required` cannot express per agg: hence the refinement.
 */
const valueField = field.optional().describe('Value column; optional for count');
const needsField = (config: { field?: string | undefined; agg: string }, ctx: z.RefinementCtx) => {
  if (config.field === undefined && config.agg !== 'count') {
    ctx.addIssue({ code: 'custom', path: ['field'], message: `agg "${config.agg}" needs a field` });
  }
};

export const KpiConfigSchema = z
  .strictObject({
    field: valueField,
    agg: z.enum(KPI_AGGS).default('last'),
    compare: z
      .enum(['none', 'previous', 'first'])
      .default('none')
      .describe('Show change vs previous row or first row'),
    goodWhen: z.enum(['up', 'down', 'neutral']).default('up'),
    sparkline: z.boolean().default(false),
    format: FormatSchema.optional(),
    bands: BandsSchema.optional(),
  })
  .superRefine(needsField);
export type KpiConfig = z.infer<typeof KpiConfigSchema>;

export const GaugeConfigSchema = z
  .strictObject({
    field: valueField,
    agg: z.enum(KPI_AGGS).default('last'),
    min: z.number().default(0),
    max: z.number().default(100),
    format: FormatSchema.optional(),
    bands: BandsSchema.optional(),
  })
  .superRefine(needsField);
export type GaugeConfig = z.infer<typeof GaugeConfigSchema>;

const colorAs = z.enum(['fill', 'text']).default('fill');

export const TableColumnSchema = z.strictObject({
  field,
  label: z.string().min(1).max(80).optional(),
  link: field.optional(),
  format: FormatSchema.optional(),
  bands: BandsSchema.optional(),
  colorAs,
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableRuleSchema = z.strictObject({
  when: ExpressionSchema,
  color: ColorSchema,
  columns: z.array(field).max(40).optional(),
  colorAs,
  label: z.string().max(60).optional(),
});
export type TableRule = z.infer<typeof TableRuleSchema>;

export const TableConfigSchema = z.strictObject({
  columns: z
    .array(z.union([field, TableColumnSchema]))
    .max(40)
    .optional()
    .describe('Columns to show; default all'),
  pageSize: z.number().int().min(5).max(200).default(25),
  format: FormatSchema.optional(),
  rules: z.array(TableRuleSchema).max(6).optional(),
  // Optional, not defaulted: tables saved before it existed must round-trip unchanged. Absent means "table".
  style: z.enum(['table', 'list']).optional(),
});
export type TableConfig = z.infer<typeof TableConfigSchema>;

export const MapConfigSchema = z.strictObject({
  lat: field,
  lon: field,
  mode: z.enum(['points', 'track']).default('points'),
  series: field.optional().describe('One colour (and track) per value'),
  size: field.optional().describe('Numeric; dot area grows with it'),
  color: field.optional().describe('Numeric, sequential ramp; not with series'),
  label: field.optional(),
  view: z.enum(['fit', 'world']).default('fit'),
  basemap: z.enum(['countries', 'land', 'none']).default('countries'),
  terminator: z.boolean().default(false).describe('Shade the night side'),
  maxPoints: z.number().int().min(10).max(20_000).default(5000),
  format: FormatSchema.optional(),
  // Map form only: the array form of chart colors exists for documents older than colour maps.
  colors: ColorMapSchema.optional(),
});
export type MapConfig = z.infer<typeof MapConfigSchema>;

export const TextConfigSchema = z.strictObject({
  markdown: z.string().max(LIMITS.markdown),
});

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Unknown time zone; use an IANA name such as "Europe/Bratislava"');

export const ClockConfigSchema = z.strictObject({
  style: z.enum(['digital', 'analog']).default('digital'),
  // Field descriptions live in the MCP reference text: every byte here is paid on each MCP connection.
  timeZone: TimeZoneSchema.optional(),
  label: z.string().max(60).optional(),
  hourCycle: z.enum(['h23', 'h12']).default('h23'),
  showDate: z.boolean().default(true),
  showSeconds: z.boolean().default(false),
});
export type ClockConfig = z.infer<typeof ClockConfigSchema>;

export const SearchConfigSchema = z.strictObject({
  engine: z.enum(SEARCH_ENGINES).default('google'),
  template: z
    .url({ protocol: /^https$/ })
    .max(500)
    .refine((u) => u.includes('{q}'), 'The address must contain {q} where the query goes')
    .optional(),
  newTab: z.boolean().default(false),
  autofocus: z.boolean().default(false),
});
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

const widgetBase = {
  id: IdSchema,
  title: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
};
// Text, clock and search widgets have no data, so only data-bound widgets can make a sound.
const dataWidgetBase = { ...widgetBase, datasetId: IdSchema, sound: SoundRuleSchema.optional() };

export const WidgetSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...dataWidgetBase, type: z.literal('chart'), config: ChartConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('kpi'), config: KpiConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('gauge'), config: GaugeConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('table'), config: TableConfigSchema }),
  z.strictObject({ ...dataWidgetBase, type: z.literal('map'), config: MapConfigSchema }),
  z.strictObject({ ...widgetBase, type: z.literal('text'), config: TextConfigSchema }),
  z.strictObject({ ...widgetBase, type: z.literal('clock'), config: ClockConfigSchema }),
  z.strictObject({ ...widgetBase, type: z.literal('search'), config: SearchConfigSchema }),
]);
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetType = Widget['type'];
export type DataWidget = Extract<Widget, { datasetId: string }>;

/** Widget types that show no dataset: they have no `datasetId`, no data query and no sound. */
export const DATA_FREE_WIDGET_TYPES = ['text', 'clock', 'search'] as const satisfies readonly WidgetType[];
export function isDataWidgetType(type: WidgetType): boolean {
  return !(DATA_FREE_WIDGET_TYPES as readonly string[]).includes(type);
}
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
  // Optional, not defaulted: documents without it must round-trip unchanged.
  colors: ColorMapSchema.optional().describe(
    "Dashboard-wide colour per entity (series value, y column or slice label); a widget's own map wins",
  ),
});
export type DashboardDoc = z.infer<typeof DashboardDocSchema>;
export type DashboardDocInput = z.input<typeof DashboardDocSchema>;

export function emptyDashboard(title = 'Untitled dashboard'): DashboardDoc {
  return { schemaVersion: SCHEMA_VERSION, title, description: '', datasets: [], widgets: [], layout: [] };
}

/**
 * A line for a column the chart does not plot would be a second scale in disguise, and pies or heatmaps have no
 * value axis to draw on, so both are refused rather than silently not drawn.
 */
function referenceLineIssues(id: string, config: ChartConfig): string[] {
  const lines = config.referenceLines ?? [];
  if (!lines.length) return [];
  if (!(REFERENCE_LINE_KINDS as readonly string[]).includes(config.kind)) {
    return [
      `Chart "${id}" is a ${config.kind}, which has no value axis for reference lines (only ${REFERENCE_LINE_KINDS.join(', ')})`,
    ];
  }
  const issues: string[] = [];
  lines.forEach((line, i) => {
    const name = `Reference line ${i + 1} of "${id}"`;
    if ((line.value === undefined) === (line.stat === undefined))
      issues.push(`${name}: give either value or stat`);
    if (line.field !== undefined && !config.y.includes(line.field)) {
      issues.push(
        `${name}: field "${line.field}" is not one of the chart's y columns (${config.y.join(', ')})`,
      );
    }
  });
  return issues;
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
    // Two encodings in one channel cannot be read, for the same reason charts never get dual axes.
    if (w.type === 'map' && w.config.series && w.config.color) {
      issues.push(`Widget "${w.id}": use series or color, not both; a map has one colour channel`);
    }
    if (w.type === 'chart') issues.push(...referenceLineIssues(w.id, w.config));
    if (w.type === 'search' && (w.config.engine === 'custom') !== Boolean(w.config.template)) {
      issues.push(
        w.config.engine === 'custom'
          ? `Widget "${w.id}": a custom search engine needs a template address with {q}`
          : `Widget "${w.id}": template is only used with engine "custom"`,
      );
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
