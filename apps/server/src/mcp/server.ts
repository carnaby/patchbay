/**
 * The MCP server: Patchbay's primary interface.
 *
 * Every tool goes through the same DashboardService as the web UI, so the
 * permission rules, validation and versioning are identical. Writes require the
 * `dashboards:write` scope; reads only `dashboards:read`.
 */

import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  credentialLikeParams,
  type Dataset,
  type DatasetResult,
  DatasetSchema,
  type DataTable,
  formattingWarnings,
  OpSchema,
  profileTable,
  type Row,
  rowSize,
  SourceSchema,
  type Suggestion,
  suggestWidgets,
  TransformSchema,
} from '@patchbay/core';
import { z } from 'zod';
import { SCOPES } from '../auth/tokens.ts';
import type { Deps } from '../context.ts';
import { chargeSnapshot, snapshotGate } from '../render/gate.ts';
import type { Principal } from '../services/dashboards.ts';
import { listTemplates } from '../services/templates.ts';
import { HttpError, toHttpError } from '../util/errors.ts';
import { advertise } from './input-schema.ts';
import { referenceText, SERVER_INSTRUCTIONS } from './reference.ts';

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 1) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Rows shown per dataset in apply_operations' data checks: enough to spot a wrong column, small enough to batch. */
const DATA_CHECK_SAMPLE = 3;

/**
 * Agents watching an accumulating dataset over MCP saw rows arrive at the rhythm of their own calls, not refreshSec,
 * and could not tell why. The refresh loop only runs while a browser watches (LiveHub), so say so where they look.
 */
const ACCUMULATE_NOTE =
  'The accumulate history is kept in server memory. It gains a reading every refreshSec only while someone has the dashboard open; with nobody watching, only when the data is requested (get_data, render_snapshot, this check), so it has gaps. Never faster than the source updates (a connector minRefreshSec, http 30 s). A restart clears it.';

/**
 * Characters of sample rows in one tool result. Hundreds of rows of short values fit; rows repeat every column name,
 * so with long names or long text fewer do, and the result says so instead of growing to megabytes.
 */
const SAMPLE_CHARS = 200_000;

/** As many of `rows` as fit in `budget` characters (rows as objects, as tools return them). */
function fitRows(table: DataTable, rows: Row[], budget: number, from: 'start' | 'end' = 'start') {
  const ordered = from === 'end' ? [...rows].reverse() : rows;
  let used = 0;
  let n = 0;
  for (const row of ordered) {
    used += rowSize(table.columns, row, 'objects');
    if (used > budget) break;
    n++;
  }
  return n === rows.length ? rows : from === 'end' ? rows.slice(rows.length - n) : rows.slice(0, n);
}

/** A compact, model-friendly view of a table: columns + the first (or last) rows. */
function sampleTable(table: DataTable, limit: number, from: 'start' | 'end' = 'start') {
  const wanted = from === 'end' ? table.rows.slice(-limit) : table.rows.slice(0, limit);
  const rows = fitRows(table, wanted, SAMPLE_CHARS, from);
  return {
    columns: table.columns,
    rowCount: table.rows.length,
    rows,
    ...(rows.length < wanted.length
      ? {
          note: `Only ${rows.length} of the ${wanted.length} rows asked for fit in one answer; select fewer columns or shorten long text to see more.`,
        }
      : {}),
  };
}

let idCounter = 0;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28) || 'w';

/** Turns engine suggestions into ready-to-apply operations. */
function suggestionOps(dataset: Dataset, suggestions: Suggestion[]) {
  return suggestions.map((s) => {
    const base = `${slug(s.title)}-${(++idCounter % 1000).toString(36)}`;
    const ops: unknown[] = [];
    let datasetId = dataset.id;
    if (s.transforms.length) {
      datasetId = `${dataset.id.slice(0, 20)}-${base}`.slice(0, 40);
      ops.push({
        op: 'addDataset',
        dataset: {
          ...dataset,
          id: datasetId,
          name: `${dataset.name}: ${s.title}`.slice(0, 120),
          transforms: [...dataset.transforms, ...s.transforms],
        },
      });
    }
    ops.push({ op: 'addWidget', widget: { ...s.widget, id: base.slice(0, 40), datasetId } });
    return { title: s.title, rationale: s.rationale, ops };
  });
}

