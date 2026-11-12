# MCP reference

Endpoint: `PUBLIC_URL/mcp` (Streamable HTTP). Protocol 2026-07-28, with stateless fallback for 2025-era clients.

## Authentication

| Method                | Use it for                                             | How                                                                         |
| --------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| OAuth 2.1             | Claude, Claude Code, any MCP client with OAuth support | Just add the URL. The client discovers everything from the `401` challenge. |
| Personal access token | Scripts, CI, clients without OAuth, development        | Create one under _Settings_, send `Authorization: Bearer pb_pat_…`.         |

Discovery documents:

- `/.well-known/oauth-protected-resource/mcp` (RFC 9728), also at `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server` (RFC 8414)

Supported: authorization code + PKCE (S256 only), public clients, Client ID Metadata Documents
(`client_id_metadata_document_supported: true`), dynamic client registration (`/oauth/register`), resource indicators
(tokens are bound to `PUBLIC_URL/mcp`), refresh token rotation with reuse detection, revocation (`/oauth/revoke`).
Access tokens live 1 hour, refresh tokens 30 days, and work only on `/mcp` (the REST API takes personal access
tokens). Users can see and revoke connected clients under _Settings_; tokens, connections and the consent screen are
managed only from a signed-in web session, never with a token. Dynamically registered clients that never obtain a
grant are removed after a day, and clients without a live token after 90 days.

A client metadata document is fetched without redirects, within 5 s, and may be at most 16 KB with 256 JSON values;
only its `client_id`, `client_name`, `redirect_uris`, `client_uri`, `logo_uri` and `token_endpoint_auth_method` are
kept, for a day. A document that fails is not fetched again for 5 minutes.

Scopes:

- `dashboards:read`: list and read your dashboards and their data, preview sources, render snapshots.
- `dashboards:write`: create and change dashboards and upload data. Every change is versioned. Includes using the
  user's saved secrets in their own dashboards (never reading them); the consent screen says so.

## Tools

| Tool               | Scope | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_reference`    | read  | The full authoring guide: document schema, transforms, expression functions, widget configs, design rules.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `list_connectors`  | read  | Built-in public data sources and their parameters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `list_dashboards`  | read  | The user's dashboards with URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_dashboard`    | read  | One dashboard's document and metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `preview_data`     | read  | Run a source + transforms **without saving**: columns, sample rows, row count per step, column profile, suggested widgets as operations. Pass `dashboardId` for uploads, `dataset` sources and join/union steps; a draft that uses `$param.` needs it too, since the filters are declared in the dashboard (without it the call fails with "unknown filter"). `parameters` picks a view of the dashboard's filters (see "Filters"); without `dashboardId`, given `parameters` are ignored and the answer says so. |
| `get_data`         | read  | The processed rows of a saved dataset, with `rowCount` and a profile. `limit` (default 50) keeps the first rows; `from: "end"` keeps the last ones instead, i.e. the newest of an ascending time series. `parameters` picks a view of the dashboard's filters (see "Filters").                                                                                                                                                                                                                                    |
| `suggest_widgets`  | read  | Rules-based visualisation suggestions for a saved dataset, as ready-to-apply operations with rationales. Suggestions with extra steps derive a dataset from the saved one (source kind `dataset`) instead of copying it. `parameters` picks a view of the dashboard's filters (see "Filters").                                                                                                                                                                                                                    |
| `render_snapshot`  | read  | PNG of the dashboard or a single widget (light or dark), plus any data errors and warnings. `parameters` picks a view of the dashboard's filters (see "Filters").                                                                                                                                                                                                                                                                                                                                                 |
| `list_versions`    | read  | Version history with actor and change log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `list_secrets`     | read  | The user's saved secrets for HTTP sources: id, name, origin, path prefix, how each is sent, timestamps. Never values. See "Secrets" below.                                                                                                                                                                                                                                                                                                                                                                        |
| `create_dashboard` | write | New dashboard (private by default), optionally from a template.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apply_operations` | write | Atomic batch of operations; `dryRun` to validate only; `baseVersion` for optimistic concurrency. Returns the change log, a data check for every dataset the batch added or changed (also through step operations) and every dataset built on them, and `warnings` (a URL that looks like it holds a key, hard-to-see colours, truncated bars).                                                                                                                                                                    |
| `upload_data`      | write | Store CSV/JSON (≤ 5 MB) in a dashboard; `path` picks the records inside a JSON file. Returns the file id, profile, a ready `addDataset` op and suggestions.                                                                                                                                                                                                                                                                                                                                                       |
| `restore_version`  | write | Restore an earlier version (as a new version).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `set_visibility`   | write | Public or private.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

There is intentionally no delete tool.

Input schemas are JSON Schema 2020-12. Closed sets are enums: `create_dashboard.template` and the connector id in a
source. Unknown ids are rejected (an operation that adds or re-points a dataset to an unknown connector fails the whole
batch), but dashboards saved with a since-removed connector still load and accept edits that leave that source alone.
To keep `tools/list` small, `apply_operations` defines its large shared parts once under
`$defs` (`Source`, `Transform`, `Widget`, `SoundRule`, `Format`, `Color`, `Bands`) and points to them with local `$ref`s, each carrying
`"type": "object"` for clients that do not resolve references. The server validates every call with the full strict
schema either way.

Prompts: `build_dashboard { topic }`, `analyze_my_data { dashboardId? }`. Resource: `patchbay://reference`.

