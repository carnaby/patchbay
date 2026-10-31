import { Hono } from 'hono';
import type { Deps, Env } from '../context.ts';
import { mediaResponse } from '../showcase/media.ts';

/** Stable public URLs for the use cases; only slugs known at startup resolve, so no path ever reaches the disk. */
export function showcaseRoutes(deps: Deps) {
  const app = new Hono<Env>();
  const bySlug = new Map(deps.useCases.map((u) => [u.meta.id, u]));
  app.get('/showcase/:slug', (c) => {
    const u = bySlug.get(c.req.param('slug'));
    return u ? c.redirect(`/d/${u.dashboardId}`, 302) : c.notFound();
  });
  app.get('/showcase/:slug/video.mp4', (c) => {
    const file = bySlug.get(c.req.param('slug'))?.video;
    return file
      ? mediaResponse(file, 'video/mp4', c.req.header('range'), c.req.header('if-none-match'))
      : c.notFound();
  });
  app.get('/showcase/:slug/poster.jpg', (c) => {
    const file = bySlug.get(c.req.param('slug'))?.poster;
    return file
      ? mediaResponse(file, 'image/jpeg', c.req.header('range'), c.req.header('if-none-match'))
      : c.notFound();
  });
  return app;
}
