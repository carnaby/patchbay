import { Hono } from 'hono';
import { z } from 'zod';
import type { Deps, Env } from '../context.ts';
import { forbidden } from '../util/errors.ts';

/** The single admin surface, available to emails listed in ADMIN_EMAILS. */
export function adminRoutes(deps: Deps) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    if (!c.get('principal').isAdmin || c.get('token')) throw forbidden('Admins only');
    await next();
  });

  app.get('/dashboards', async (c) => {
    // Cheap enough to reconcile on every visit, and it makes manual folder deletes show up immediately.
    await deps.index.reconcile(deps.store);
    const rows = deps.index.listAll();
    const users = deps.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return c.json({
      dashboards: rows,
      stats: {
        dashboards: rows.length,
        anonymous: rows.filter((r) => r.ownerId === null).length,
        users: users.n,
        totalBytes: rows.reduce((s, r) => s + r.sizeBytes, 0),
      },
    });
  });

  app.delete('/dashboards/:id', async (c) => {
    await deps.dashboards.delete(c.req.param('id'), c.get('principal'));
    return c.json({ ok: true });
  });

  app.post('/prune', async (c) => {
    const body = z
      .object({
        olderThanDays: z.number().int().min(1).max(3650),
        onlyAnonymous: z.boolean().default(true),
        dryRun: z.boolean().default(false),
      })
      .parse(await c.req.json());
    if (body.dryRun) {
      const cutoff = new Date(Date.now() - body.olderThanDays * 86_400_000).toISOString();
      return c.json({ ids: deps.index.idsViewedBefore(cutoff, body.onlyAnonymous), dryRun: true });
    }
    return c.json({ ids: await deps.dashboards.prune(body) });
  });

  return app;
}
