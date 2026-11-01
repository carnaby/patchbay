import { type Context, Hono } from 'hono';
import type { Deps, Env } from '../context.ts';
import type { MediaFile } from '../showcase/load.ts';
import { mediaResponse } from '../showcase/media.ts';

const serve = (c: Context<Env>, file: MediaFile, contentType: string, extra?: Record<string, string>) =>
  mediaResponse(
    file,
    contentType,
    c.req.header('range'),
    c.req.header('if-none-match'),
    c.req.method === 'HEAD',
    extra,
  );

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
    return file ? serve(c, file, 'video/mp4') : c.notFound();
  });
  app.get('/showcase/:slug/video-square.mp4', (c) => {
    const file = bySlug.get(c.req.param('slug'))?.videoSquare;
    return file ? serve(c, file, 'video/mp4') : c.notFound();
  });
  app.get('/showcase/:slug/poster.jpg', (c) => {
    const file = bySlug.get(c.req.param('slug'))?.poster;
    return file ? serve(c, file, 'image/jpeg') : c.notFound();
  });
  // The attachment's name is matched against what meta.json declared and the loader validated, never used as a path.
  app.get('/showcase/:slug/:file', (c) => {
    const file = bySlug.get(c.req.param('slug'))?.attachment;
    if (!file || file.name !== c.req.param('file')) return c.notFound();
    // A download, not a page: the name is [a-z0-9._-] only (UseCaseMetaSchema), so it needs no quoting rules.
    return serve(c, file, 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="${file.name}"`,
    });
  });
  // Anything else under /showcase is a 404, never the SPA shell (a missing video must not come back as HTML).
  app.all('/showcase/*', (c) => c.notFound());
  return app;
}