export function createMcp(deps: Deps) {
  const { dashboards, data, connectors, config, users } = deps;
  const urlOf = (id: string) => `${config.publicUrl}/d/${id}`;

  // Built once: the factory below runs per request, and the advertised JSON Schemas are cached on these objects.
  const connectorIds = connectors.list().map((c) => c.id);
  const dashboardId = z.string().describe('Dashboard id (the last part of its URL)');
  const createDashboardInput = z.object({
    title: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    visibility: z.enum(['private', 'public']).default('private'),
    template: z
      .enum(listTemplates().map((t) => t.id))
      .optional()
      .describe('Start from this template instead of a blank dashboard'),
  });
  const applyOperationsInput = advertise(
    z.object({
      dashboardId,
      operations: z.array(OpSchema).min(1).max(100),
      dryRun: z.boolean().default(false),
      baseVersion: z.number().int().optional().describe('Fail if the dashboard changed since this version'),
    }),
    { connectorIds, shareDefs: true },
  );
  const previewDataInput = advertise(
    z.object({
      source: SourceSchema,
      transforms: z.array(TransformSchema).default([]),
      dashboardId: dashboardId.optional(),
      sampleRows: z.number().int().min(1).max(100).default(15),
    }),
    { connectorIds },
  );

  const factory = ({ authInfo }: { authInfo?: AuthInfo }) => {
    const server = new McpServer(
      { name: 'patchbay', version: '0.1.0' },
      { instructions: SERVER_INSTRUCTIONS },
    );
    const userId = authInfo?.extra?.userId as string | undefined;
    const clientName = (authInfo?.extra?.clientName as string | undefined) ?? 'AI agent';
    const scopes = new Set(authInfo?.scopes ?? []);

    const principal = (): Principal => {
      const user = userId ? users.byId(userId) : null;
      if (!user) throw new HttpError(401, 'Not authenticated');
      return {
        user,
        isAdmin: false,
        viaToken: true,
        readOnly: !scopes.has(SCOPES.write),
        mcpClient: clientName,
      };
    };

    /** Wraps a handler with scope checks, rate limiting and uniform error reporting. */
    const tool = <A>(scope: string, run: (args: A, p: Principal) => Promise<ToolResult>) => {
      return async (args: A): Promise<ToolResult> => {
        if (!scopes.has(scope))
          return fail(`This connection lacks the "${scope}" scope. Reconnect and grant it.`);
        if (!deps.limits.mcp.take(`${userId}:${scope}`, scope === SCOPES.write ? 2 : 1)) {
          return fail('Rate limit reached. Wait a moment and batch your operations.');
        }
        try {
          return await run(args, principal());
        } catch (e) {
          const err = toHttpError(e);
          if (err.status === 500) console.error('[mcp]', e);
          return fail(err.message);
        }
      };
    };

    const read = { readOnlyHint: true, openWorldHint: false } as const;
    const write = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    } as const;

    server.registerTool(
      'get_reference',
      {
        title: 'Authoring reference',
        description:
          'Full schema of datasets, transforms, expressions, widgets and operations, plus design guidance. Read this once before building.',
        annotations: read,
      },
      tool(SCOPES.read, async () => ({ content: [{ type: 'text', text: referenceText(config.publicUrl) }] })),
    );

    server.registerTool(
      'list_connectors',
      {
        title: 'List data connectors',
        description: 'Built-in public data sources (no API keys needed) with their parameters.',
        annotations: read,
      },
      tool(SCOPES.read, async () => json(connectors.list())),
    );

    server.registerTool(
      'list_secrets',
      {
        title: 'List my secrets',
        description:
          'Credentials the user saved for HTTP sources: names, ids and where each may be sent. Never values.',
        annotations: read,
      },
      tool(SCOPES.read, async (_args, p) => {
        const { mode, canUseSecrets, secrets } = await dashboards.listSecrets(p);
        return json({
          secrets: secrets.map((s) => ({
            id: s.id,
            name: s.name,
            origin: s.origin,
            pathPrefix: s.pathPrefix,
            sentAs: s.sentAs,
            updatedAt: s.updatedAt,
            lastUsedAt: s.lastUsedAt,
          })),
          note: canUseSecrets
            ? `Values are never readable. To add one, ask the user to open ${config.publicUrl}/settings#secrets.`
            : mode === 'off'
              ? 'Secrets are turned off on this server.'
              : 'On this server only administrators can use secrets.',
        });
      }),
    );

    server.registerTool(
      'list_dashboards',
      { title: 'List my dashboards', description: "The signed-in user's dashboards.", annotations: read },
      tool(SCOPES.read, async (_args, p) =>
        json(
          dashboards.listMine(p).map((d) => ({
            id: d.id,
            title: d.title,
            visibility: d.visibility,
            updatedAt: d.updatedAt,
            url: urlOf(d.id),
          })),
        ),
      ),
    );

    server.registerTool(
      'get_dashboard',
      {
        title: 'Get a dashboard',
        description: 'The full dashboard document (datasets, widgets, layout) and its metadata.',
        inputSchema: z.object({ dashboardId }),
        annotations: read,
      },
      tool(SCOPES.read, async ({ dashboardId: id }: { dashboardId: string }, p) => {
        const env = await dashboards.get(id, p);
        return json({ url: urlOf(id), meta: env.meta, canEdit: env.access.canEdit, doc: env.doc });
      }),
    );

    server.registerTool(
      'create_dashboard',
      {
        title: 'Create a dashboard',
        description: 'Creates a dashboard owned by the user, blank or from a template.',
        inputSchema: createDashboardInput,
        annotations: write,
      },
      tool(
        SCOPES.write,
        async (
          args: { title: string; description?: string; visibility: 'private' | 'public'; template?: string },
          p,
        ) => {
          const { envelope } = await dashboards.create(p, {
            title: args.title,
            template: args.template,
            visibility: args.visibility,
          });
          let env = envelope;
          if (args.description)
            env = (
              await dashboards.applyOps(env.meta.id, p, [{ op: 'setMeta', description: args.description }])
            ).envelope;
          return json({
            dashboardId: env.meta.id,
            url: urlOf(env.meta.id),
            version: env.meta.version,
            doc: env.doc,
          });
        },
      ),
    );

    server.registerTool(
      'apply_operations',
      {
        title: 'Edit a dashboard',
        description:
          'Applies a batch of operations atomically (all or nothing) and saves a new version. The user sees the change live. Use dryRun to validate without saving. Ops address datasets/widgets by id.',
        inputSchema: applyOperationsInput,
        annotations: write,
      },
      tool(
        SCOPES.write,
        async (
          args: { dashboardId: string; operations: unknown[]; dryRun: boolean; baseVersion?: number },
          p,
        ) => {
          const options: { dryRun: boolean; baseVersion?: number } = { dryRun: args.dryRun };
          if (args.baseVersion !== undefined) options.baseVersion = args.baseVersion;
          const result = await dashboards.applyOps(args.dashboardId, p, args.operations, options);
          const target = { id: args.dashboardId, ownerId: result.envelope.meta.ownerId };
          // Check every dataset the batch touched, so broken sources surface immediately.
          const touched = new Set(
            (args.operations as { op: string; dataset?: { id: string }; id?: string }[])
              .filter((o) => o.op === 'addDataset' || o.op === 'updateDataset')
              .map((o) => o.dataset?.id ?? o.id!),
          );
          const touchedDatasets = result.envelope.doc.datasets.filter((d) => touched.has(d.id));
          // Keys pasted into URLs end up in every version and every get_dashboard answer: point to secrets instead.
          const warnings = touchedDatasets.flatMap((d) => {
            const params =
              d.source.kind === 'http' || d.source.kind === 'feed' ? credentialLikeParams(d.source.url) : [];
            if (!params.length) return [];
            const names = params.map((n) => `"${n}"`).join(', ');
            return [
              d.source.kind === 'feed'
                ? `Dataset "${d.id}": the feed URL has ${names}, which looks like a private token. Feeds take no secrets: the token is stored in the dashboard and visible to everyone who can open it. Use a public feed address.`
                : `Dataset "${d.id}": the URL has ${names}, which looks like a credential. Credentials belong in secrets (list_secrets), never in a URL.`,
            ];
          });
          type WidgetOp = { op: string; id?: string; widget?: { id: string }; colors?: unknown };
          const widgetOps = args.operations as WidgetOp[];
          warnings.push(
            ...formattingWarnings(result.envelope.doc, {
              widgets: new Set(
                widgetOps.flatMap((o) =>
                  o.op === 'addWidget' || o.op === 'replaceWidget'
                    ? [o.widget!.id]
                    : o.op === 'updateWidget'
                      ? [o.id!]
                      : [],
                ),
              ),
              colors: widgetOps.some((o) => o.op === 'setMeta' && o.colors !== undefined),
            }),
          );
          // rowCount is the full result and sampleRows a few of its rows, named apart: a bare `rows: 5` read like a
          // row count when it was the sample size.
          const dataChecks = await Promise.all(
            touchedDatasets.map(async (d) => {
              const r = await data.resolve(target, d);
              return {
                datasetId: d.id,
                rowCount: r.table.rows.length,
                ...(r.truncated ? { truncated: true } : {}),
                columns: r.table.columns.map((c) => `${c.name}:${c.type}`),
                sampleRows: fitRows(r.table, r.table.rows.slice(0, DATA_CHECK_SAMPLE), SAMPLE_CHARS / 30),
                error: r.error,
                ...(d.accumulate > 0 ? { note: ACCUMULATE_NOTE } : {}),
              };
            }),
          );
          return json({
            dryRun: args.dryRun,
            version: result.envelope.meta.version,
            changes: result.changes,
            dataChecks,
            ...(warnings.length ? { warnings } : {}),
            url: urlOf(args.dashboardId),
            hint: args.dryRun
              ? 'Valid. Call again with dryRun: false to save.'
              : 'Saved. Call render_snapshot to check how it looks.',
          });
        },
      ),
    );

    server.registerTool(
      'preview_data',
      {
        title: 'Preview a data source',
        description:
          'Loads a source and runs transforms WITHOUT saving: returns columns, sample rows, a column profile and widget suggestions. Pass dashboardId when the source is an uploaded file.',
        inputSchema: previewDataInput,
        annotations: { ...read, openWorldHint: true },
      },
      tool(
        SCOPES.read,
        async (
          args: { source: unknown; transforms: unknown[]; dashboardId?: string; sampleRows: number },
          p,
        ) => {
          const dataset = DatasetSchema.parse({
            id: 'preview',
            name: 'Preview',
            source: args.source,
            transforms: args.transforms,
          });
          // Raw uploads and secrets are for editors only; without a dashboard only the user's own secrets apply.
          const target = await dashboards.previewTarget(p, args.dashboardId, dataset);
          if (dataset.source.kind === 'connector')
            connectors.validateParams(dataset.source.connector, dataset.source.params);
          const result = await data.resolve(target, dataset, { maxRows: 5000 });
          if (result.error && result.table.rows.length === 0) return fail(result.error);
          const profile = profileTable(result.table);
          return json({
            ...sampleTable(result.table, args.sampleRows),
            trace: result.trace,
            profile: profile.columns.map(({ sample: _s, ...c }) => c),
            suggestions: suggestionOps(
              dataset,
              suggestWidgets(profile, { transforms: dataset.transforms, accumulate: dataset.accumulate > 0 }),
            ),
          });
        },
      ),
    );

    server.registerTool(
      'get_data',
      {
        title: 'Read a dataset',
        description: 'The processed rows of a saved dataset (what its widgets show), with a profile.',
        inputSchema: z.object({
          dashboardId,
          datasetId: z.string(),
          limit: z.number().int().min(1).max(500).default(50),
          from: z
            .enum(['start', 'end'])
            .default('start')
            .describe('"end": the last rows (newest of a time series)'),
        }),
        annotations: read,
      },
      tool(
        SCOPES.read,
        async (args: { dashboardId: string; datasetId: string; limit: number; from: 'start' | 'end' }, p) => {
          const { meta, doc } = await dashboards.loadViewable(args.dashboardId, p);
          const dataset = doc.datasets.find((d) => d.id === args.datasetId);
          if (!dataset)
            return fail(
              `No dataset "${args.datasetId}". Datasets: ${doc.datasets.map((d) => d.id).join(', ') || 'none'}`,
            );
          const result = await data.resolve({ id: args.dashboardId, ownerId: meta.ownerId }, dataset);
          const profile = profileTable(result.table);
          return json({
            ...sampleTable(result.table, args.limit, args.from),
            from: args.from,
            fetchedAt: result.fetchedAt,
            error: result.error,
            // Open browsers decide whether the history grows on its own, so tell the agent how many there are.
            ...(dataset.accumulate > 0
              ? { watchers: deps.hub.watchers(args.dashboardId), note: ACCUMULATE_NOTE }
              : {}),
            profile: profile.columns.map(({ sample: _s, ...c }) => c),
          });
        },
      ),
    );

    server.registerTool(
      'suggest_widgets',
      {
        title: 'Suggest visualisations',
        description:
          'Profiles a saved dataset and returns suggested widgets as ready-to-apply operations, each with a rationale.',
        inputSchema: z.object({ dashboardId, datasetId: z.string() }),
        annotations: read,
      },
      tool(SCOPES.read, async (args: { dashboardId: string; datasetId: string }, p) => {
        const { meta, doc } = await dashboards.loadViewable(args.dashboardId, p);
        const dataset = doc.datasets.find((d) => d.id === args.datasetId);
        if (!dataset) return fail(`No dataset "${args.datasetId}"`);
        const result = await data.resolve({ id: args.dashboardId, ownerId: meta.ownerId }, dataset);
        const profile = profileTable(result.table);
        return json({
          rows: profile.rows,
          columns: profile.columns.map(({ sample: _s, ...c }) => c),
          suggestions: suggestionOps(
            dataset,
            suggestWidgets(profile, { transforms: dataset.transforms, accumulate: dataset.accumulate > 0 }),
          ),
        });
      }),
    );

    server.registerTool(
      'upload_data',
      {
        title: 'Upload data',
        description:
          'Stores CSV or JSON content as a file inside a dashboard and returns its fileId, a profile and suggested operations (including the addDataset op). Max 5 MB, 500 columns and a cell limit (rows × columns), lower when anonymous.',
        inputSchema: z.object({
          dashboardId,
          name: z.string().min(1).max(200).describe('File name, e.g. "sales-2026.csv"'),
          format: z.enum(['csv', 'json']),
          content: z.string().min(1),
        }),
        annotations: write,
      },
      tool(
        SCOPES.write,
        async (args: { dashboardId: string; name: string; format: 'csv' | 'json'; content: string }, p) => {
          const file = await dashboards.uploadFile(args.dashboardId, p, args);
          const datasetId = slug(args.name.replace(/\.(csv|json)$/i, '')).slice(0, 30) || 'data';
          const dataset = DatasetSchema.parse({
            id: datasetId,
            name: args.name,
            source: { kind: 'upload', fileId: file.id },
          });
          const result = await data.resolve(await dashboards.target(args.dashboardId, p), dataset);
          const profile = profileTable(result.table);
          return json({
            file,
            addDatasetOp: { op: 'addDataset', dataset },
            profile: profile.columns.map(({ sample: _s, ...c }) => c),
            sample: fitRows(result.table, result.table.rows.slice(0, 5), SAMPLE_CHARS / 4),
            suggestions: suggestionOps(
              dataset,
              suggestWidgets(profile, { transforms: dataset.transforms, accumulate: dataset.accumulate > 0 }),
            ),
            hint: 'Apply addDatasetOp first, then the ops of the suggestions you like (or your own).',
          });
        },
      ),
    );

    server.registerTool(
      'render_snapshot',
      {
        title: 'See the dashboard',
        description:
          'Renders the dashboard (or one widget) to a PNG image so you can check what the user sees.',
        inputSchema: z.object({
          dashboardId,
          widgetId: z.string().optional(),
          theme: z.enum(['light', 'dark']).default('light'),
        }),
        annotations: read,
      },
      tool(
        SCOPES.read,
        async (args: { dashboardId: string; widgetId?: string; theme: 'light' | 'dark' }, p) => {
          const { meta, doc } = await dashboards.loadViewable(args.dashboardId, p);
          const target = { id: args.dashboardId, ownerId: meta.ownerId };
          const results = new Map<string, DatasetResult>();
          const needed = args.widgetId ? doc.widgets.filter((w) => w.id === args.widgetId) : doc.widgets;
          if (args.widgetId && needed.length === 0) return fail(`No widget "${args.widgetId}"`);
          const ids = new Set(needed.flatMap((w) => ('datasetId' in w ? [w.datasetId] : [])));
          const widget = needed[0];
          // Shares the REST endpoint's gate and per-client budget: snapshots from either side count against both.
          chargeSnapshot(deps.limits.snapshots, `user:${userId}`);
          const png = await snapshotGate.run(async (draw) => {
            await Promise.all(
              doc.datasets
                .filter((d) => ids.has(d.id))
                .map(async (d) => results.set(d.id, await data.resolve(target, d))),
            );
            return draw(
              args.widgetId && widget
                ? {
                    kind: 'widget',
                    widget,
                    result: 'datasetId' in widget ? results.get(widget.datasetId) : undefined,
                    options: { theme: args.theme, entityColors: doc.colors },
                  }
                : {
                    kind: 'dashboard',
                    doc,
                    results,
                    options: { theme: args.theme, attributions: deps.connectors.attributions() },
                  },
            );
          });
          const problems = [...results.values()]
            .filter((r) => r.error)
            .map((r) => `${r.datasetId}: ${r.error}`);
          return {
            content: [
              { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text',
                text: problems.length
                  ? `Data problems: ${problems.join('; ')}`
                  : `Rendered ${needed.length} widget(s).`,
              },
            ],
          };
        },
      ),
    );

    server.registerTool(
      'list_versions',
      {
        title: 'Version history',
        description: 'Recent versions with who changed what. Use restore_version to roll back.',
        inputSchema: z.object({ dashboardId }),
        annotations: read,
      },
      tool(SCOPES.read, async ({ dashboardId: id }: { dashboardId: string }, p) =>
        json(await dashboards.versions(id, p)),
      ),
    );

    server.registerTool(
      'restore_version',
      {
        title: 'Restore a version',
        description: 'Restores an earlier version (as a new version, so it is itself undoable).',
        inputSchema: z.object({ dashboardId, version: z.number().int().min(1) }),
        annotations: write,
      },
      tool(SCOPES.write, async (args: { dashboardId: string; version: number }, p) => {
        const r = await dashboards.restore(args.dashboardId, p, args.version);
        return json({ version: r.envelope.meta.version, changes: r.changes });
      }),
    );

    server.registerTool(
      'set_visibility',
      {
        title: 'Change visibility',
        description: 'public = anyone with the link can view; private = only the owner (after signing in).',
        inputSchema: z.object({ dashboardId, visibility: z.enum(['public', 'private']) }),
        annotations: write,
      },
      tool(SCOPES.write, async (args: { dashboardId: string; visibility: 'public' | 'private' }, p) => {
        const env = await dashboards.setVisibility(args.dashboardId, p, args.visibility);
        return json({ visibility: env.meta.visibility, url: urlOf(args.dashboardId) });
      }),
    );

    server.registerResource(
      'reference',
      'patchbay://reference',
      {
        title: 'Patchbay authoring reference',
        description: 'Schema and design guidance',
        mimeType: 'text/markdown',
      },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: referenceText(config.publicUrl) }],
      }),
    );

    server.registerPrompt(
      'build_dashboard',
      {
        title: 'Build a dashboard',
        description: 'Design and build a live dashboard about a topic from public data.',
        argsSchema: z.object({ topic: z.string().describe('What the dashboard should be about') }),
      },
      ({ topic }: { topic: string }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Build a Patchbay dashboard about: ${topic}.\n\n1. Call get_reference and list_connectors.\n2. Preview the sources you plan to use with preview_data.\n3. Create the dashboard and add datasets and 4-8 widgets in one apply_operations batch.\n4. render_snapshot, critique the image like a designer (empty widgets, unreadable labels, wrong chart type) and fix it.\n5. Reply with the URL and a two-sentence summary.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      'analyze_my_data',
      {
        title: 'Analyse my data',
        description: 'Turn the user’s own CSV/JSON into a dashboard with sensible processing.',
        argsSchema: z.object({
          dashboardId: z.string().optional().describe('Existing dashboard to add to (optional)'),
        }),
      },
      ({ dashboardId: id }: { dashboardId?: string }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `I want to visualise my own data in Patchbay${id ? ` (dashboard ${id})` : ''}. Ask me for the file content if you do not have it yet. Then: upload_data, study the profile (column roles, ranges, nulls), propose a processing pipeline (cleaning, derived columns, time buckets, aggregations) and 3-6 widgets, explain each choice in one line, apply them, and verify with render_snapshot.`,
            },
          },
        ],
      }),
    );

    return server;
  };

  return createMcpHandler(factory, { onerror: (e) => console.error('[mcp]', e.message) });
}
