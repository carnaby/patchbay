import { serve } from '@hono/node-server';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';

// `--production` instead of `NODE_ENV=production node ...`, which does not work in Windows shells.
const config = loadConfig(
  process.argv.includes('--production') ? { ...process.env, NODE_ENV: 'production' } : process.env,
);
const deps = await createDeps(config);
const app = createApp(deps);

const { added, removed } = await deps.index.reconcile(deps.store);
console.log(`[patchbay] index reconciled: +${added} -${removed}`);

// Housekeeping: heal the index, expire sessions, prune stale anonymous dashboards.
const housekeeping = setInterval(async () => {
  try {
    deps.users.purgeExpired();
    await deps.index.reconcile(deps.store);
    if (config.pruneAnonymousAfterDays > 0) {
      const pruned = await deps.dashboards.prune({
        olderThanDays: config.pruneAnonymousAfterDays,
        onlyAnonymous: true,
      });
      if (pruned.length) console.log(`[patchbay] pruned ${pruned.length} stale anonymous dashboards`);
    }
    if (config.pruneBlankAnonymousAfterHours > 0) {
      const pruned = await deps.dashboards.pruneUntouched({
        olderThanHours: config.pruneBlankAnonymousAfterHours,
      });
      if (pruned.length) console.log(`[patchbay] pruned ${pruned.length} blank anonymous dashboards`);
    }
  } catch (e) {
    console.error('[patchbay] housekeeping failed', e);
  }
}, 15 * 60_000);
housekeeping.unref();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[patchbay] listening on http://${info.address}:${info.port} (public URL ${config.publicUrl})`);
  if (!config.google)
    console.log('[patchbay] Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  if (config.devLogin)
    console.log('[patchbay] DEV_LOGIN is on: anyone can sign in as any email. Never use this in production.');
  if (config.offline) console.log('[patchbay] OFFLINE mode: connectors serve synthetic data');
  if (config.analytics)
    console.log(`[patchbay] Umami analytics on: pages load ${config.analytics.scriptUrl}`);
  // Holding other people's credentials is a deliberate choice; say so where the operator looks.
  if (config.secrets.mode !== 'off')
    console.log(`[patchbay] SECRETS=${config.secrets.mode}: credentials for HTTP sources can be stored`);
});

const shutdown = () => {
  console.log('[patchbay] shutting down');
  deps.hub.close();
  void deps.pipeline.close();
  server.close(() => {
    deps.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
