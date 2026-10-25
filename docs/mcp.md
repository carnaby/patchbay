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
- `dashboards:write`: create and change dashboards and upload data. Every change is versioned.

## Tools

| Tool               | Scope | What it does                                                                                                                                                        |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_reference`    | read  | The full authoring guide: document schema, transforms, expression functions, widget configs, design rules.                                                          |
| `list_connectors`  | read  | Built-in public data sources and their parameters.                                                                                                                  |
| `list_dashboards`  | read  | The user's dashboards with URLs.                                                                                                                                    |
| `get_dashboard`    | read  | One dashboard's document and metadata.                                                                                                                              |
| `preview_data`     | read  | Run a source + transforms **without saving**: columns, sample rows, row count per step, column profile, suggested widgets as operations.                            |
| `get_data`         | read  | The processed rows of a saved dataset, with a profile.                                                                                                              |
| `suggest_widgets`  | read  | Rules-based visualisation suggestions for a saved dataset, as ready-to-apply operations with rationales.                                                            |
| `render_snapshot`  | read  | PNG of the dashboard or a single widget (light or dark), plus any data errors.                                                                                      |
| `list_versions`    | read  | Version history with actor and change log.                                                                                                                          |
| `create_dashboard` | write | New dashboard (private by default), optionally from a template.                                                                                                     |
| `apply_operations` | write | Atomic batch of operations; `dryRun` to validate only; `baseVersion` for optimistic concurrency. Returns the change log and a data check for every touched dataset. |
| `upload_data`      | write | Store CSV/JSON (≤ 5 MB) in a dashboard; returns the file id, profile, a ready `addDataset` op and suggestions.                                                      |
| `restore_version`  | write | Restore an earlier version (as a new version).                                                                                                                      |
| `set_visibility`   | write | Public or private.                                                                                                                                                  |

There is intentionally no delete tool.

Prompts: `build_dashboard { topic }`, `analyze_my_data { dashboardId? }`. Resource: `patchbay://reference`.

## Operations

```jsonc
{ "op": "setMeta", "title": "…", "description": "…" }
{ "op": "addDataset", "dataset": { "id": "quakes", "name": "Quakes", "source": { … }, "transforms": [ … ], "refreshSec": 60 } }
{ "op": "updateDataset", "id": "quakes", "set": { "transforms": [ … ] } }
{ "op": "removeDataset", "id": "quakes", "cascade": true }
{ "op": "addWidget", "widget": { "id": "strongest", "type": "kpi", "datasetId": "quakes", "config": { "field": "magnitude", "agg": "max" } }, "position": { "w": 3, "h": 2 } }
{ "op": "updateWidget", "id": "strongest", "set": { "title": "Strongest quake", "config": { "format": { "decimals": 1 } } } }
{ "op": "replaceWidget", "widget": { … } }
{ "op": "removeWidget", "id": "strongest" }
{ "op": "moveWidget", "id": "strongest", "x": 0, "y": 0, "w": 4 }
{ "op": "setLayout", "layout": [ { "i": "strongest", "x": 0, "y": 0, "w": 3, "h": 2 } ] }
```

`updateWidget.set.config` is shallow-merged into the current config. Positions are optional everywhere; omitted ones are
auto-placed.

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