## Operations

```jsonc
{ "op": "setMeta", "title": "…", "description": "…" }
{ "op": "setMeta", "colors": { "Bratislava": "accent-2", "Kosice": "accent-5" } } // dashboard-wide entity colours; null removes
{ "op": "addDataset", "dataset": { "id": "quakes", "name": "Quakes", "source": { … }, "transforms": [ … ], "refreshSec": 60 } }
{ "op": "updateDataset", "id": "quakes", "set": { "transforms": [ … ] } }
{ "op": "removeDataset", "id": "quakes", "cascade": true }
{ "op": "addWidget", "widget": { "id": "strongest", "type": "kpi", "datasetId": "quakes", "config": { "field": "magnitude", "agg": "max" } }, "position": { "w": 3, "h": 2 } }
{ "op": "addWidget", "widget": { "id": "quake-count", "type": "kpi", "datasetId": "quakes", "config": { "agg": "count" } } } // count: rows, or with "field" the non-null values
{ "op": "updateWidget", "id": "strongest", "set": { "title": "Strongest quake", "config": { "format": { "decimals": 1 } } } }
{ "op": "replaceWidget", "widget": { … } }
{ "op": "removeWidget", "id": "strongest" }
{ "op": "moveWidget", "id": "strongest", "x": 0, "y": 0, "w": 4 }
{ "op": "setLayout", "layout": [ { "i": "strongest", "x": 0, "y": 0, "w": 3, "h": 2 } ] }
{ "op": "reorderWidget", "id": "strongest", "before": "per-day" }
{ "op": "addStep", "datasetId": "quakes", "step": { "type": "filter", "expr": "magnitude >= 4" }, "before": "s2" }
{ "op": "updateStep", "datasetId": "quakes", "stepId": "s1", "set": { "expr": "magnitude >= 5" } }
{ "op": "removeStep", "datasetId": "quakes", "stepId": "s3" }
{ "op": "moveStep", "datasetId": "quakes", "stepId": "s3", "before": null }
```

`updateWidget.set.config` is shallow-merged into the current config. Pipeline steps have stable ids (`s1`, `s2`, …, or
your own); prefer the step operations over replacing `transforms` wholesale, so concurrent edits by the user survive. Positions are optional everywhere; omitted ones are
auto-placed.

A `timeBucket` step keeps every bucket by default, including a first and last bucket the data covers only partly: a
rolling 7-day window bucketed per day gives 8 buckets, and the last one (today so far) looks like a sharp drop.
`"dropPartial": true` drops the first or last bucket when the data starts or ends more than one sampling interval (the
median gap between its times) inside it. Data with fewer than two distinct times is left alone.

The answer of `apply_operations`:

- `changes`: one line per operation (the same text the version history shows).
- `dataChecks`: one entry per dataset the batch added or changed, and per dataset built on those, loaded right away so a broken source surfaces at
  once: `rowCount` (rows after the whole pipeline), `columns` (`name:type`), `sampleRows` (the first 3 rows, a sample,
  not a count) and `error` when the dataset failed. `warning` (also in `get_data` and `preview_data`) means rows were
  served with a caveat, not a failure: a source cut to the cell limit, a cached copy after a failed refresh, or a parent
  over 100,000 rows. `notChecked` names columns that steps read but an empty source does not have; they are checked
  once it returns rows. When joining a dataset that may be empty, list `fields`: an empty dataset has no columns to
  bring, so without `fields` the later steps that read them fail. `truncated: true` means the result has more rows than the 10,000 that widgets receive.
  A result larger than 4 MB as JSON comes back as an `error` with its columns and no rows, for every reader alike:
  add `limit`, `select` or `aggregate` steps. Sample rows (here and in `get_data`, `preview_data`) stop at about
  200,000 characters, with a `note` when fewer rows than asked for fit. A check with `retryAfterSec` failed for now
  and may pass by asking again after that many seconds (`get_data`); its `note` says whether the change was saved (in
  a dry run: the operations are valid, nothing was saved) and names the cause: this server's own limit on requests to
  one host, which is not the source's fault, or a source still loading when the 20 s for the check ran out. The check
  of an accumulating dataset has a `note` on where its history is kept; two notes are joined in one.
