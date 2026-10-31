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
Access tokens live 1 hour, refresh tokens 30 days. Users can see and revoke connected clients under _Settings_.

Scopes:

- `dashboards:read`: list and read your dashboards and their data, preview sources, render snapshots.
- `dashboards:write`: create and change dashboards and upload data. Every change is versioned. Includes using the
  user's saved secrets in their own dashboards (never reading them); the consent screen says so.

## Tools

| Tool               | Scope | What it does                                                                                                                                                                                                                                                |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_reference`    | read  | The full authoring guide: document schema, transforms, expression functions, widget configs, design rules.                                                                                                                                                  |
| `list_connectors`  | read  | Built-in public data sources and their parameters.                                                                                                                                                                                                          |
| `list_dashboards`  | read  | The user's dashboards with URLs.                                                                                                                                                                                                                            |
| `get_dashboard`    | read  | One dashboard's document and metadata.                                                                                                                                                                                                                      |
| `preview_data`     | read  | Run a source + transforms **without saving**: columns, sample rows, row count per step, column profile, suggested widgets as operations.                                                                                                                    |
| `get_data`         | read  | The processed rows of a saved dataset, with `rowCount` and a profile. `limit` (default 50) keeps the first rows; `from: "end"` keeps the last ones instead, i.e. the newest of an ascending time series.                                                    |
| `suggest_widgets`  | read  | Rules-based visualisation suggestions for a saved dataset, as ready-to-apply operations with rationales.                                                                                                                                                    |
| `render_snapshot`  | read  | PNG of the dashboard or a single widget (light or dark), plus any data errors.                                                                                                                                                                              |
| `list_versions`    | read  | Version history with actor and change log.                                                                                                                                                                                                                  |
| `list_secrets`     | read  | The user's saved secrets for HTTP sources: id, name, origin, path prefix, how each is sent, timestamps. Never values. See "Secrets" below.                                                                                                                  |
| `create_dashboard` | write | New dashboard (private by default), optionally from a template.                                                                                                                                                                                             |
| `apply_operations` | write | Atomic batch of operations; `dryRun` to validate only; `baseVersion` for optimistic concurrency. Returns the change log, a data check for every touched dataset and `warnings` (a URL that looks like it holds a key, hard-to-see colours, truncated bars). |
| `upload_data`      | write | Store CSV/JSON (≤ 5 MB) in a dashboard; returns the file id, profile, a ready `addDataset` op and suggestions.                                                                                                                                              |
| `restore_version`  | write | Restore an earlier version (as a new version).                                                                                                                                                                                                              |
| `set_visibility`   | write | Public or private.                                                                                                                                                                                                                                          |

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
- `dataChecks`: one entry per dataset the batch added or changed, loaded right away so a broken source surfaces at
  once: `rowCount` (rows after the whole pipeline), `columns` (`name:type`), `sampleRows` (the first 3 rows, a sample,
  not a count) and `error`. `truncated: true` means the result has more rows than the 10,000 that widgets receive.
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
`colors` still works and keeps its old meaning: a palette used in series order.

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
results to every viewer; when the last one leaves, the loop stops. MCP calls never start it.

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
