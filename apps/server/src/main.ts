import { serve } from '@hono/node-server';
import { createApp, createDeps, syncShowcaseUseCases } from './app.ts';
import { loadConfig } from './config.ts';
import { detectMemoryReader, memoryGuard } from './util/memory-pressure.ts';

// `--production` instead of `NODE_ENV=production node ...`, which does not work in Windows shells.
const config = loadConfig(
  process.argv.includes('--production') ? { ...process.env, NODE_ENV: 'production' } : process.env,
);
// Only the server process measures its memory: tests and tools that build the app are never refused by the guard.
memoryGuard.configure({
  reader: detectMemoryReader({ limitMb: config.memory.limitMb }),
  soft: config.memory.soft,
  hard: config.memory.hard,
  // Cheap (one read of two cgroup files): keeps the level, the admin page and memory relief current on an idle server.
  pollMs: 10_000,
});
const deps = await createDeps(config);

const { added, removed } = await deps.index.reconcile(deps.store);
console.log(`[patchbay] index reconciled: +${added} -${removed}`);

// Before createApp: the routes list only the use cases that really have their dashboard.
const synced = await syncShowcaseUseCases(deps);
if (deps.useCases.length)
  console.log(
    `[patchbay] showcase: ${deps.useCases.length} use cases (+${synced.created.length} ~${synced.updated.length})`,
  );
const app = createApp(deps);

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

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // Node waits 60 s for headers and 300 s for a whole request by default: long enough for a few slow senders to
    // hold sockets and buffers for minutes. Large bodies have their own pace (util/json-body.ts); this bounds the rest.
    // Neither applies once a request has arrived, so live streams and long responses are not cut.
    serverOptions: { headersTimeout: 20_000, requestTimeout: 90_000 },
  },
  (info) => {
    console.log(
      `[patchbay] listening on http://${info.address}:${info.port} (public URL ${config.publicUrl})`,
    );
    if (!config.google)
      console.log('[patchbay] Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    if (config.devLogin)
      console.log(
        '[patchbay] DEV_LOGIN is on: anyone can sign in as any email. Never use this in production.',
      );
    if (config.offline) console.log('[patchbay] OFFLINE mode: connectors serve synthetic data');
    console.log(`[patchbay] ${memoryGuard.describe()}`);
    if (config.analytics)
      console.log(`[patchbay] Umami analytics on: pages load ${config.analytics.scriptUrl}`);
    // Holding other people's credentials is a deliberate choice; say so where the operator looks.
    if (config.secrets.mode !== 'off')
      console.log(`[patchbay] SECRETS=${config.secrets.mode}: credentials for HTTP sources can be stored`);
  },
);

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
