# Architecture

This document explains how Patchbay is put together and, more importantly, why. Each decision lists the alternatives
that were rejected, so future changes can revisit the reasoning instead of guessing it.

## 1. Shape of the system

```
packages/core   pure TypeScript, no I/O       ← used by the server AND the browser
apps/server     Hono on Node, one process     ← REST, SSE, MCP, OAuth AS, connectors, storage, PNG renderer
apps/web        React SPA (Vite)              ← landing, editor, settings, admin
```

`@patchbay/core` is the heart. It owns the dashboard document schema, the edit operations, the layout algorithm, the
expression language, the transform pipeline, dataset profiling, widget suggestions and the ECharts option builders. It
has no dependencies besides Zod, so it runs unchanged in Node and in the browser, and almost all of the interesting
logic is covered by fast unit tests.

## 2. The document and the operation layer

A dashboard is one JSON document:

```ts
{ schemaVersion: 1, title, description, datasets: Dataset[], widgets: Widget[], layout: LayoutItem[], colors?, parameters? }
```

- **Datasets** describe where data comes from (`source`) and how it is processed (`transforms`), plus live behaviour
  (`refreshSec`, `accumulate`).
- **Widgets** describe how a dataset is shown (`chart`, `kpi`, `gauge`, `table`, `map`, `status`), or show something that needs no
  dataset (`text`, `clock`, `search`). Several widgets can share one dataset.
  `text`, `clock` and `search` show no dataset (`isDataWidgetType`): no `datasetId`, no data query, no sound.
- **Layout** is a single 12-column grid. Small screens stack widgets in reading order; there is deliberately no second,
  hand-maintained mobile layout to drift out of sync. On a phone the editor therefore only reorders (`reorderWidget`
  moves a widget in reading order and the widgets in between trade places on the same grid, see `reorderLayout`);
  sizes and side-by-side placement are edited on a wider screen.
- **Colors** (optional) map entities (series values, columns, slice labels) to colours for every chart of the
  dashboard. It is absent unless set, so documents without it round-trip unchanged.
- **Parameters** (optional) declare the dashboard's filters; see §4 (Filters).

All schemas are `z.strictObject`: unknown keys are errors. A typo in an agent's config (`colour` instead of `colors`)
fails loudly instead of being silently ignored.

Changes are expressed as **operations**: `addDataset`, `updateWidget { id, set }`, `moveWidget`, … `applyOps(doc, ops)`
applies a batch atomically and then validates the whole result (schema + integrity: unique ids, references, layout
consistency). Either the entire batch succeeds or nothing changes, and the error names the failing operation.

Why ops rather than "send me the whole new document"?

- Models produce small, id-addressed edits far more reliably than large documents.
- A change log falls out for free (`changes: ["Added kpi widget …"]`), which feeds version history and the "the agent
  changed X" toast.
- Ops can be **replayed** on a newer version. That is what makes concurrent human + agent editing pleasant (see §5).

Agents never send coordinates unless they want to: `addWidget` without a position is placed by `findSlot`, the same
function the editor uses, so a widget lands in the same spot no matter who added it.

## 3. Storage: a folder per dashboard

```
data/
  patchbay.db                  SQLite: users, sessions, tokens, secrets (encrypted), OAuth clients/codes, dashboard index
  dashboards/<id>/
    meta.json                  owner, visibility, edit-key hash, version, timestamps
    dashboard.json             the document
    versions/<n>.json          last 50 versions (at most 10 MB), each with actor and change log
    versions/index.json        actor, change log and size of each version, so listing never reads a document
    files/<fileId>.json        uploaded datasets, parsed once into typed tables (rows as arrays)
```

Files are compact JSON; folders from earlier releases are pretty-printed and read as they are (a missing
`versions/index.json` is rebuilt from the header of each version file). A copy of a dashboard shares its upload files
through hard links, so deleting either folder leaves the other intact.

**The folder is the source of truth; SQLite is an index.** Listing "my dashboards" or the admin overview needs queries,
so the index exists, but it can always be rebuilt from the folders (`DashboardIndex.reconcile`). It runs at startup,
every 15 minutes, and whenever the admin page is opened. Deleting a folder by hand is therefore a supported way to delete
a dashboard.