- `warnings`, when there is something to fix that did not fail the batch (see "Secrets" and "Colour and formatting").

Sound cues are spelled out in `changes` whenever an operation adds, changes or removes one (trigger, sound, volume and
cooldown, defaults included), so there is no need to call `get_dashboard` to check them:

```text
Added kpi widget "Strongest"; sound cue: "alert" when `magnitude >= 6` becomes true on the last row (volume 0.7, cooldown 10 s)
Widget "Orders": sound cue set to "bell" when rows with a new "order_id" appear (volume 0.7, cooldown 10 s)
Widget "Orders": sound cue removed
```

## Colour and formatting

Wherever a colour can be set, it is a named token or `#rrggbb`. Tokens adapt to light and dark mode: `accent-1` …
`accent-8` are the chart palette in order, `positive`, `warning`, `serious`, `negative` and `neutral` the status
colours. Each token resolves per theme and per use: marks (lines, bars, arcs) take the palette or status colour, text
is adjusted until it has at least 4.5:1 contrast against the card, and table cells get a light tint under normal text.
Hex keeps working, so older documents and brand colours stay valid, but it does not adapt.

```jsonc
// Colour follows the entity: a map from series value, y column or slice label to a colour.
{ "op": "updateWidget", "id": "sun", "set": { "config": { "colors": { "sun": "warning", "shadow": "accent-1" } } } }
// A benchmark instead of a truncated axis (line, area, bar, scatter; at most 3).
{ "op": "updateWidget", "id": "stations", "set": { "config": { "referenceLines": [{ "stat": "avg", "label": "Network average" }] } } }
// KPI value bands and a change that is neither good nor bad.
{ "op": "updateWidget", "id": "temp", "set": { "config": { "goodWhen": "neutral", "bands": [{ "upTo": 0, "color": "accent-1" }] } } }
// Table column labels, per-column formats and bands, and row rules in the expression language.
{ "op": "updateWidget", "id": "orders", "set": { "config": {
  "columns": ["id", { "field": "total", "label": "Total", "format": { "style": "currency" } }, { "field": "stock", "bands": [{ "upTo": 5, "color": "warning" }] }],
  "rules": [{ "when": "status == \"late\"", "color": "negative", "label": "late orders" }] } } }
```

Unmapped series keep the automatic order on the palette slots the map left free, so a mapped colour never appears on
a second entity. `setMeta { colors }` sets the same kind of map for the whole dashboard; a widget's own map wins. Pie
and donut slices take their colour from their label, so they keep it when their sizes change. The array form of
`colors` still works and keeps its old meaning: a palette used in series order. A KPI's sparkline takes the colour of the entity a select filter narrows its data to (when that value has a dashboard colour); with nothing in focus on a dashboard with entity colours it is neutral grey, since a total is no entity.

`apply_operations` adds `warnings` (the batch is still saved) for the widgets it touched, and for the dashboard map
when it changed:

- a custom hex colour below 3:1 contrast against the card in either theme (WCAG non-text contrast);
- two entries of a colour map that resolve to the same colour;
- a bar chart (or stacked area) with `yMin` above zero: bars should start at zero, so use a reference line to show a
  benchmark. Such charts still render as configured.

Reference lines that cannot be drawn fail the batch: a chart kind without a value axis (pie, donut, funnel, radar,
heatmap), both or neither of `value` and `stat`, or a `field` that is not one of the chart's `y` columns.

## Live data: `refreshSec` and `accumulate`

The refresh loop runs on the server, but only while somebody watches: when the first browser opens a dashboard (its
live stream), the server starts reloading each dataset with `refreshSec > 0` on that interval and pushes changed
results to every viewer; when the last one leaves, the loop stops. MCP calls never start it. A dataset that uses
filters is not pushed: it has one result per view, so each viewer's page polls it at its interval with its own
filter values.

Every connector has a `minRefreshSec` (see `list_connectors`): the server caches its answers that long, to stay
within the upstream's rate limits. A `refreshSec` below it is not rejected but raised to the minimum when an
operation adds the dataset or changes its `refreshSec` or source (dry runs included), and `changes` gets a line of
its own:

