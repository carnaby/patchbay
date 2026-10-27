/** The authoring guide agents read before building. Generated from code so it never drifts. */
import {
  AGGREGATE_OPS,
  CHART_KINDS,
  FUNCTIONS,
  GRID_COLUMNS,
  KPI_AGGS,
  LIMITS,
  MAX_SECRETS_PER_SOURCE,
  SOUND_IDS,
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
different scale on one chart; make two charts instead. Read get_reference for the full schema. Private APIs: see
list_secrets.`;

export function referenceText(publicUrl = '<PUBLIC_URL>'): string {
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
- source.kind "http": { url: "https://...", path?: "data.items", secrets?: ["sec_..."] } (JSON APIs; see Secrets)
- refreshSec > 0 makes it live: the server re-fetches on that interval and pushes changes to viewers. Below the
  connector's minRefreshSec (list_connectors) it is raised to that minimum when saved, and \`changes\` says so.
- accumulate N keeps a rolling history of the last N rows across refreshes and adds a "fetched_at" time column.
  Use it to chart sources that only return the current value (weather.current, crypto.price, iss.position).
  The history lives in server memory and gains a reading only when the dataset is loaded and the source has a new
  one. While a browser has the dashboard open, the server loads it every refreshSec. With nobody watching nothing
  refreshes: readings are added only when the data is requested (get_data, render_snapshot, the data check of
  apply_operations, a page load), so the history follows those requests and has gaps. A connector has a new reading
  at most every minRefreshSec, an http source every 30 s. A server restart or a new source starts it afresh. Inline
  and upload sources count as new on every load: do not accumulate them.

## Secrets (http sources)
Some APIs need a key. The user saves keys under Settings → Secrets; you can list them (list_secrets) but never read,
create or change them.
- Add secrets: ["<id>"] to an http source. The URL must start with the secret's origin and pathPrefix, or the save
  fails. At most ${MAX_SECRETS_PER_SOURCE} per source. The secret decides how it is sent (header or query parameter).
- Never put keys or tokens into a URL, a dataset name or a text widget. If an API needs a key the user has not saved,
  ask them to add it at ${publicUrl}/settings#secrets, then continue.
- A public dashboard that uses secrets is read-only for you: every change to it (datasets, steps, widgets, restoring
  a version) must be made by the user in the web app, or after they make it private. You also cannot make a
  dashboard with secrets public. Ask the user to do it in the web app.
- These rules limit where secrets are used, not where data you have read can go. Never copy data fetched with a
  secret anywhere else (another dashboard, inline rows, a text widget, your answer) unless the user asked for it.
- Data fetched with a secret is shown to everyone who can view the dashboard. Keep such dashboards private unless the
  user says otherwise.

## Transforms (run in order, on the server)
Every step has a stable id ("s1", "s2", … assigned automatically, or your own). Address steps by id with the step
operations below instead of resending the whole pipeline.
- filter { expr }                         keep rows where expr is truthy
- select { fields } / drop { fields } / rename { map: { old: new } }
- derive { as, expr }                     computed column
- sort { by: [{ field, dir: "asc"|"desc" }] }
- limit { n, from: "start"|"end" }
- aggregate { groupBy: [..], metrics: [{ op, field?, as? }] }   ops: ${AGGREGATE_OPS.join(', ')}
- timeBucket { field, unit, as?, dropPartial? }   units: ${TIME_UNITS.join(', ')} (UTC); then aggregate by that field
  By default every bucket is kept, also the first and last when the data covers them only partly: a rolling 7-day
  window per day gives 8 buckets, and the last (today so far) looks like a sharp drop. dropPartial: true drops the
  first/last bucket when the data starts or ends more than one sampling interval (the median gap between times)
  inside it.
- window { op, field, as?, size?, partitionBy? }   ops: ${WINDOW_OPS.join(', ')} (sort first)
- fillNull { fields, value }

## Expressions
Operators: + - * / % ^, == != < <= > >=, && || ! (or: and, or, not), cond ? a : b. Strings in "double" or 'single'
quotes; field names with spaces in \`backticks\`. Times are epoch milliseconds. Trigonometry works in radians (convert
with radians()/degrees()); distance(lat, lon, 48.15, 17.11) gives km to a fixed point. Functions:
${fns}

## Widgets
- chart { kind, x, y: [..], series?, horizontal, stacked, smooth, showLabels, showLegend?, yMin?, yMax?, xMin?, xMax?, logScale, format?, colors? }
  kinds: ${CHART_KINDS.join(', ')}. "series" splits long-format data (one row per time+category) into lines/bars.
  xMin/xMax fix the x axis of a scatter with a numeric x (e.g. -180/180 for a longitude map).
  pie/donut: x = label, y[0] = value (aggregate first; at most 6 slices are kept). heatmap: x, series = y-axis category, y[0] = value.
- kpi { field?, agg, compare: none|previous|first, goodWhen: up|down, sparkline, format? }   aggs: ${KPI_AGGS.join(', ')}
- gauge { field?, agg, min, max, bands?: [{ upTo, color }], format? }
  field is required except for agg "count": without a field count counts rows, with one it counts the rows where
  that field is not null.
- table { columns?, pageSize, format? }
- text { markdown }   (no raw HTML)
format: { style: number|compact|percent|currency, decimals?, currency?, prefix?, suffix? }

## Sound cues (chart, kpi, gauge, table)
An optional \`sound\` field makes browsers showing the dashboard play a short built-in sound when live data changes:
{ trigger, sound, volume, cooldownSec }
- trigger { kind: "newRows", key? }: plays when a row with a new \`key\` value appears (e.g. "order_id"); rows that
  drop out of a rolling window never play. Without key it plays when the row count grew.
- trigger { kind: "condition", expr }: plays once when expr, evaluated on the LAST row (the newest reading), becomes
  true. It must become false again before it can play again.
- sound: ${SOUND_IDS.join(', ')} (default bell). volume 0..1 (default 0.7). cooldownSec 0..3600 (default 10).
- Never plays on page load, after a reconnect or after the dataset changed: the first result is the baseline.
  Viewers can mute their own screen; browsers stay silent until the page is clicked once.
Example: { "op": "updateWidget", "id": "orders", "set": { "sound": { "trigger": { "kind": "newRows", "key": "order_id" }, "sound": "bell" } } }
To try it without real data, put the widget on a demo.sales dataset with params { "live": true } and refreshSec 5:
it returns single orders (time, order_id, ...) and a new one arrives every few seconds.
Remove with set: { sound: null }. Only add a sound when the user asks for it or the dashboard is clearly a wall screen
for events people must notice. Use sounds sparingly: at most one or two widgets per dashboard, a distinct sound per
meaning (bell/cash for new orders or sales, alert for a threshold), and a cooldown long enough not to annoy.

## Operations (apply_operations)
setMeta, addDataset, updateDataset { id, set }, removeDataset { id, cascade? }, addWidget { widget, position? },
updateWidget { id, set: { title?, description?, datasetId?, config? (shallow-merged), sound? (replaced; null removes) } }, replaceWidget { widget },
removeWidget { id }, moveWidget { id, x?, y?, w?, h? }, setLayout { layout },
reorderWidget { id, before: widgetId | null } (reading order, i.e. the order widgets stack in on phones; sizes kept),
addStep { datasetId, step, before? }, updateStep { datasetId, stepId, set } (merged; type cannot change),
removeStep { datasetId, stepId }, moveStep { datasetId, stepId, before: stepId | null }.
Prefer step operations over updateDataset { set: { transforms } }: they do not overwrite steps the user changed meanwhile.
Omit positions to auto-place. Typical sizes: kpi 3x2, gauge 3x3, chart 6x4, table 6x5, text 4x2 (w x h, row = 80 px).

## Design guidance
- One headline per KPI. Use compare + sparkline for live values.
- Line/area for time, bar for categories (horizontal when labels are long or there are > 6), donut only for <= 6 parts.
- Never mix measures with different units or scales on one chart.
- Aggregate before charting large data (timeBucket + aggregate), the chart caps points anyway.
- Titles say what is shown and the unit: "Temperature (°C)", "Revenue per week".
`;
}
