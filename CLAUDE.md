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