```text
Raised refreshSec of dataset "Quakes" from 5 s to 60 s, the minimum of the earthquakes connector
```

Datasets the batch did not touch keep their stored value, so documents saved before a minimum went up still load and
accept unrelated edits. The web editor does not offer intervals below the minimum.

`accumulate: N` keeps the last N rows across loads and adds a `fetched_at` column. Precisely:

- The history is kept in server memory, per dashboard and dataset. A restart clears it, and so does changing the
  dataset's source (or replacing a secret it uses).
- It gains the current reading each time the dataset is **loaded** and the source has a **new** reading. Loads come
  from the refresh loop (every `refreshSec` while someone watches), page loads, and the tools that read data:
  `get_data`, `render_snapshot`, `suggest_widgets` and the data check of `apply_operations`.
- With nobody watching, the history therefore grows at the rhythm of those requests and has gaps where nothing asked.
  An agent polling `get_data` every 10 s sees one new row per call, whatever `refreshSec` says.
- A source never has a new reading more often than it updates: a connector at most every `minRefreshSec` (see
  `list_connectors`; the cache is shared by all dashboards), an `http` source every 30 s. Inline and upload sources
  count as new on every load, so do not accumulate them.

For accumulating datasets, `get_data` answers with `watchers` (open browsers right now) and a `note` with the summary
above; the data checks of `apply_operations` carry the same `note`.

## JSON sources: `path` and column-shaped data

`http` sources and JSON uploads find their records the same way:

1. `path` (optional, a dot path such as `"data.items"`) walks into the document. Empty parts are skipped and a list
   is walked by index (`"items.0"`). A path that does not exist fails with
   `Path "data.items" not found in the response (stopped at "data")`, or `in the file` for an upload.
2. A list is the records.
3. An object whose properties are all lists of the same length (at least 1) holding plain values (numbers, text,
   booleans, `null`), with at least two properties, is read as columns: row _i_ takes element _i_ of every list, and
   the columns keep the object's key order. Keys that are whole numbers (years, for example) come first, in ascending
   order: that is how JSON objects are read in JavaScript.

   ```json
   { "timestamps": ["2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z"], "values": [12.5, null], "status": ["ok", "warn"] }
   ```

   becomes two rows with the columns `timestamps` (a time), `values` and `status`.
4. Any other object: without a path its first list property, with a path the object itself as one record.
5. A single value (a number, a text), as the whole document or where the path ends: an `http` source fails with
   `The response does not contain a list of records`, an upload reads it as one record with the column `value`.

Lists of lists (`[[time, value], …]`, Prometheus `values`) are not converted. Column-shaped data is held to the same
cell limit as records: an `http` table is cut and says so in its warning, an upload over the limit is refused.

For an `http` source, `path` is part of the source and is applied on every fetch. For an upload it is a parameter of
`upload_data` (and of the upload in the web editor): it is applied once, when the file is stored, and the dataset
reads the table found there. Reading another part of the same file means uploading it again with another path. CSV
files ignore `path`; a path the file does not have refuses the upload and stores nothing.

## Combining datasets

A dataset can take its rows from another dataset of the same dashboard, and pipelines can join and append other
datasets. Use this instead of copying a source: the source is fetched once per request, refresh or snapshot, and
everything built on it stays in sync.

```jsonc
{ "op": "addDataset", "dataset": { "id": "ba", "name": "Bratislava", "source": { "kind": "connector", "connector": "weather.forecast", "params": { "city": "Bratislava" } }, "refreshSec": 900 } }
{ "op": "addDataset", "dataset": { "id": "brno", "name": "Brno", "source": { "kind": "connector", "connector": "weather.forecast", "params": { "city": "Brno" } }, "refreshSec": 900 } }
{ "op": "addDataset", "dataset": { "id": "temps", "name": "Temps (both cities)", "source": { "kind": "dataset", "id": "ba" },
  "transforms": [{ "type": "union", "with": ["brno"], "origin": "place" }] } }
{ "op": "addWidget", "widget": { "id": "temp-chart", "type": "chart", "datasetId": "temps", "config": { "kind": "line", "x": "time", "y": ["temperature_2m"], "series": "place" } } }
```

- `source: { "kind": "dataset", "id": "<dataset>" }` reads the other dataset's processed rows (its full table, not
  the 10,000 rows widgets get; a parent above 100,000 rows gives its last 100,000, with a warning). A derived dataset
  has no `refreshSec` or `accumulate` of its own: it refreshes when its source does. To keep a history, accumulate
  the source.
