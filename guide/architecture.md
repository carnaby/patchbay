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
{ schemaVersion: 1, title, description, datasets: Dataset[], widgets: Widget[], layout: LayoutItem[] }
```

- **Datasets** describe where data comes from (`source`) and how it is processed (`transforms`), plus live behaviour
  (`refreshSec`, `accumulate`).
- **Widgets** describe how a dataset is shown (`chart`, `kpi`, `gauge`, `table`, `text`). Several widgets can share one dataset.
- **Layout** is a single 12-column grid. Small screens stack widgets in reading order; there is deliberately no second,
  hand-maintained mobile layout to drift out of sync. On a phone the editor therefore only reorders (`reorderWidget`
  moves a widget in reading order and the widgets in between trade places on the same grid, see `reorderLayout`);
  sizes and side-by-side placement are edited on a wider screen.

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
    versions/<n>.json          last 50 versions, each with actor and change log
    files/<fileId>.json        uploaded datasets, parsed once into typed tables
```

**The folder is the source of truth; SQLite is an index.** Listing "my dashboards" or the admin overview needs queries,
so the index exists, but it can always be rebuilt from the folders (`DashboardIndex.reconcile`). It runs at startup,
every 15 minutes, and whenever the admin page is opened. Deleting a folder by hand is therefore a supported way to delete
a dashboard, which is exactly what the brief asked for.

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

## 4. Data: connectors, pipelines, live updates

`DataService.resolve(dataset)` = load source → (optionally) accumulate → run pipeline → cap rows.

- **Connectors** are small modules with a parameter spec, a `fetch` against a fixed upstream host, and a `sample` that
  produces deterministic synthetic data of the same shape. `OFFLINE=1` switches every connector to `sample`, which keeps
  CI, demos and screenshots independent of third-party uptime.
- A **TTL cache with in-flight de-duplication** sits in front of connectors. The TTL is the connector's minimum refresh
  interval, chosen to respect each free tier. If upstream fails, a copy up to an hour old is served with a warning
  instead of an empty widget.
- **Pipelines run on the server.** The browser, the MCP agent and the PNG renderer therefore always agree on the numbers,
  and the browser never downloads more than it displays (10,000 rows max).
- **Large pipelines run in worker threads** (`services/pipeline-pool.ts`). Inputs under 20,000 cells run inline,
  because copying them to a worker costs more than processing them; larger ones go to a pool of `worker_threads`
  (CPUs − 1, at most 4), so one heavy dashboard never blocks the API for everyone else. Each job has a hard time limit:
  a runaway job's worker is terminated and replaced, the only reliable way to stop a computation in JavaScript.
  Workers report readiness before receiving jobs, so start-up never counts against the limit, and a bounded queue
  turns overload into a clear "busy" error instead of unbounded memory. `PIPELINE_WORKERS=0` disables the pool.
- **Accumulate** turns "current value" sources (current weather, a spot price, the ISS position) into rolling time
  series by appending each new reading with a `fetched_at` column. The buffer is in memory by design; it is a live view,
  not a database.
- **Secrets for HTTP sources** (design record kept by the maintainer). A dataset holds only secret ids;
  `DataService` asks `DashboardService.credentialsFor` for the values, resolved against the **dashboard owner's**
  secrets (never the viewer's, the editor's or the agent's), and gets an `HttpError` with a generic message when they
  cannot be used. A dataset whose secrets cannot all be resolved is never fetched without them. `safeFetchJson` keeps
  every SSRF rule, checks each secret's origin and path-prefix binding on every hop (a redirect elsewhere stops the
  request), adds the header or query parameter to that hop only, and redacts echoed values from the parsed JSON.
  Errors quote the document's URL, never the request. The HTTP cache key includes the owner, secret id and revision,
  so a public dataset never gets a secret-backed response, two users never share one, and replacing a value
  invalidates at once. Values are decrypted per request and never reach pipeline workers, which only see rows.

**Live updates.** `LiveHub` keeps a "room" per dashboard while at least one browser is subscribed over SSE. Each live
dataset gets its own interval; results are hashed and pushed only when the hash changed. N viewers share one refresh
loop and an unwatched dashboard costs nothing. SSE was chosen over WebSockets because traffic is one-directional
(writes go through normal HTTP requests), it works through every proxy, and reconnection is built into `EventSource`.

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
dataset, URL and secret ids, so pointing the same secret at another URL later asks again.

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

## 9. Known limits and next steps

- Live updates send the whole processed table on every change. For rolling windows that is mostly redundant;
  [idea 0001](ideas/0001-sse-deltas.md) specifies incremental deltas. It needs no new infrastructure and is
  deliberately left for when the traffic is measurable.
- One process owns the data directory (see §3). Horizontal scaling would need Postgres, object storage and a pub/sub
  for the live hub; nothing below that scale needs an extra service.

## 10. Testing strategy

- `packages/core`: unit tests for the expression language (including injection attempts), every transform, op atomicity,
  layout normalisation, profiling and suggestions.
- `apps/server`: worker pool tests (identical results to inline, main thread stays responsive, timeouts replace the
  worker, queue limit), and integration tests through `app.request()` against a real temporary data directory: permissions,
  conflicts, claims, uploads, versioning, folder deletion, admin access, the complete OAuth flow, and MCP tools driven by
  the official MCP client.
- The web app was verified end to end with Playwright during development (editing, undo, live agent edits arriving in an
  open browser, mobile and dark layouts).