Folder names are random ids, not user names. Encoding the owner in the path would leak identities into backups and
logs, and would force a rename whenever an anonymous dashboard is claimed. The owner's id and email are stored inside
`meta.json`, so ownership survives even the loss of the SQLite file.

Writes are atomic (`write tmp` + `rename`) and serialised per dashboard with an in-process lock. Concurrency between
clients is handled with optimistic versioning (`baseVersion`), not locks.

SQLite is Node's built-in `node:sqlite`, not a native add-on: installing the project never needs a C++ toolchain,
which matters for contributors on Windows. _Rejected:_ Postgres (an extra service for data that is naturally document-shaped and per-dashboard), storing documents
inside SQLite (loses the "a dashboard is a folder" property and easy inspection). _Accepted cost:_ one process owns the
data directory, so scaling is vertical. A Postgres-backed index plus object storage would be the path to multiple
instances.

## 3a. Export and import

A dashboard can leave its server as one `.patchbay.json` file (_Details and sharing → Export file_) and come back as
a new dashboard on any server (_New dashboard → Import file_, or _Import_ on _My dashboards_):

```json
{
  "format": "patchbay-dashboard",
  "version": 1,
  "exportedAt": "2026-11-03T10:00:00.000Z",
  "secretsRemovedFrom": ["orders"],
  "doc": { "schemaVersion": 1, "title": "…", "datasets": [], "widgets": [], "layout": [] },
  "files": [
    {
      "id": "f_x1y2z3",
      "name": "sales.csv",
      "columns": [{ "name": "date", "type": "time" }],
      "data": [[1767225600000]]
    }
  ]
}
```

- The document is carried whole: dataset, step, widget, layout and file ids are never rewritten, so every reference
  inside it stays valid. Uploaded files travel as the typed tables the server stores (times as epoch milliseconds),
  so column types survive exactly; only files a dataset uses are included.
- Never in the file: stored secrets and secret references (they name one account's secrets on one server; the
  importer adds their own under Credentials), the owner, sharing settings, edit keys, version history and accumulated
  live history. A key someone typed straight into a dataset URL is part of the document and does travel; the export
  dialog warns about such URLs.
- Anyone who can view a dashboard can export its document, a read-only token included. Uploaded files are included
  only for its editors, the people who can already list and preview them.
- Limits: a file up to 32 MB, at most 20 files, 7 MB per table. A stored upload can take more than 7 MB as a table
  (packed, CSV values gain quotes and brackets and dates become 13-digit numbers), so the export dialog warns when an
  included table is near or over that limit: it is exported, but no Patchbay server imports it again. Anonymous
  imports are public, with the edit key kept in the importing browser; signed-in imports are private to the importer.