- `join { with, on, how, fields? }` adds columns where keys match: `on: ["country"]` when both sides use the name,
  `[{ "left": "code", "right": "iso" }]` otherwise, up to 4 keys. `how: "left"` (default) keeps every row, `"inner"`
  only rows with a match. Keys must have the same type; a time matches a number (both epoch ms), and text dates
  become times with `derive date(column)`. A repeated key gives one row per match; a null key matches nothing.
  Columns this dataset already has get `_<dataset id>`.
- `union { with, origin?, labels? }` appends the rows of up to 4 datasets, columns matched by name (missing ones are
  null, conflicting types become text). `origin` adds a column naming where each row came from; chart it with
  `series`. Labels default to dataset names (for a derived dataset's own rows, its source dataset's name); set them
  to keep series values (and their colours) stable when a dataset is renamed.
- Expressions can use whole-table functions over the rows at that point of the pipeline: `col_sum`, `col_avg`,
  `col_min`, `col_max`, `col_median`, `col_stddev`, `col_count`, `col_first`, `col_last`, each `(column, by?)`.
  Share of total: `{ "type": "derive", "as": "share", "expr": "round(sales / col_sum(sales) * 100, 1)" }`; above
  average: `{ "type": "filter", "expr": "temp > col_avg(temp, city)" }`.
- Limits: chains at most 4 deep, a dataset reads at most 8 others, joins and unions produce at most 100,000 rows (more
  is an error, never a silent cut). Only datasets of the same dashboard can be read.
- A dataset that others read cannot be removed; remove or re-point them first, earlier in the same batch.
  `removeDataset`'s `cascade` still only removes widgets.
- A problem upstream shows on every dataset built on it, naming the dataset that failed:
  `Source dataset "brno" failed: …`.
- While somebody watches, a live source refreshes every dataset built on it together with it; datasets that share a
  source refresh in the same round (a slow one paces the others of its group), and unrelated live datasets refresh
  independently. A dataset the chain reads that is not built on the source that ticked (an upload, inline rows, or an
  `http`, `feed` or connector source without a timer of its own) is taken from the table the server kept from an
  earlier refresh until the dashboard changes: at most 8 per watched dashboard, all dropped when the server runs
  short of memory, and loaded again (through the usual caches) when not kept. A preview never adds to a dataset's
  kept history (`accumulate`).
- `preview_data` of a `dataset` source or of join/union steps needs `dashboardId` and reads the saved datasets.
  Previewing anything whose lineage uses secrets needs the `dashboards:write` scope, as previewing the secret-backed
  source itself does. On a server that sets `ALLOW_PRIVATE_HOSTS`, so does previewing a lineage with an address only
  that list opens (plain `http://`, a port other than the default, or a private host) whenever the list applies to
  the preview: an editor's previews use the owner's network rights, anyone else's their own, so a saved root on a
  private host fails for a viewer without the list. Only editors' previews use the dashboard's secrets and uploads:
  for anyone else a lineage with a secret or an uploaded file is refused, and the saved roots of a viewer's derived
  preview load with the viewer's own rights.

## Filters

One dashboard can serve several regions, periods or cities. Declare filters with `addParameter` and reference them as
`$param.<id>` instead of copying datasets and widgets per value. Viewers set them in the dashboard header; the values
live in the page URL (`?p.region=eu&p.period=last7d`) and are never saved.

```jsonc
{ "op": "addParameter", "parameter": { "id": "region", "label": "Region", "type": "select", "options": [{ "value": "eu", "label": "EU" }, { "value": "us", "label": "US" }], "all": "All regions", "default": null } }
{ "op": "addStep", "datasetId": "sales", "step": { "type": "filter", "expr": "$param.region == null || region == $param.region" } }
```

- Types: `select` (options, optionally "All" whose value is `null`), `text` (for search, steps only) and `dateRange`
  (presets such as `last30d`, optionally custom ranges). A date range is used through its parts: `.from`/`.to`
  (`YYYY-MM-DD`, inclusive) and `.start`/`.end` (epoch ms, UTC, end exclusive). Compare a time column with
  `.start`/`.end`; `.from`/`.to` are text for URLs and bodies; compared with a time column they match wrongly (for
  example `>=` keeps no row, `<=` every row).
- Where: anywhere a value goes in filter and derive steps; a whole query value or path segment of an `http` or `feed`
  URL; a whole value of a POST body or of connector parameters. A query pair at "All" is left out. Never inside a
  host, a longer text or a query language: use the API's own parameters or GraphQL variables.
