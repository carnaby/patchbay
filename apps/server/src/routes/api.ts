import {
  type Dataset,
  type DatasetResult,
  DatasetSchema,
  type LiveEvent,
  profileTable,
  SECRET_PLACEMENTS,
  suggestWidgets,
  type ThemeMode,
} from '@patchbay/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ALL_SCOPES } from '../auth/tokens.ts';
import { type Ctx, clientIp, type Deps, type Env, requireUser } from '../context.ts';
import { SnapshotCache, snapshotCache } from '../render/cache.ts';
import { RenderBusyError, snapshotGate } from '../render/gate.ts';
import { renderDashboardPng, renderWidgetPng } from '../render/snapshot.ts';
import { listTemplates } from '../services/templates.ts';
import { badRequest, forbidden, HttpError, notFound } from '../util/errors.ts';

/** Live stream heartbeat while nothing else is sent. */
const HEARTBEAT_MS = 25_000;

const CreateBody = z.object({
  title: z.string().min(1).max(120).optional(),
  template: z.string().max(40).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

/** Sent by the web app after the user confirmed showing data fetched with secrets publicly (answer 428). */
const confirmPublicSecrets = z.boolean().optional();

const CreateSecretBody = z.strictObject({
  name: z.string().max(200),
  sendTo: z.string().max(2000),
  placement: z.enum(SECRET_PLACEMENTS),
  paramName: z.string().max(200).nullable().optional(),
  value: z.string().max(16_384),
});
const SecretValueBody = z.strictObject({ value: z.string().max(16_384) });
const SecretNameBody = z.strictObject({ name: z.string().max(200) });

/**
 * Parses a body that may carry a secret value. JSON syntax errors quote the input, so they must never reach the
 * response or the error logger (which prints unexpected errors); validation messages never include values.
 */
async function secretBody<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('The request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

export function apiRoutes(deps: Deps) {
  const app = new Hono<Env>();
  const { dashboards, data, hub, tokens, connectors, config } = deps;

  // Per-IP budget for all API traffic, plus a tighter one for writes.
  app.use('*', async (c, next) => {
    const ip = clientIp(c, config.trustProxy);
    if (!deps.limits.api.take(ip)) throw new HttpError(429, 'Too many requests, slow down a little');
    if (c.req.method !== 'GET' && !deps.limits.writes.take(ip))
      throw new HttpError(429, 'Too many changes, slow down a little');
    await next();
  });

  app.get('/me', (c) => {
    const user = c.get('user');
    const { mode, canUseSecrets } = dashboards.secretsStatus(user);
    return c.json({ user: user ? deps.users.toPublic(user) : null, secrets: mode, canUseSecrets });
  });

  app.get('/connectors', (c) => c.json(connectors.list()));
  app.get('/templates', (c) => c.json(listTemplates()));

  /** Fixed, server-defined demo data for the landing page (no user input reaches a connector). */
  const showcase = [
    DatasetSchema.parse({
      id: 'signal',
      name: 'Signal',
      source: {
        kind: 'connector',
        connector: 'demo.signal',
        params: { shape: 'traffic', points: 90, series: 2 },
      },
    }),
    DatasetSchema.parse({
      id: 'revenue',
      name: 'Revenue',
      source: { kind: 'connector', connector: 'demo.sales', params: { days: 120 } },
      transforms: [
        { type: 'timeBucket', field: 'date', unit: 'week' },
        {
          type: 'aggregate',
          groupBy: ['date', 'region'],
          metrics: [{ op: 'sum', field: 'revenue', as: 'revenue' }],
        },
        { type: 'sort', by: [{ field: 'date' }] },
      ],
    }),
    DatasetSchema.parse({
      id: 'products',
      name: 'Products',
      source: { kind: 'connector', connector: 'demo.sales', params: { days: 120 } },
      transforms: [
        {
          type: 'aggregate',
          groupBy: ['product'],
          metrics: [{ op: 'sum', field: 'revenue', as: 'revenue' }],
        },
        { type: 'sort', by: [{ field: 'revenue', dir: 'desc' }] },
      ],
    }),
  ];
  app.get('/showcase', async (c) => {
    const target = { id: 'showcase00', ownerId: null };
    const results = await Promise.all(showcase.map((d) => data.resolve(target, d)));
    return c.json(Object.fromEntries(results.map((r) => [r.datasetId, r])));
  });

  app.get('/dashboards', (c) => c.json(dashboards.listMine(c.get('principal'))));

  app.post('/dashboards', async (c) => {
    if (!deps.limits.creates.take(clientIp(c, config.trustProxy))) {
      throw new HttpError(429, 'Too many new dashboards from your network. Try again later.');
    }
    const body = CreateBody.parse(await c.req.json().catch(() => ({})));
    const created = await dashboards.create(c.get('principal'), body);
    return c.json(created, 201);
  });

  app.get('/dashboards/:id', async (c) =>
    c.json(await dashboards.get(c.req.param('id'), c.get('principal'), { touch: true })),
  );

  app.put('/dashboards/:id', async (c) => {
    const body = z
      .object({
        doc: z.unknown(),
        baseVersion: z.number().int(),
        changes: z.array(z.string().max(200)).max(20).optional(),
        confirmPublicSecrets,
      })
      .parse(await c.req.json());
    const result = await dashboards.save(
      c.req.param('id'),
      c.get('principal'),
      body.doc,
      body.baseVersion,
      body.changes,
      { confirmPublicSecrets: body.confirmPublicSecrets },
    );
    return c.json(result);
  });

  app.post('/dashboards/:id/ops', async (c) => {
    const body = z
      .object({
        ops: z.array(z.unknown()),
        baseVersion: z.number().int().optional(),
        dryRun: z.boolean().optional(),
        confirmPublicSecrets,
      })
      .parse(await c.req.json());
    const options: { dryRun?: boolean; baseVersion?: number; confirmPublicSecrets?: boolean } = {};
    if (body.dryRun !== undefined) options.dryRun = body.dryRun;
    if (body.baseVersion !== undefined) options.baseVersion = body.baseVersion;
    if (body.confirmPublicSecrets !== undefined) options.confirmPublicSecrets = body.confirmPublicSecrets;
    return c.json(await dashboards.applyOps(c.req.param('id'), c.get('principal'), body.ops, options));
  });

  app.patch('/dashboards/:id/settings', async (c) => {
    const body = z
      .object({ visibility: z.enum(['public', 'private']), confirmPublicSecrets })
      .parse(await c.req.json());
    return c.json(
      await dashboards.setVisibility(c.req.param('id'), c.get('principal'), body.visibility, {
        confirmPublicSecrets: body.confirmPublicSecrets,
      }),
    );
  });

  app.post('/dashboards/:id/claim', async (c) =>
    c.json(await dashboards.claim(c.req.param('id'), c.get('principal'))),
  );
  app.post('/dashboards/:id/duplicate', async (c) => {
    if (!deps.limits.creates.take(clientIp(c, config.trustProxy))) {
      throw new HttpError(429, 'Too many new dashboards from your network. Try again later.');
    }
    return c.json(await dashboards.duplicate(c.req.param('id'), c.get('principal')), 201);
  });
  app.delete('/dashboards/:id', async (c) => {
    await dashboards.delete(c.req.param('id'), c.get('principal'));
    return c.json({ ok: true });
  });

  app.get('/dashboards/:id/versions', async (c) =>
    c.json(await dashboards.versions(c.req.param('id'), c.get('principal'))),
  );
  app.post('/dashboards/:id/versions/:version/restore', async (c) => {
    const body = z.object({ confirmPublicSecrets }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await dashboards.restore(c.req.param('id'), c.get('principal'), Number(c.req.param('version')), {
        confirmPublicSecrets: body.confirmPublicSecrets,
      }),
    );
  });

  app.get('/dashboards/:id/data/:datasetId', async (c) => {
    const id = c.req.param('id');
    const { meta, doc } = await dashboards.loadViewable(id, c.get('principal'));
    const dataset = doc.datasets.find((d) => d.id === c.req.param('datasetId'));
    if (!dataset) throw notFound('Dataset not found');
    return c.json(await data.resolve({ id, ownerId: meta.ownerId }, dataset));
  });

  /** Runs an unsaved dataset definition and returns rows, a profile and widget suggestions. */
  app.post('/dashboards/:id/preview', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    const { meta } = await dashboards.loadViewable(id, principal);
    if (!dashboards.canEdit(meta, principal)) throw forbidden('You cannot edit this dashboard');
    const body = z.object({ dataset: z.unknown() }).parse(await c.req.json());
    const dataset = DatasetSchema.parse({ id: 'preview', name: 'Preview', ...(body.dataset as object) });
    if (dataset.source.kind === 'connector')
      connectors.validateParams(dataset.source.connector, dataset.source.params);
    const target = await dashboards.previewTarget(principal, id, dataset, { requireEdit: true });
    const result = await data.resolve(target, { ...dataset, accumulate: 0 }, { maxRows: 500 });
    const profile = profileTable(result.table);
    return c.json({
      result,
      profile,
      suggestions: suggestWidgets(profile, {
        transforms: dataset.transforms,
        accumulate: dataset.accumulate > 0,
      }),
    });
  });

  app.get('/dashboards/:id/suggest/:datasetId', async (c) => {
    const id = c.req.param('id');
    const { meta, doc } = await dashboards.loadViewable(id, c.get('principal'));
    const dataset = doc.datasets.find((d) => d.id === c.req.param('datasetId'));
    if (!dataset) throw notFound('Dataset not found');
    const result = await data.resolve({ id, ownerId: meta.ownerId }, dataset);
    const profile = profileTable(result.table);
    return c.json({
      profile,
      suggestions: suggestWidgets(profile, {
        transforms: dataset.transforms,
        accumulate: dataset.accumulate > 0,
      }),
    });
  });

  app.get('/dashboards/:id/files', async (c) =>
    c.json(await dashboards.listFiles(c.req.param('id'), c.get('principal'))),
  );
  app.post('/dashboards/:id/files', async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        content: z.string(),
        format: z.enum(['csv', 'json']).optional(),
      })
      .parse(await c.req.json());
    return c.json(await dashboards.uploadFile(c.req.param('id'), c.get('principal'), body), 201);
  });
  app.delete('/dashboards/:id/files/:fileId', async (c) => {
    await dashboards.deleteFile(c.req.param('id'), c.get('principal'), c.req.param('fileId'));
    return c.json({ ok: true });
  });

  /** Live updates: document changes by anyone (including agents) and refreshed data. */
  const openStreams = new Map<string, number>();
  app.get('/dashboards/:id/events', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    const { meta } = await dashboards.loadViewable(id, principal);
    const ip = clientIp(c, config.trustProxy);
    if ((openStreams.get(ip) ?? 0) >= 30) throw new HttpError(429, 'Too many open live connections');
    openStreams.set(ip, (openStreams.get(ip) ?? 0) + 1);
    const res = streamSSE(c, async (stream) => {
      const queue: LiveEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = hub.subscribe(id, {
        principal,
        send: (event) => {
          queue.push(event);
          wake?.();
        },
        // Access was revoked (e.g. the dashboard became private): end the stream.
        close: () => {
          closed = true;
          wake?.();
        },
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ type: 'hello', version: meta.version }),
        });
        while (!closed && !stream.aborted && !stream.closed) {
          if (queue.length === 0) {
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              // Well below the ~100 s after which proxies such as Cloudflare drop an idle connection.
              stream.sleep(HEARTBEAT_MS),
            ]);
            wake = null;
            if (closed) break;
            if (queue.length === 0) {
              await stream.writeSSE({ event: 'ping', data: '' });
              continue;
            }
          }
          const event = queue.shift()!;
          await stream.writeSSE({ event: 'message', data: JSON.stringify(event) });
          if (event.type === 'deleted') break;
        }
      } finally {
        unsubscribe();
        const left = (openStreams.get(ip) ?? 1) - 1;
        if (left > 0) openStreams.set(ip, left);
        else openStreams.delete(ip);
      }
    });
    // no-transform keeps proxies and CDNs (Cloudflare included) from compressing, and thereby buffering,
    // the stream; X-Accel-Buffering does the same for nginx.
    res.headers.set('Cache-Control', 'no-cache, no-transform');
    res.headers.set('X-Accel-Buffering', 'no');
    return res;
  });

  /** PNG snapshot of a whole dashboard or one widget; also used for social previews. */
  app.get('/dashboards/:id/snapshot.png', async (c) => {
    const id = c.req.param('id');
    const { meta, doc } = await dashboards.loadViewable(id, c.get('principal'));
    const target = { id, ownerId: meta.ownerId };
    const theme: ThemeMode = c.req.query('theme') === 'dark' ? 'dark' : 'light';
    const widgetId = c.req.query('widget');
    const resolveAll = async (datasets: Dataset[]) => {
      const map = new Map<string, DatasetResult>();
      await Promise.all(datasets.map(async (d) => map.set(d.id, await data.resolve(target, d))));
      return map;
    };
    const widget = widgetId ? doc.widgets.find((w) => w.id === widgetId) : undefined;
    if (widgetId && !widget) throw notFound('Widget not found');
    const key = SnapshotCache.key({ id, version: meta.version, theme, widget: widgetId });
    let png: Buffer;
    try {
      // Permission was checked above, for this request; the cache only saves the drawing.
      png = await snapshotCache.get(key, () =>
        snapshotGate.run(async (draw) => {
          if (widget) {
            const dataset =
              'datasetId' in widget ? doc.datasets.find((d) => d.id === widget.datasetId) : undefined;
            const result = dataset ? await data.resolve(target, dataset) : undefined;
            return draw(() => renderWidgetPng(widget, result, { theme, entityColors: doc.colors }));
          }
          const results = await resolveAll(doc.datasets);
          return draw(() => renderDashboardPng(doc, results, { theme }));
        }),
      );
    } catch (err) {
      if (!(err instanceof RenderBusyError)) throw err;
      return c.json({ error: err.message }, 503, { 'Retry-After': String(err.retryAfterSec) });
    }
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=30',
    });
  });

  // Personal access tokens and connected OAuth clients.
  app.get('/tokens', (c) =>
    c.json({ tokens: tokens.listPats(requireUser(c).id), grants: tokens.listGrants(requireUser(c).id) }),
  );
  app.post('/tokens', async (c) => {
    const user = requireUser(c);
    if (c.get('token')) throw forbidden('Tokens cannot create tokens; use the web UI');
    const body = z
      .object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(await c.req.json());
    return c.json(tokens.createPat(user.id, body.name, body.scopes, body.expiresInDays), 201);
  });
  app.delete('/tokens/:id', (c) => {
    if (!tokens.revokePat(requireUser(c).id, c.req.param('id'))) throw notFound('Token not found');
    return c.json({ ok: true });
  });
  app.delete('/grants/:id', (c) => {
    if (!tokens.revokeGrant(requireUser(c).id, c.req.param('id'))) throw notFound('Connection not found');
    return c.json({ ok: true });
  });

  // Credentials for HTTP sources. A value goes in once and never comes back out; DashboardService refuses every
  // token for writes, and cookie writes pass the same-origin check like all others.
  app.get('/secrets', async (c) =>
    c.json(await dashboards.listSecrets(c.get('principal'), { usedBy: true })),
  );
  app.post('/secrets', async (c) => {
    const body = await secretBody(c, CreateSecretBody);
    return c.json(dashboards.createSecret(c.get('principal'), body), 201);
  });
  app.put('/secrets/:id/value', async (c) => {
    const body = await secretBody(c, SecretValueBody);
    return c.json(dashboards.replaceSecretValue(c.get('principal'), c.req.param('id'), body.value));
  });
  app.patch('/secrets/:id', async (c) => {
    const body = await secretBody(c, SecretNameBody);
    return c.json(dashboards.renameSecret(c.get('principal'), c.req.param('id'), body.name));
  });
  app.delete('/secrets/:id', (c) => {
    dashboards.deleteSecret(c.get('principal'), c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
