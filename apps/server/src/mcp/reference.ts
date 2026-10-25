/** The authoring guide agents read before building. Generated from code so it never drifts. */
import {
  AGGREGATE_OPS,
  CHART_KINDS,
  FUNCTIONS,
  GRID_COLUMNS,
  KPI_AGGS,
  LIMITS,
  TIME_UNITS,
  WINDOW_OPS,
} from '@patchbay/core';

export const SERVER_INSTRUCTIONS = `Patchbay builds live data dashboards. You edit them with small, validated operations.

Workflow that works well:
1. list_connectors (public APIs) or upload_data (the user's own CSV/JSON).
2. preview_data to see real columns, a profile and suggested widgets before saving anything.
3. create_dashboard, then apply_operations with addDataset + addWidget ops (batch them). Use dryRun: true when unsure.
4. render_snapshot and look at the image. Fix what looks wrong (empty charts, unreadable labels, wrong scale).
5. Give the user the dashboard URL.

Rules: every write creates a new version the user can roll back (list_versions / restore_version), and the user
sees your changes live in the browser. Prefer few, meaningful widgets over many. Never put two measures of
different scale on one chart; make two charts instead. Read get_reference for the full schema.`;

export function referenceText(): string {
  const fns = Object.entries(FUNCTIONS)
    .map(([name, f]) => `- ${name}(${f.args}): ${f.doc}`)
    .join('\n');
  return `# Patchbay authoring reference

## Document
A dashboard has \`datasets\` (where data comes from + how it is processed) and \`widgets\` (how it is shown),
laid out on a ${GRID_COLUMNS}-column grid. Ids are lowercase slugs ("weather", "temp-chart"). Limits: ${LIMITS.datasets} datasets,
${LIMITS.widgets} widgets, ${LIMITS.inlineRows} inline rows.

## Dataset
{ id, name, source, transforms: Transform[], refreshSec, accumulate }
- source.kind "connector": { connector: "<id from list_connectors>", params: {...} }
- source.kind "upload": { fileId } (from upload_data)
- source.kind "inline": { rows: [{...}, ...] } (small data you create yourself)
- source.kind "http": { url: "https://...", path?: "data.items" } (public JSON APIs only)
- refreshSec > 0 makes it live: the server re-fetches on that interval and pushes changes to viewers.
- accumulate N keeps a rolling history of the last N rows across refreshes and adds a "fetched_at" time column.
  Use it to chart sources that only return the current value (weather.current, crypto.price, iss.position).

## Transforms (run in order, on the server)
- filter { expr }                         keep rows where expr is truthy
- select { fields } / drop { fields } / rename { map: { old: new } }
- derive { as, expr }                     computed column
- sort { by: [{ field, dir: "asc"|"desc" }] }
- limit { n, from: "start"|"end" }
- aggregate { groupBy: [..], metrics: [{ op, field?, as? }] }   ops: ${AGGREGATE_OPS.join(', ')}
- timeBucket { field, unit, as? }         units: ${TIME_UNITS.join(', ')} (UTC); then aggregate by that field
- window { op, field, as?, size?, partitionBy? }   ops: ${WINDOW_OPS.join(', ')} (sort first)
- fillNull { fields, value }

## Expressions
Operators: + - * / % ^, == != < <= > >=, && || ! (or: and, or, not), cond ? a : b. Strings in "double" or 'single'
quotes; field names with spaces in \`backticks\`. Times are epoch milliseconds. Functions:
${fns}

## Widgets
- chart { kind, x, y: [..], series?, horizontal, stacked, smooth, showLabels, showLegend?, yMin?, yMax?, logScale, format?, colors? }
  kinds: ${CHART_KINDS.join(', ')}. "series" splits long-format data (one row per time+category) into lines/bars.
  pie/donut: x = label, y[0] = value (aggregate first; at most 6 slices are kept). heatmap: x, series = y-axis category, y[0] = value.
- kpi { field, agg, compare: none|previous|first, goodWhen: up|down, sparkline, format? }   aggs: ${KPI_AGGS.join(', ')}
- gauge { field, agg, min, max, bands?: [{ upTo, color }], format? }
- table { columns?, pageSize, format? }
- text { markdown }   (no raw HTML)
format: { style: number|compact|percent|currency, decimals?, currency?, prefix?, suffix? }

## Operations (apply_operations)
setMeta, addDataset, updateDataset { id, set }, removeDataset { id, cascade? }, addWidget { widget, position? },
updateWidget { id, set: { title?, description?, datasetId?, config? (shallow-merged) } }, replaceWidget { widget },
removeWidget { id }, moveWidget { id, x?, y?, w?, h? }, setLayout { layout }.
Omit positions to auto-place. Typical sizes: kpi 3x2, gauge 3x3, chart 6x4, table 6x5, text 4x2 (w x h, row = 80 px).

## Design guidance
- One headline per KPI. Use compare + sparkline for live values.
- Line/area for time, bar for categories (horizontal when labels are long or there are > 6), donut only for <= 6 parts.
- Never mix measures with different units or scales on one chart.
- Aggregate before charting large data (timeBucket + aggregate), the chart caps points anyway.
- Titles say what is shown and the unit: "Temperature (°C)", "Revenue per week".
`;
}