- Clicks: `crossFilter: { "parameter": "region", "field": "region" }` in a chart (bar, line, area, pie, donut,
  funnel; `field` is its `x` or `series`, but pie, donut and funnel allow only `x`, and an `x` must be categories, not
  a time column), table or map config makes a click set the filter, and a second click on the same item resets it.
  The other items are dimmed in the browser and in snapshots (on a map, a group of more than 2,000 plain dots, one
  series without size or colour, is not dimmed). The clicked widget should read a dataset without that filter, or it
  shows only the clicked item.
- Choices from data: a select may take `optionsFrom: { "dataset": "countries", "field": "code" }` instead of
  `options`: the distinct values of that column, at most 200, sorted. The dataset must not use a filter itself, the
  select offers "All" and starts at it, and such a filter never reaches a source with secrets.
- `get_data`, `render_snapshot`, `suggest_widgets` and `preview_data` take `parameters`, in the text form of a link
  (`"*"` is "All", a range is `2026-01-01..2026-03-31`); answers echo the values and the view's link. Without them
  the defaults apply, also for `apply_operations`' data checks.
- A link to a view (`/d/<id>?p.region=eu`, with `&present=1` for a wall screen) opens it; in the page, a value a
  filter no longer offers falls back to its default (a wall screen showing a filter whose choices come from data
  instead holds the value until the choice returns). `get_data`, `render_snapshot`, `suggest_widgets`,
  `preview_data` and `snapshot.png` answer an error for such a value.

## Maps

A `map` widget draws rows with a latitude and a longitude column on a built-in world map (Natural Earth 1:110m,
public domain): no API key, no tiles, no requests to third parties, so it looks the same in the browser, offline and
in `render_snapshot`.

```jsonc
{ "op": "addWidget", "widget": { "id": "quakes-map", "type": "map", "datasetId": "quakes", "config": { "lat": "latitude", "lon": "longitude", "size": "magnitude", "label": "place" } } }
{ "op": "addWidget", "widget": { "id": "iss-track", "type": "map", "datasetId": "iss", "config": { "lat": "latitude", "lon": "longitude", "mode": "track", "terminator": true } } }
```

- `mode: "points"` (default) draws a dot per row; `"track"` connects the rows in their order (sort by time first), one
  line per `series` value, split where it crosses the antimeridian, with the newest position marked.
- `size` scales the dot's area with a numeric column; `color` puts a numeric column on the sequential blue ramp;
  `series` gives each entity its categorical colour. `color` and `series` together are rejected: a map has one colour
  channel. Entity colours follow the same rules as charts: the widget's `colors` map, then the dashboard's
  (`setMeta { colors }`), then the palette slots left free, so a city has one colour on every chart and map.
- `terminator: true` shades the night side for the newest time in the data (its first time column, else when the
  data was fetched), never for the server's clock, so a snapshot and a live screen agree.
- `view: "fit"` (default) frames the data with some padding and at least 30° × 15°; `"world"` shows 60°S to 84°N.
  `basemap` is `countries` (default, de facto borders), `land` or `none`.
- Rows without valid coordinates are left out; the map's accessible description says how many. In the browser every
  map has a "Show as table" toggle.

`suggest_widgets` and `preview_data` propose a map whenever the profile finds `latitude` and `longitude` roles: points
sized by the first measure, or a track with night shading for accumulated positions (`accumulate` or a `fetched_at`
column).

## Status

A `status` widget turns "many checks, each with a state" (a monitor's JSON, Uptime Kuma, healthchecks, a script)
into one tile per entity, coloured by its worst check, so "is everything fine, and if not, what is broken and where"
is answered at a glance on a phone or an unattended wall screen.

```jsonc
{
  "op": "addWidget",
  "widget": {
    "id": "infra",
    "type": "status",
    "title": "Infra",
    "datasetId": "checks",
    "config": {
      "entity": "service",
      "status": "status",
      "group": "machine",
      "label": "name",
      "kind": "kind",
      "detail": "detail",
      "since": "since",
      "link": "url"
    }
  }
}
```

- Each row is a check. `entity` names its tile and `group` (optional) splits the tiles into sections; `label`,
  `kind`, `detail` and `since` are optional columns for the check's name, its kind (ok checks are summarised per kind,
  "container ×3"), the text shown in full for failing and warning checks, and when its state began ("9 hours ago").
- `link` (optional) names a column of web addresses, such as `https://status.example.com`. A tile then shows an
  ↗ icon after its name that opens the first http(s) address in its rows in a new tab, and the name in its list of
  checks is the same link; a click elsewhere on the tile still lists its checks. Other values (relative paths,
  `javascript:`) are ignored, and folds such as "+N more ok" carry no link. The editor and `suggest_widgets` take a
  column named `url`, `link` or `href`; `suggest_widgets` also one that holds addresses.