- `GET /api/dashboards/:id/export` streams the file within the response budget, a part of a table at a time (see
  [deployment](deployment.md#memory-budget)). An import is `POST /api/dashboards/import` with
  `{ doc, files: [{ id, name, rows, columns, bytes }] }`, which runs every rule a save runs and checks what the
  files will need before anything is created, then one `POST /api/dashboards/:id/files` per file with
  `{ name, format: "table", fileId, content }`. An upload may name its `fileId` only when a dataset uses that id and
  the dashboard does not have the file yet; a stored file is never replaced (`409 FILE_EXISTS`).
- A reader accepts every `version` up to its own and refuses newer files with a clear message; any change to the
  envelope's shape bumps `version`. Import also accepts a bare document and the answer of `GET /api/dashboards/:id`.

## 4. Data: connectors, pipelines, live updates

`DataService` resolves datasets in a **scope**, one per request, live tick, snapshot or MCP call: load source →
(optionally) accumulate → run pipeline → cap rows. A scope loads and processes each dataset of the document at most
once, however many datasets read it. Across scopes, the final capped result of a dataset in a lineage is reused for
a few seconds while the same roots give the same cached tables (keyed by the definitions it depends on, those
tables, the owner and the row cap), so a burst of viewers costs one run of the chain, not one per request.

- **Connectors** are small modules with a parameter spec, a `fetch` against a fixed upstream host, and a `sample` that
  produces deterministic synthetic data of the same shape. `OFFLINE=1` switches every connector to `sample`, which keeps
  CI, demos and screenshots independent of third-party uptime.
- A **TTL cache with in-flight de-duplication** sits in front of connectors. The TTL is the connector's minimum refresh
  interval, chosen to respect each free tier. If upstream fails, a copy up to an hour old is served with a warning
  instead of an empty widget.
- **Feeds** (`source.kind: "feed"`) take a user-supplied URL, so they go through the same SSRF guard as the `http`
  source (`safeFetchText`), never through a connector. `apps/server/src/feeds/` finds the feed a web page announces,
  parses RSS, Atom and JSON Feed into fixed columns and turns every text into plain text at parse time, so nothing
  downstream renders feed markup. A feed is fetched at most every 5 minutes per address, shared by all dashboards
  (publishers block faster polling); `OFFLINE=1` serves a deterministic sample.
- **JSON records** (`http` sources and JSON uploads) are found by one module in core (`packages/core/src/records.ts`):
  the optional dot `path`, then a list as records, an object of equally long lists of plain values (at least two) as
  columns turned into rows, any other object as its first list (without a path) or as one record. Column-shaped data
  is turned into at most one row more than the cell limit keeps, so a dense response never builds more than records
  would; an upload over the limit is measured and refused before any row is built. An upload's `path` comes with the
  upload request and is applied once, in the pipeline worker, before the file becomes its stored table; the stored
  file and the `upload` source do not record it.
- **Pipelines run on the server.** The browser, the MCP agent and the PNG renderer therefore always agree on the numbers,
  and the browser never downloads more than it displays (10,000 rows max, at most 4 MB as JSON).
- **Datasets can build on each other** (`source.kind: "dataset"`, and the `join` and `union` steps). The graph lives
  in `packages/core/src/lineage.ts` and is checked on every write: no unknown ids, no cycles, at most 4 levels and 8
  datasets read by one dataset, and no `refreshSec` or `accumulate` on a derived dataset (it refreshes with its
  source). A child always receives its parent's full processed table (up to 100,000 rows; a longer parent gives its
  last 100,000 and a warning), never the 10,000 rows sent to widgets, so aggregates over a derived dataset are not
  computed on a truncated input. A join or union produces at most 100,000 rows. The scope resolves the tables a join
  or union reads before the run, so a pipeline worker stays a pure function of its message, and credentials never
  leave the main thread. An upstream failure shows on every dataset built on it as `Source dataset "<id>" failed: …`
  (naming the dataset that actually failed); the age of a combined result is the age of its oldest input. Datasets
  read only datasets of the same document: one document has one owner, one visibility and one set of editors, which
  is what keeps the secret rules intact. Expressions can also use whole-table functions (`col_sum(x, by?)` …),
  computed once per step over the rows at that point of the pipeline. A preview of a draft never adds to a saved
  dataset's accumulated history, it only reads it.
- **Results are serialised once and shared** (`services/result-wire.ts`). The web app asks for rows as arrays
  (`?rows=arrays`, column names once instead of in every row; `decodeTable` in core turns them back); other clients
  get rows as objects. Concurrent readers of a result and every subscriber of a live push send the same bytes, and the
  bodies still being read stay within a byte budget (12 MB, and 4 MB of bodies waiting); beyond it requests wait
  briefly, then get 503.
- **Large pipelines run in worker threads** (`services/pipeline-pool.ts`). Inputs under 20,000 cells run inline,
  because copying them to a worker costs more than processing them; larger ones go to a pool of `worker_threads`
  (CPUs − 1, at most 4), so one heavy dashboard never blocks the API for everyone else. Each job has a hard time limit:
  a runaway job's worker is terminated and replaced, the only reliable way to stop a computation in JavaScript.
  Workers report readiness before receiving jobs, so start-up never counts against the limit, and a bounded queue
  turns overload into a clear "busy" error instead of unbounded memory. `PIPELINE_WORKERS=0` disables the pool.
- **Snapshots render in a worker thread of their own** (`render/worker-host.ts`), one at a time, with a heap limit and
  a 15 s hard limit; a render over either has its worker terminated, and the next starts a fresh one once the old one
  is gone. The worker starts on the first snapshot and stops after a minute without one. The main thread only resolves
  the data and copies the tables over, so a heavy render never delays the API or the health check. What one snapshot
  draws is bounded: 10,000 marks (dots, bars, cells) and 100,000 line points across all its charts, shared fairly and
  trimmed to each widget's newest rows, plus backstops on draw time and SVG size after which the remaining charts
  are left out with a note on their cards.
- **Heavy jobs take turns** (`util/heavy.ts`). Each worker has its own heap limit, but a small container cannot hold
  all of them at their peak at once, next to an upload being parsed and saved on the main thread. Drawing a snapshot,
  an upload from parse to disk, loading a large stored upload, a pipeline over 100,000 cells or more and parsing a feed
  of 512 KB or more therefore run one at a time across the process; small jobs never wait. Workers collect their
  garbage after a large job, so the next one starts next to an emptied heap. The budget is in
  [deployment.md](deployment.md#memory-budget).
- **Admission by real memory use** (`util/memory-pressure.ts`). The gates bound each kind of work; the container's
  OOM killer sees their sum. The server reads its cgroup's memory use (without page cache the kernel can drop) at
  most every 250 ms and on a 10 s timer. Above a soft threshold it refuses to start new heavy work (except one job
  on a server that has rested for 30 s with room for it), above a hard one also writes and new live streams, with 503
  and Retry-After; work already running finishes, and the health check and reads answered from memory keep working.
  Under pressure it also gives memory back: collections, idle workers stopped, and once idle for 30 s, empty caches,
  fresh pipeline workers and a compacted heap. The thresholds keep a fixed room free (128 MB and 64 MB), because a
  heavy job needs the same memory in any container. Details in [deployment.md](deployment.md#memory-guard).
- **Accumulate** turns "current value" sources (current weather, a spot price, the ISS position) into rolling time
  series by appending each new reading with a `fetched_at` column. The buffer is in memory by design; it is a live view,
  not a database.
- **Secrets for HTTP sources.** A dataset holds only secret ids;
  `DataService` asks `DashboardService.credentialsFor` for the values, resolved against the **dashboard owner's**
  secrets (never the viewer's, the editor's or the agent's), and gets an `HttpError` with a generic message when they
  cannot be used. A dataset whose secrets cannot all be resolved is never fetched without them. `safeFetchJson` keeps
  every SSRF rule, checks each secret's origin and path-prefix binding on every hop (a redirect elsewhere stops the
  request), adds the header or query parameter to that hop only, and redacts echoed values from the parsed JSON.
  Errors quote the document's URL, never the request. The HTTP cache key includes the owner, secret id and revision,
  so a public dataset never gets a secret-backed response, two users never share one, and replacing a value
  invalidates at once. Values are decrypted per request and never reach pipeline workers, which only see rows.
- **POST sources.** An `http` source with `method: "POST"` sends its JSON `body` (at most 16,384 characters as JSON and
  32 levels deep, checked by the schema on every write path) through the same `safeFetchJson`: the SSRF guard, the
  private-host policy, secret bindings and limits apply unchanged. A 3xx answer to a POST is an error, never followed,
  because following would resend the body elsewhere (307, 308) or turn it into a GET (301 to 303). The cache key adds
  the method and a SHA-256 of the body, so two queries on one URL never share a response; GET keys are unchanged.
  `DashboardService` refuses to preview a POST source for a read-only caller, since a preview sends a body of the
  caller's choosing; saved POST sources load for every viewer. Under `URL_SOURCES=signed-in` the showcase's URLs are
  trusted for GET only.
- **Filters (dashboard parameters).** A dashboard may declare filters (`parameters`) that viewers set in the header; the
  values live in the page URL (`p.<id>`), never in the document. Every scope binds them before anything is resolved
  (`bindDoc` in core): `$param.<id>` in a step becomes a literal token, in a URL a percent-encoded whole path segment or
  query value, in a body or connector a typed value. After binding a dataset is an ordinary one, so the HTTP cache, the
  connector cache, pipeline results and final results key each view by its bound definition without any key built by
  hand, and a dataset without references stays the same object with one cache entry for every view. Values are read
  against the saved declarations (400 otherwise); the bound URL goes through `assertMayFetchUrl`, safe-fetch and the
  secret binding like any saved URL. A snapshot's cache key adds the non-default values, and a dashboard snapshot prints
  the view under its title, in the same words as presentation mode (one formatter in core, `parameterSummary`).
  A chart, table or map may set a filter with a click (`crossFilter`); core decides what the selection is and dims
  the other items in the chart and map options, so the browser and the snapshot renderer draw the same thing. A select
  may take its choices from a column of a dataset that uses no filter: the server reads them through a scope before it
  checks a value, and refuses every value but All when they cannot be read.
- **Private hosts.** `ALLOW_PRIVATE_HOSTS` is parsed once (`util/private-hosts.ts`) into a policy object. There is no
  global: `DashboardService.assertMayFetchUrl` returns it for a dashboard whose owner `PRIVATE_HOSTS_FOR` names, and
  `DataService` passes it to `safeFetchJson` and, through `FeedService`, to `safeFetchText`. safe-fetch classifies each
  hop (public; https on 443 with the list: public or listed; plain http or another port: listed only) and checks every
  resolved address inside the socket's lookup, as for public addresses. Responses fetched with the list are cached
  under separate keys, so a dashboard without it never receives one. OAuth client documents never get the list.

**Live updates.** `LiveHub` keeps a "room" per dashboard while at least one browser is subscribed over SSE. Each live
dataset gets its own interval; a tick also re-runs every dataset that reads the one that ticked, parents first, taking
everything else from the room's latest tables, so a static sibling is not fetched again (an input that has no timer of
its own, `http`, `feed` and connector sources included, is reused from those tables until the dashboard changes; a room
keeps at most 8, drops them all when memory runs short, and loads any other through the data caches). Live datasets that
share a dataset refresh together, one round at a time, so a viewer never sees a child built from an older reading than
its parent: a slow member paces the chains of its own group, while unrelated live chains refresh independently. Results
are hashed and pushed only when the hash changed. N viewers share one refresh loop and an unwatched dashboard costs
nothing. Datasets that use filters have one result per view, so the hub leaves them out of its loops and chains;
browsers poll them at the dataset's interval, with their filter values in the query. A data answer for a relative period
(last 7 days, yesterday, …) names the window its rows were computed for and how long that window stays valid, and the
browser asks again when it expires, so a wall screen follows the server's midnight, not its own clock. An answer whose
error cannot pass by asking again (a deleted secret, a refused address) says so and is asked again only every 15
minutes, so a fix still shows up without a reload; other errors are retried every minute, also for datasets that never
refresh (a dataset with a regular interval keeps it). Both retries are spread over a few seconds so the widgets of a
wall screen do not ask at the same instant. SSE was chosen over WebSockets because traffic is one-directional (writes go
through normal HTTP requests), it works through every proxy, and reconnection is built into `EventSource`.

## 5. The editor: undo/redo and live collaboration with agents

The editor state (`apps/web/src/state/editor.ts`, Zustand) keeps:

- `doc`: the working document, changed only via `applyOps` from core;
- `past` / `future`: whole-document snapshots for undo/redo (cheap thanks to structural sharing; exact by construction);
- `saved` + `version`: what the server has;
- `pendingOps`: the ops applied since the last save.

Autosave sends the document with `baseVersion` 600 ms after the last change. When someone else saved in between (very
often an agent), the server answers `409` with the current version. The editor then **replays `pendingOps` on top of the
newer document**. Ops address things by id, so "I moved widget A" and "the agent added widget B" merge cleanly. Only if
replay fails, or the local delta is not replayable (after an undo), does the user get an explicit choice: keep mine or
use theirs. Nothing is silently discarded, and the other side's version stays in history either way.

A save can also come back `428`: it would show data fetched with secrets on a public dashboard (§7). The refused
document then waits in `secretsPrompt` and is not resent until the user confirms, edits further, or discards the
unsaved changes (an undoable step). A confirmation covers exactly the references the user saw, fingerprinted by
dataset, URL, secret ids, method and body (key order aside) and the choices of the filters the request sends, so
pointing the same secret at another URL or sending it another query later asks again.

The same holds for processing rules. Every pipeline step has a stable id (assigned automatically, `s1`, `s2`, …, which
also migrated older documents on read), and the editor saves a dataset edit as step operations computed by `diffSteps`
(`addStep`, `updateStep`, `removeStep`, `moveStep`) plus only the dataset fields that actually changed. If an agent
tightened the filter while the user was reordering the sort, both edits survive the rebase. Before step ids, the
pipeline was replaced as a whole and the last writer won.

Remote changes arriving over SSE while the user has no unsaved edits are applied immediately, the affected widgets
glow briefly, and the change becomes an undo step: _undo what the agent just did_ is a single Ctrl+Z.

## 6. The MCP server

Built on the official TypeScript SDK v2 (`createMcpHandler`), which serves the 2026-07-28 protocol and falls back to
stateless 2025-era handling for older clients. A fresh `McpServer` is created per request with the caller's identity.

Design rules for the tools:

- **Same service, same rules.** Tools call `DashboardService`, exactly like the REST API. There is no separate "AI
  permission model" to drift.
- **Validate before saving.** `apply_operations` has `dryRun`; `preview_data` runs any source and pipeline without
  saving; after saving, every touched dataset is executed and its row count or error is returned immediately.
- **Close the loop visually.** `render_snapshot` renders what the user sees.
- **Explain the data.** `preview_data`, `get_data` and `suggest_widgets` return a column profile (types, roles, ranges,
  null counts) and suggestions expressed as ready-to-apply operations, each with a rationale.
- **No destructive tools.** Agents cannot delete dashboards. Everything they change is versioned and restorable.

## 7. Authentication and authorization

- People sign in with Google (OIDC through `arctic`), sessions are random tokens stored as SHA-256 hashes, cookies are
  HttpOnly and SameSite=Lax, and cookie-authenticated writes must carry our own `Origin`.
- `DELETE /api/me` erases an account and everything it owns (session only, the email repeated in the body):
  dashboards first, under their locks, then secrets, tokens, grants, sessions and the user in one transaction, so a
  failed attempt can simply be repeated.
- MCP clients use the built-in OAuth 2.1 authorization server. The MCP specification asks resource servers to
  delegate to an identity provider; here the identity provider (Google) only authenticates the person, while Patchbay
  issues its own audience-bound tokens. Doing this in-process keeps self-hosting to a single container, at the cost of
  owning ~400 lines of security-sensitive code, which are covered by an end-to-end test of the full flow, including
  PKCE failure, code replay and refresh-token reuse detection.
- Permission rules live in one place (`DashboardService.canView/canEdit`): owners edit their dashboards, public
  dashboards are readable by anyone, private ones look like 404 to everyone else (no existence leak), anonymous
  dashboards are editable with an edit key, and admins can view and delete everything but not edit.
- **Secrets** are per user, in SQLite (`auth/secrets.ts`), sealed with AES-256-GCM under `SECRETS_KEY`; the
  associated data binds each ciphertext to its row, owner and binding, so a value copied elsewhere does not decrypt.
  The instance switch `SECRETS` (`off`, `admins`, `users`) is checked at use time. Values are written only through the
  web app's session (every bearer token is refused) and never read back by anyone. The same `DashboardService` rules
  hold at save time: anonymous dashboards never hold references (which is what makes claiming safe), new or re-pointed
  references must match their binding, tokens cannot change a public dashboard that holds references at all (nor make
  a dashboard with them public, nor preview them without the write scope), and a session must confirm (`428 confirm_public_secrets`, repeated with
  `confirmPublicSecrets: true`). The web app turns the 428 into a dialog; autosave holds the refused document until the
  user answers instead of retrying it. Viewers only ever see generic credential errors; the owner's editor explains
  them with the shared binding matcher from core.

## 8. Rendering

Charts use Apache ECharts. In the browser the canvas renderer handles tens of thousands of points; option updates are
merged so live data animates rather than redraws. On the server the same option object goes through ECharts' SSR SVG
renderer and is rasterised with `resvg` into a PNG, with no headless browser involved. The colour palette is a fixed,
colour-vision-deficiency-validated categorical order with separate light and dark steps; series colours follow the
series, never their rank, and there are no dual-axis charts.

Documents store colours as named tokens (`accent-1` … `accent-8`, `positive`, `warning`, `serious`, `negative`,
`neutral`) or hex. `resolveColor(color, theme, usage)` in `theme.ts` is the only place a colour becomes hex: marks take
the palette and status colours of the current theme, text is moved in OKLCH lightness (hue kept) until it reaches
4.5:1 against the card (`ensureContrast`), and table cells get a light tint under normal ink, which stays readable by
construction. A test checks every token in both themes. `seriesColors` (`colors.ts`) decides every series and slice
colour: the widget's map, then the dashboard's, then the automatic order over the palette slots left free; pies
colour slices by label, not rank, so a slice keeps its colour when values cross. Table cells (`cells.ts`: labels,
per-column formats, bands, row rules in the expression language), KPI value bands and reference lines are computed
in core as well, so the browser and the PNG renderer never disagree on a colour. _Rejected:_ colour by a hash of the
key (needs unvalidated hues), conditional colour as a pipeline step (presentation would leak into data and could not
follow the theme), free hex only (colours that vanish in one theme).

**Maps** use the same path. The base map is Natural Earth's 1:110m countries (public domain), committed as a 147 KB
GeoJSON (`packages/core/geo`) and drawn by ECharts' `geo` component in an equirectangular projection. `buildMapOption`
(`@patchbay/core/map`, an entry of its own) only refers to it by name; the browser registers it from a lazily loaded
chunk together with the map code and ECharts' geo, lines and custom parts, so dashboards without a map never download
them, and the snapshot renderer registers it at startup. The chunk is drawn by module reachability in
`apps/web/vite.config.ts`, which is why the web app imports ECharts by path instead of through its index modules;
`scripts/check-chunks.mjs` fails the build if any page imports the chunk statically. Entity colours come from `seriesColors`, like every chart's. The night shading is computed in core
(`solar.ts`) for the time of the data, so a snapshot and a live screen of the same rows draw the same picture.
_Rejected:_ tile maps (every viewer's browser would call a third party, the CSP would have to allow it, and snapshots
would need server-side tile fetching), ECharts' old bundled world map (unclear provenance), TopoJSON (40 % smaller on
the wire but a runtime dependency on both sides for a file that is cached anyway).

## 8b. Showcase use cases

The landing page can present ready-made use cases. Each one is a folder `showcase/<id>/` with `meta.json` (strict:
`id` equal to the folder name, lowercase words joined by single hyphens and at least 4 letters or digits, `order`,
`title` up to 60 characters, `tab` up to 24, `description` up to 200, optional `attachment`), `prompt.md` (1-4000
characters) and `dashboard.json` (a `DashboardDoc` within the 1 MB document limit, `LIMITS.documentBytes`, measured
as `DashboardService` measures every write, since every visitor's copy is such a write). Optional files:

- `video.mp4` (16:9 H.264, at most 5 MB) and `poster.jpg` (at most 150 KB), shown before the first frame of either
  video.
- `video-square.mp4` (1:1 H.264, at most 5 MB), the same recording for screens narrower than 768 px; without it they
  get the 16:9 video.
- One CSV attachment, the file the prompt came with, declared in `meta.json` as `"attachment": "<name>.csv"`
  (lowercase, at most 60 characters, in the same folder). It must be at most 200 KB and a rectangular CSV with a
  header and at least one row; the landing page shows it as a table and offers it as a download.

`budget.test.ts` fails when committed media or attachments exceed those sizes. A broken folder (a missing or invalid
`meta.json`, `prompt.md` or `dashboard.json`, or a document over the limit) is skipped with a warning; when two folders
carry the same dashboard id, the one that sorts first wins. The slug is at most 40 characters and the dashboard id is
cut to 32, so two long slugs that differ only after that point collide. An oversized video or poster, or an attachment
that is missing, too large or not valid CSV, is left out with a warning and the use case stays.

A use case's data must work for the owner `system` and in anonymous copies, so `dashboard.json` may not use `upload`
sources or reference stored secrets: such a folder is skipped with a warning. Use `inline` rows (at most
`LIMITS.inlineRows`), built-in connectors or public URLs.

At startup the server reads `SHOWCASE_DIR` and syncs one public dashboard per use case, with the stable id
`sc<slug without hyphens>`, owned by `system`. These dashboards are read-only for everyone, admins included, never
pruned and not counted in the anonymous storage limit. A changed `dashboard.json` becomes a new version; an id owned
by anyone else is never touched. Anyone can make an editable copy. With `URL_SOURCES=signed-in`, the exact http and
feed URLs used by showcase dashboards are trusted (exact match, no prefixes), so anonymous copies keep working. A use
case whose sync fails (a corrupt stored dashboard, an id owned by someone else) is left out of the list and the
routes; a failed sync never keeps the server from starting. An admin can delete a showcase dashboard, but it comes
back at the next restart.

Routes:

- `GET /api/use-cases` lists them (`public, max-age=300`), with media and attachment URLs that carry the content hash
  as `?v=`, so a deploy that changes a file changes its URL.
- `GET /showcase/<id>` redirects (302) to the dashboard.
- `/showcase/<id>/video.mp4`, `/video-square.mp4`, `/poster.jpg` and `/<name>.csv` (the declared attachment only,
  matched by name and never used as a path, sent as `text/csv` with `Content-Disposition: attachment`) answer GET and
  HEAD with single byte ranges (multiple or unsatisfiable ranges get 416), an ETag (content hash) that turns
  `If-None-Match` into 304, and `public, max-age=86400`.
- Anything else under `/showcase/` is a 404, never the app shell.

The service worker does not cache these files. The videos are produced outside this repository; only the final MP4
and poster are committed. Sizes and ETags are read at startup, so restart after changing media files. The media
routes sit outside the API rate limiter; that is fine behind a CDN, and self-hosters who expose the server directly
may want a limit in their reverse proxy.

## 9. Known limits and next steps

- Live updates send the whole processed table on every change. For rolling windows that is mostly redundant;
  [idea 0001](ideas/0001-sse-deltas.md) specifies incremental deltas. It needs no new infrastructure and is
  deliberately left for when the traffic is measurable.
- One process owns the data directory (see §3). Horizontal scaling would need Postgres, object storage and a pub/sub
  for the live hub; nothing below that scale needs an extra service.

## 10. Testing strategy

- `packages/core`: unit tests for the expression language (including injection attempts), every transform, the dataset graph (cycles,
  limits, lineage keys), join and union, whole-table functions, op atomicity,
  colour tokens and contrast in both themes, series colours, table cell styling, reference lines,
  layout normalisation, profiling and suggestions.
- `apps/server`: worker pool and render worker tests (identical results to inline, main thread stays responsive,
  timeouts and running out of heap replace the worker, queue limit), resolution scopes (one load per shared parent,
  error and age propagation), live refresh of dependents, a replay of the field-test dashboards with derived datasets
  (same rows, byte-identical PNG as the hand-made copies), and integration tests through `app.request()` against a real temporary data directory: permissions,
  conflicts, claims, uploads, versioning, folder deletion, admin access, the complete OAuth flow, and MCP tools driven by
  the official MCP client.
- The web app was verified end to end with Playwright during development (editing, undo, live agent edits arriving in an
  open browser, mobile and dark layouts).
