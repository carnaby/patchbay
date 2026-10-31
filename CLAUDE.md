# Patchbay: notes for contributors and coding agents

Monorepo (pnpm): `packages/core` (pure domain logic, shared), `apps/server` (Hono, Node type stripping, no build step),
`apps/web` (React 19 + Vite + Tailwind v4).

## Commands

- `pnpm dev` runs the API (:8787) and the web app (:5173, proxies the API). Copy `.env.example` to `.env` first.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` must pass before committing. `pnpm format` fixes formatting.
- `OFFLINE=1` makes every connector return synthetic data (no network needed).

## Rules of the codebase

- All dashboard changes go through `applyOps` (packages/core/src/ops.ts). Do not mutate documents any other way, on
  the server or in the editor.
- Permission checks live only in `DashboardService` (apps/server/src/services/dashboards.ts). The REST API and the MCP
  tools both call it; never re-implement checks in a route.
- Schemas are strict (`z.strictObject`). When adding a field, add it to the schema, the reference text
  (apps/server/src/mcp/reference.ts) and, if it is editable, the editor.
- Server code runs with Node's type stripping: only erasable TypeScript (no enums, no parameter properties, no
  namespaces) and `.ts` extensions in relative imports.
- New connector: one file in apps/server/src/connectors with `info`, `fetch` and an offline `sample`, registered in
  `registry.ts`.
- English only: UI text, comments, docs. Comments explain why, not what.
- Charts: fixed categorical palette order (packages/core/src/theme.ts), no dual axes, colour follows the entity.
- Pipelines run through `PipelineRunner` (apps/server/src/services/pipeline-pool.ts), never by calling
  `runPipeline` from request code: large inputs must stay off the main thread.
- Editing a pipeline means step ops (`diffSteps` in core), not replacing `transforms`, so rebases merge per step.
- Public documentation lives in `guide/` (deployment, MCP reference, architecture) and `guide/ideas/` (specified
  ideas open to contributors). `docs/` is the maintainer's private, gitignored folder: design proposals, plans,
  handoffs. Never commit it, never link to it from public files, and keep it out of the Docker build context.
- README images live in `.github/assets/`. `.github/assets/social-preview.png` (1280×640) is uploaded by hand in the
  GitHub repository settings; `apps/web/public/og.png` (1200×630) is the link preview image.
- Nothing owner-specific in the code: the served `index.html` gets its absolute URLs from `PUBLIC_URL` and, only when
  `UMAMI_SCRIPT_URL` and `UMAMI_WEBSITE_ID` are set, the Umami tracker (apps/server/src/util/index-html.ts). Without
  them no tracker is loaded. Routes whose path carries an ID must be normalized in
  apps/web/public/umami-hook.js.
- The service worker (apps/web/public/sw.js) must never cache `/api`, `/auth`, `/oauth`, `/mcp` or live streams:
  dashboards show live data and must not go stale. It only caches hashed `/assets/*` and the offline page. Bump
  `VERSION` in sw.js when its caching logic changes. The server serves sw.js and the manifest with `no-cache`.
- Sound cue rules live in `soundDecision` (packages/core/src/sound.ts), not in components. The web app decides once
  per result by listening to the query cache (apps/web/src/state/sound-cues.ts); never trigger sounds from a widget
  render or an editor preview. The first result after load, reconnect or a definition change is only a baseline.
- User-supplied URLs are fetched only through `util/safe-fetch.ts` (`safeFetchJson`, `safeFetchText`): the SSRF guard
  is there. Feed text becomes plain text at parse time (apps/server/src/feeds/parse.ts) and links are http(s) only;
  never render feed markup. Data-free widgets (`text`, `clock`, `search`) are told apart with `isDataWidgetType`.
- Landing page use cases live in `showcase/<id>/` (format in `showcase/README.md`). Their videos are produced outside
  this repository; commit only the final MP4 and poster. `budget.test.ts` enforces 5 MB and 150 KB.
- Presentation mode (apps/web/src/editor/presentation.tsx) must keep working without user input after the first
  click: it is used unattended on wall screens and TVs.

## Memory (Tabula)

Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `patchbay`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `patchbay` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At handoff run `tabula push` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.