- Sections and tiles are ordered worst first (failing, warning, ok, then all off). Within a level they keep the order
  of their first row in the dataset, so a `sort` transform decides it, for example by an order column you add to the
  data; rows without a group or an entity are collected under "Other", last within its level.
- States are `fail`, `warn`, `ok` and `off` with common synonyms (`down`, `degraded`, `healthy`, `paused`, …),
  case-insensitive; `true`/`false` read as ok/fail; anything else counts as `warn`. `levels` maps other values.
- Nothing scrolls. When the widget is too small, off tiles fold into "+N off", then ok tiles into "+N more ok", then
  sections without problems into their header line, then the last of those lines into one "+N more sections · 12 ok"
  line, and that line goes too before any problem tile is hidden. A fold that would not make the widget shorter (three
  tiles that fill the row a "+3 more ok" cell would take) is skipped, so tiles keep their names wherever they fit.
  Problem tiles never fold into ok summaries; only when the problem tiles alone do not fit are their details cut to
  two lines and the rest counted in "+N more problems"; a section left without problem tiles folds into it. The
  summary line always counts everything. `render_snapshot` draws the same tiles and folds as a browser showing a
  body of that size.
- A click (or Enter) on a tile, a fold, a section header or the "+N more sections" line lists all its checks; Escape
  closes the list.
- `suggest_widgets` proposes it when a column is named `status`, `state` or `health`, or holds mostly status words
  (a small set of at most 12 distinct values). It comes first only when the rows look like one per check (at most 10
  rows per entity on average). An event log such as CI runs or payments, where a tile would keep the worst state of
  every row, and a column only named like a state are offered below the raw data table.

## Start pages: clocks, feeds and search

Three pieces make a dashboard work as a browser start page. Each is documented in `get_reference`.

```jsonc
{ "op": "addWidget", "widget": { "id": "time", "type": "clock", "config": { "timeZone": "Europe/Bratislava" } } }
{ "op": "addDataset", "dataset": { "id": "news", "name": "BBC News", "source": { "kind": "feed", "url": "https://www.bbc.com/news" }, "refreshSec": 300 } }
{ "op": "addWidget", "widget": { "id": "headlines", "type": "table", "datasetId": "news", "title": "BBC News", "config": { "style": "list", "pageSize": 8, "columns": [{ "field": "title", "link": "link" }, "source", "published"] } } }
{ "op": "addWidget", "widget": { "id": "find", "type": "search", "config": { "engine": "duckduckgo" } } }
```

- `clock` has no dataset. Without `timeZone` it shows each viewer's local time (snapshots draw it in UTC and say so).
  Digital is the default because many people read analog clocks slowly.
- A `feed` source reads RSS, Atom and JSON Feed, or a web page that announces one, into the columns `id`, `title`,
  `link`, `published`, `summary`, `author`, `source` and `image`, newest first. It is fetched at most every 5 minutes
  per address; a lower `refreshSec` is raised on save. Feeds take no secrets, and `apply_operations` warns when a feed
  URL carries something that looks like a token.
- A table with `style: "list"` reads like headlines; a column's `link` names the column holding its URL (only
  `http(s)` links are rendered). A sound cue with `{ kind: "newRows", key: "id" }` plays for every new article.
- `search` opens the chosen engine's results in the browser; the query never reaches the server.

## POST queries

Some read APIs take their query in a POST body: GraphQL (GitHub), PostHog, ClickHouse over HTTP, Sentry, Notion
search. An `http` source sends one with `method: "POST"` and a JSON `body`:

```jsonc
{
  "op": "addDataset",
  "dataset": {
    "id": "me",
    "name": "GitHub account",
    "source": {
      "kind": "http",
      "url": "https://api.github.com/graphql",
      "method": "POST",
      "body": { "query": "{ viewer { login } }" },
      "secrets": ["sec_…"],
      "path": "data.viewer"
    }
  }
}
```

- Without `method` a source is a GET, as before. `body` (any JSON value, at most 16,384 characters as JSON and 32 levels
  deep) needs `method: "POST"`; a POST without `body` sends an empty one. The body goes out as `application/json`.
- GraphQL needs the object `{ "query": "…" }`, not the bare query text. A string body is sent as a JSON string, and a
  string that looks like JSON is refused.
- **Read queries only.** The request repeats on every refresh, preview and load. An identical body is answered from
  the 30 s cache; datasets that send the same address and body at the same time share one request, whatever their
  `path`; two different bodies on one URL never share a cached response.
