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

| Tool               | Scope | What it does                                                                                                                                                                                                           |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_reference`    | read  | The full authoring guide: document schema, transforms, expression functions, widget configs, design rules.                                                                                                             |
| `list_connectors`  | read  | Built-in public data sources and their parameters.                                                                                                                                                                     |
| `list_dashboards`  | read  | The user's dashboards with URLs.                                                                                                                                                                                       |
| `get_dashboard`    | read  | One dashboard's document and metadata.                                                                                                                                                                                 |
| `preview_data`     | read  | Run a source + transforms **without saving**: columns, sample rows, row count per step, column profile, suggested widgets as operations.                                                                               |
| `get_data`         | read  | The processed rows of a saved dataset, with a profile.                                                                                                                                                                 |
| `suggest_widgets`  | read  | Rules-based visualisation suggestions for a saved dataset, as ready-to-apply operations with rationales.                                                                                                               |
| `render_snapshot`  | read  | PNG of the dashboard or a single widget (light or dark), plus any data errors.                                                                                                                                         |
| `list_versions`    | read  | Version history with actor and change log.                                                                                                                                                                             |
| `list_secrets`     | read  | The user's saved secrets for HTTP sources: id, name, origin, path prefix, how each is sent, timestamps. Never values. See "Secrets" below.                                                                             |
| `create_dashboard` | write | New dashboard (private by default), optionally from a template.                                                                                                                                                        |
| `apply_operations` | write | Atomic batch of operations; `dryRun` to validate only; `baseVersion` for optimistic concurrency. Returns the change log, a data check for every touched dataset and, when a URL looks like it holds a key, `warnings`. |
| `upload_data`      | write | Store CSV/JSON (≤ 5 MB) in a dashboard; returns the file id, profile, a ready `addDataset` op and suggestions.                                                                                                         |
| `restore_version`  | write | Restore an earlier version (as a new version).                                                                                                                                                                         |
| `set_visibility`   | write | Public or private.                                                                                                                                                                                                     |

There is intentionally no delete tool.

Input schemas are JSON Schema 2020-12. Closed sets are enums: `create_dashboard.template` and the connector id in a
source. Unknown ids are rejected (an operation that adds or re-points a dataset to an unknown connector fails the whole
batch), but dashboards saved with a since-removed connector still load and accept edits that leave that source alone.
To keep `tools/list` small, `apply_operations` defines its large shared parts once under
`$defs` (`Source`, `Transform`, `Widget`, `SoundRule`, `Format`) and points to them with local `$ref`s, each carrying
`"type": "object"` for clients that do not resolve references. The server validates every call with the full strict
schema either way.

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
{ "op": "reorderWidget", "id": "strongest", "before": "per-day" }
{ "op": "addStep", "datasetId": "quakes", "step": { "type": "filter", "expr": "magnitude >= 4" }, "before": "s2" }
{ "op": "updateStep", "datasetId": "quakes", "stepId": "s1", "set": { "expr": "magnitude >= 5" } }
{ "op": "removeStep", "datasetId": "quakes", "stepId": "s3" }
{ "op": "moveStep", "datasetId": "quakes", "stepId": "s3", "before": null }
```

`updateWidget.set.config` is shallow-merged into the current config. Pipeline steps have stable ids (`s1`, `s2`, …, or
your own); prefer the step operations over replacing `transforms` wholesale, so concurrent edits by the user survive. Positions are optional everywhere; omitted ones are
auto-placed.

`changes` in the answer has one line per operation. Sound cues are spelled out whenever an operation adds, changes or
removes one (trigger, sound, volume and cooldown, defaults included), so there is no need to call `get_dashboard` to
check them:

```text
Added kpi widget "Strongest"; sound cue: "alert" when `magnitude >= 6` becomes true on the last row (volume 0.7, cooldown 10 s)
Widget "Orders": sound cue set to "bell" when rows with a new "order_id" appear (volume 0.7, cooldown 10 s)
Widget "Orders": sound cue removed
```

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
