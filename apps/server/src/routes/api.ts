import {
  type Dataset,
  type DatasetResult,
  DatasetSchema,
  type LiveEvent,
  profileTable,
  suggestWidgets,
  type ThemeMode,
} from '@patchbay/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ALL_SCOPES } from '../auth/tokens.ts';
import { clientIp, type Deps, type Env, requireUser } from '../context.ts';
import { renderDashboardPng, renderWidgetPng } from '../render/snapshot.ts';
import { listTemplates } from '../services/templates.ts';
import { forbidden, HttpError, notFound } from '../util/errors.ts';

const CreateBody = z.object({
  title: z.string().min(1).max(120).optional(),
  template: z.string().max(40).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

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
    return c.json({ user: user ? deps.users.toPublic(user) : null });
  });

  app.get('/connectors', (c) => c.json(connectors.list()));
  app.get('/templates', (c) => c.json(listTemplates()));

  app.get('/dashboards', (c) => c.json(dashboards.listMine(c.get('principal'))));

  app.post('/dashboards', async (c) => {
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
      })
      .parse(await c.req.json());
    const result = await dashboards.save(
      c.req.param('id'),
      c.get('principal'),
      body.doc,
      body.baseVersion,
      body.changes,
    );
    return c.json(result);
  });

  app.post('/dashboards/:id/ops', async (c) => {
    const body = z
      .object({
        ops: z.array(z.unknown()),
        baseVersion: z.number().int().optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const options: { dryRun?: boolean; baseVersion?: number } = {};
    if (body.dryRun !== undefined) options.dryRun = body.dryRun;
    if (body.baseVersion !== undefined) options.baseVersion = body.baseVersion;
    return c.json(await dashboards.applyOps(c.req.param('id'), c.get('principal'), body.ops, options));
  });

  app.patch('/dashboards/:id/settings', async (c) => {
    const body = z.object({ visibility: z.enum(['public', 'private']) }).parse(await c.req.json());
    return c.json(await dashboards.setVisibility(c.req.param('id'), c.get('principal'), body.visibility));
  });

  app.post('/dashboards/:id/claim', async (c) =>
    c.json(await dashboards.claim(c.req.param('id'), c.get('principal'))),
  );
  app.post('/dashboards/:id/duplicate', async (c) =>
    c.json(await dashboards.duplicate(c.req.param('id'), c.get('principal')), 201),
  );
  app.delete('/dashboards/:id', async (c) => {
    await dashboards.delete(c.req.param('id'), c.get('principal'));
    return c.json({ ok: true });
  });

  app.get('/dashboards/:id/versions', async (c) =>
    c.json(await dashboards.versions(c.req.param('id'), c.get('principal'))),
  );
  app.post('/dashboards/:id/versions/:version/restore', async (c) =>
    c.json(await dashboards.restore(c.req.param('id'), c.get('principal'), Number(c.req.param('version')))),
  );

  app.get('/dashboards/:id/data/:datasetId', async (c) => {
    const { doc } = await dashboards.loadViewable(c.req.param('id'), c.get('principal'));
    const dataset = doc.datasets.find((d) => d.id === c.req.param('datasetId'));
    if (!dataset) throw notFound('Dataset not found');
    return c.json(await data.resolve(c.req.param('id'), dataset));
  });

  /** Runs an unsaved dataset definition and returns rows, a profile and widget suggestions. */
  app.post('/dashboards/:id/preview', async (c) => {
    const id = c.req.param('id');
    const { meta } = await dashboards.loadViewable(id, c.get('principal'));
    if (!dashboards.canEdit(meta, c.get('principal'))) throw forbidden('You cannot edit this dashboard');
    const body = z.object({ dataset: z.unknown() }).parse(await c.req.json());
    const dataset = DatasetSchema.parse({ id: 'preview', name: 'Preview', ...(body.dataset as object) });
    if (dataset.source.kind === 'connector')
      connectors.validateParams(dataset.source.connector, dataset.source.params);
    const result = await data.resolve(id, { ...dataset, accumulate: 0 }, { maxRows: 500 });
    const profile = profileTable(result.table);
    return c.json({ result, profile, suggestions: suggestWidgets(profile) });
  });

  app.get('/dashboards/:id/suggest/:datasetId', async (c) => {
    const { doc } = await dashboards.loadViewable(c.req.param('id'), c.get('principal'));
    const dataset = doc.datasets.find((d) => d.id === c.req.param('datasetId'));
    if (!dataset) throw notFound('Dataset not found');
    const result = await data.resolve(c.req.param('id'), dataset);
    const profile = profileTable(result.table);
    return c.json({ profile, suggestions: suggestWidgets(profile) });
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
  app.get('/dashboards/:id/events', async (c) => {
    const id = c.req.param('id');
    const { meta } = await dashboards.loadViewable(id, c.get('principal'));
    return streamSSE(c, async (stream) => {
      const queue: LiveEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = hub.subscribe(id, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({ type: 'hello', version: meta.version }),
      });
      while (!stream.aborted && !stream.closed) {
        if (queue.length === 0) {
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(25_000),
          ]);
          wake = null;
          if (queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '' });
            continue;
          }
        }
        const event = queue.shift()!;
        await stream.writeSSE({ event: 'message', data: JSON.stringify(event) });
        if (event.type === 'deleted') break;
      }
      unsubscribe();
    });
  });

  /** PNG snapshot of a whole dashboard or one widget; also used for social previews. */
  app.get('/dashboards/:id/snapshot.png', async (c) => {
    const id = c.req.param('id');
    const { doc } = await dashboards.loadViewable(id, c.get('principal'));
    const theme: ThemeMode = c.req.query('theme') === 'dark' ? 'dark' : 'light';
    const widgetId = c.req.query('widget');
    const resolveAll = async (datasets: Dataset[]) => {
      const map = new Map<string, DatasetResult>();
      await Promise.all(datasets.map(async (d) => map.set(d.id, await data.resolve(id, d))));
      return map;
    };
    let png: Buffer;
    if (widgetId) {
      const widget = doc.widgets.find((w) => w.id === widgetId);
      if (!widget) throw notFound('Widget not found');
      const dataset = 'datasetId' in widget ? doc.datasets.find((d) => d.id === widget.datasetId) : undefined;
      png = renderWidgetPng(widget, dataset ? await data.resolve(id, dataset) : undefined, { theme });
    } else {
      png = renderDashboardPng(doc, await resolveAll(doc.datasets), { theme });
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

  return app;
}