- **No secrets in the body.** It is part of the document, so editors, agents, exports and the viewers of a public
  dashboard see it. Keys stay in secrets (below), sent as a header or query parameter; GraphQL and analytics APIs
  read their token from a header.
- **No redirects.** A redirect answer to a POST is an error: following it would resend the body to another address or
  silently turn it into a GET. Use the final address.
- **Previews need write access.** A token without `dashboards:write` cannot preview a POST source (`preview_data`, or
  the REST preview endpoint with such a token): it is refused before anything is sent, because a POST of the caller's
  choosing could change data at the API. Saved dashboards with POST sources still load for everyone who may view them.
- Everything else works as for a GET: the address rules, secret bindings, response limits and `path`.

## Secrets

Some APIs need a key. When the operator turned the feature on (`SECRETS=admins` or `users`, see
[deployment](deployment.md#secrets-for-http-sources)), the user saves keys in the web app under
`PUBLIC_URL/settings#secrets`, each bound to an origin and path prefix. Agents:

- **can** list them with `list_secrets` (names, ids, where each may be sent, how it is sent) and reference them by id
  in the user's own dashboards:

  ```jsonc
  { "op": "updateDataset", "id": "orders", "set": { "source": { "kind": "http", "url": "https://shop.example.com/api/orders", "secrets": ["sec_…"] } } }
  ```

  The URL must start with the secret's origin and path prefix, or the batch fails; at most 3 per source. The data a
  secret unlocks comes back from `preview_data`, `get_data` and `render_snapshot` like any other data, with echoed
  values redacted.
- **cannot** read, create, replace or delete a value. There is no write tool, and the REST endpoints for secret values
  refuse every bearer token, OAuth and personal access tokens alike: a value would otherwise pass through the model,
  its provider's logs and the chat transcript. If an API needs a key the user has not saved, ask them to add it.
- **cannot** publish data fetched with secrets: `set_visibility` refuses to make a dashboard with secret-backed
  datasets public, and a public dashboard that holds any secret reference is read-only for agents (operations, dry
  runs and restores are all refused). Only the user can change it, in the web app, after a confirmation. An agent
  may still make such a dashboard private, which only narrows access.
- **need write access to preview with secrets:** `preview_data` on a source that references secrets requires the
  `dashboards:write` scope, because it sends the credentials to a URL the agent chooses.

These rules restrict references and public dashboards. They cannot stop an agent from copying data it has read (for
example from `get_data`) into an inline dataset elsewhere; agents are told not to.

`apply_operations` answers with a `warnings` array when a touched dataset's URL has a query parameter that looks like
a credential (`key`, `api_key`, `token`, `access_token`, `secret`, `password`, `auth`, `signature`, …). Keys never
belong in a URL, a dataset name or a text widget: everything in the document is visible to every editor, agent and,
on public dashboards, viewer.

The residual risk: an agent, perhaps steered by a prompt injection in data it read, can still use a secret against
other paths of its bound address and show the result in the user's private dashboards. Least-privilege keys and a
narrow path prefix limit this.

## Example: calling the server from a script

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://dash.example.com/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${process.env.PATCHBAY_TOKEN}` } },
  }),
);

const { content } = await client.callTool({
  name: 'apply_operations',
  arguments: {
    dashboardId: 'x7k2abcd9mnp',
    operations: [{ op: 'updateDataset', id: 'sales', set: { refreshSec: 60 } }],
  },
});
```

## Safety properties

- Operations are validated against strict schemas and integrity rules before anything is written; invalid batches
  change nothing and the error names the failing operation.
- Expressions are interpreted by a tiny, whitelisted language: no property access, no globals, bounded size.
- Agents act as the signed-in user, with the same permissions as the web UI, and cannot touch other users' private
  dashboards.
- Requests are rate limited per user; write tools cost more than read tools.
- Every change is a version with the agent's name on it, visible and restorable in the UI.
- Secret values are never readable through MCP, and agents cannot store, change or publish them (see "Secrets").
- Sources reach only public `https://` addresses unless the operator lists hosts of their own network in
  `ALLOW_PRIVATE_HOSTS`; `get_reference` tells each user which, if any, their dashboards may use.
- An `http` source may send a POST with a JSON body to a read API. A redirect answer to a POST is an error, never
  followed, keys stay in secrets, never in the body, and a read-only token cannot preview a POST source.
- Filter values choose only among what an editor declared and fill only whole values in fixed places: never a host,
  never free text in a request, never the path of a source with secrets. They are bound before every other check, so
  the SSRF guard and secret bindings judge the real request, and they are never stored.
