# Contributing to Patchbay

Thanks for helping. Bug reports, connector requests, documentation fixes and code are all welcome.

- **Small fixes** (a typo, a clear bug with an obvious fix): open a pull request directly.
- **Larger changes** (a new feature, a new widget type, a schema change, anything that touches several packages):
  open an issue first, so we can agree on the approach before you spend time on it.
- **Ideas that are already specified** live in [guide/ideas/](guide/ideas/). They are open to contributors; say in
  an issue that you are taking one.
- **Security problems** never go into issues: see [SECURITY.md](SECURITY.md).

Everything in this repository is written in English: UI text, comments, docs, commit messages.

## Setup

You need Node.js 22.18 or newer (24 recommended; see `engines` in `package.json`) and pnpm 10, which corepack
provides in the version pinned by `packageManager`:

```bash
corepack enable
pnpm install
cp .env.example .env    # dev login on, no Google keys needed
pnpm dev                # API on :8787, web app on http://localhost:5173 (proxies the API)
```

Sign in with any email through the dev login. `OFFLINE=1` in `.env` makes every connector return deterministic
synthetic data, so you can work without network access and without hitting third-party APIs.

The repository is a pnpm monorepo:

```text
packages/core   pure domain logic shared by the server and the browser (schemas, ops, pipeline, charts)
apps/server     Hono on Node, run directly with Node's type stripping (no build step)
apps/web        React 19 + Vite + Tailwind v4
guide/          public documentation: architecture, MCP reference, deployment, ideas
```

[guide/architecture.md](guide/architecture.md) explains how the pieces fit and why.

## Before you open a pull request

These must pass; CI runs them on Linux and Windows:

```bash
pnpm format      # Biome: formats code and Markdown
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add tests for what you change. `packages/core` has fast unit tests; the server has integration tests that go through
`app.request()` against a temporary data directory, and MCP tests driven by the official client.

## Rules of the codebase

These keep the browser, the agent and the PNG renderer in agreement. A pull request that breaks one will be asked to
change, so it is worth reading them first.

- **All dashboard changes go through `applyOps`** (`packages/core/src/ops.ts`). Do not mutate documents any other
  way, on the server or in the editor.
- **Permission checks live only in `DashboardService`** (`apps/server/src/services/dashboards.ts`). The REST API and
  the MCP tools both call it; never re-implement a check in a route.
- **Schemas are strict** (`z.strictObject`). When adding a field, add it to the schema, to the reference text agents
  read (`apps/server/src/mcp/reference.ts`) and, if it is editable, to the editor.
- **Server code is erasable TypeScript.** It runs with Node's type stripping: no enums, no parameter properties, no
  namespaces, and `.ts` extensions in relative imports.
- **A new connector is one file** in `apps/server/src/connectors` with `info` (including the data source's
  attribution), `fetch` and an offline `sample` of the same shape, registered in `registry.ts`. It must be free to
  use, need no API key, and respect the upstream's rate limits through its `minRefreshSec`.
- **User-supplied URLs are fetched only through `util/safe-fetch.ts`** (`safeFetchJson`, `safeFetchText`), where the
  SSRF guard is. Feed text becomes plain text at parse time; never render feed markup.
- **Charts:** fixed categorical palette order (`packages/core/src/theme.ts`), no dual axes, colour follows the
  entity (a series keeps its colour when values change rank).
- **Pipelines run through `PipelineRunner`** (`apps/server/src/services/pipeline-pool.ts`), never by calling
  `runPipeline` from request code: large inputs must stay off the main thread.
- **Editing a pipeline means step ops** (`diffSteps` in core), not replacing `transforms`, so concurrent edits merge
  per step.
- **The service worker** (`apps/web/public/sw.js`) must never cache `/api`, `/auth`, `/oauth`, `/mcp` or live
  streams. It only caches hashed `/assets/*` and the offline page. Bump `VERSION` in `sw.js` when its caching logic
  changes.
- **Sound cue rules live in `soundDecision`** (`packages/core/src/sound.ts`), never in components; never trigger a
  sound from a widget render or an editor preview.
- **Presentation mode** must keep working without user input after the first click: it runs unattended on wall
  screens.
- **Nothing owner-specific in the code.** Absolute URLs come from `PUBLIC_URL`; analytics load only when the operator
  configures them.
- **Showcase use cases** live in `showcase/<id>/` (format in [showcase/README.md](showcase/README.md)). Their data
  must work without an owner: inline rows, built-in connectors or public URLs, no uploads and no secrets. Commit only
  the final `video.mp4` (at most 5 MB) and `poster.jpg` (at most 150 KB); a test enforces both.
- **Comments explain why, not what.** Docs are short and say what the code does today.

## Pull requests

- One topic per pull request; small is good.
- Describe what changes and why, and link the issue.
- Include screenshots for UI changes (light and dark if colours are involved).
- Commit messages: an imperative summary line, then the reason for the change.

## Licence

Patchbay is [MIT licensed](LICENSE). By contributing you agree that your contribution is licensed under the same
terms.
