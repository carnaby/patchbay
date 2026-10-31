import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { Secrets } from './auth/secrets.ts';
import { SCOPES, Tokens } from './auth/tokens.ts';
import { Users } from './auth/users.ts';
import type { Config } from './config.ts';
import { ConnectorService } from './connectors/registry.ts';
import { type Deps, type Env, identify, sameOrigin } from './context.ts';
import { openDatabase } from './db.ts';
import { LiveHub } from './live/hub.ts';
import { createMcp } from './mcp/server.ts';
import { adminRoutes } from './routes/admin.ts';
import { apiRoutes } from './routes/api.ts';
import { authRoutes } from './routes/auth.ts';
import { oauthRoutes } from './routes/oauth.ts';
import { DashboardService } from './services/dashboards.ts';
import { DataService } from './services/data.ts';
import { defaultPoolSize, InlineRunner, type PipelineRunner, WorkerPool } from './services/pipeline-pool.ts';
import { DashboardIndex } from './store/dashboard-index.ts';
import { FolderStore } from './store/folder-store.ts';
import { HttpError, toHttpError } from './util/errors.ts';
import { RateLimiter } from './util/rate-limit.ts';
import type { UpstreamTestSeam } from './util/safe-fetch.ts';

/** Test seams that cannot be set from the environment. */
export interface DepsOverrides {
  /** Routes HTTP data sources to a local test server; see `UpstreamTestSeam`. */
  upstreamTest?: UpstreamTestSeam;
}

export async function createDeps(config: Config, overrides: DepsOverrides = {}): Promise<Deps> {
  const db = openDatabase(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'patchbay.db'));
  const store = new FolderStore(config.dataDir === ':memory:' ? '/tmp/patchbay-memory' : config.dataDir);
  await store.init();
  const index = new DashboardIndex(db);
  const connectors = new ConnectorService({ offline: config.offline });
  const pipeline: PipelineRunner =
    config.pipelineWorkers === 0
      ? new InlineRunner()
      : new WorkerPool({
          size: config.pipelineWorkers ?? defaultPoolSize(),
          timeoutMs: config.pipelineTimeoutMs,
        });
  const users = new Users(db, config.adminEmails);
  const secrets = new Secrets(db, config.secrets.keyring);
  const rotated = secrets.rotate();
  if (rotated.resealed)
    console.log(`[patchbay] re-encrypted ${rotated.resealed} secrets with the current SECRETS_KEY`);
  if (rotated.undecryptable) {
    console.warn(`[patchbay] ${rotated.undecryptable} secrets cannot be decrypted with the configured keys`);
  }
  // DataService is built before DashboardService, which decides about credentials, so the resolver is bound late.
  let dashboards: DashboardService | undefined;
  const data = new DataService(connectors, store, pipeline, {
    credentials: (target, dataset) => dashboards!.credentialsFor(target, dataset),
    offline: config.offline,
    ...(overrides.upstreamTest ? { upstreamTest: overrides.upstreamTest } : {}),
  });
  const hub = new LiveHub(data, async (id) => {
    const meta = await store.readMeta(id);
    const doc = meta ? await store.readDoc(id) : null;
    return meta && doc ? { doc, ownerId: meta.ownerId } : null;
  });
  dashboards = new DashboardService(
    store,
    index,
    hub,
    connectors,
    { store: secrets, mode: config.secrets.mode, users },
    { anonymousStorageBytes: config.anonymousStorageBytes },
  );
  return {
    config,
    db,
    users,
    tokens: new Tokens(db),
    secrets,
    store,
    index,
    connectors,
    pipeline,
    data,
    hub,
    dashboards,
    limits: {
      api: new RateLimiter(300, 600),
      writes: new RateLimiter(60, 120),
      auth: new RateLimiter(20, 30),
      mcp: new RateLimiter(60, 120),
      // Creating dashboards (anonymous ones especially) is the main way to fill the disk.
      creates: new RateLimiter(20, 1),
    },
  };
}

export function createApp(deps: Deps) {
  const { config } = deps;
  const app = new Hono<Env>();
  const mcp = createMcp(deps);

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        // base-uri has no default-src fallback, and an injected <base> could re-point relative script URLs.
        // object-src is spelled out so plugins stay off even if default-src is ever widened.
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Every response without its own policy is dynamic. Saying so explicitly matters behind a CDN:
  // Cloudflare caches by file extension (e.g. /api/dashboards/:id/snapshot.png) unless told otherwise.
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    const httpErr = toHttpError(err);
    if (httpErr.status === 500) console.error(err);
    const details = httpErr.details as Record<string, unknown> | undefined;
    // OAuth endpoints answer with the RFC 6749 error shape.
    if (details && typeof details.error === 'string') return c.json(details, httpErr.status);
    return c.json({ error: httpErr.message, ...(details ?? {}) }, httpErr.status);
  });

  // Request size limits: uploads get room for a 5 MB file (JSON-escaped), everything else 1 MB.
  const tooLarge = (c: Context) => c.json({ error: 'Request body too large' }, 413);
  const uploadLimit = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge });
  const defaultLimit = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  app.use('*', (c, next) =>
    c.req.path.endsWith('/files') || c.req.path === '/mcp' ? uploadLimit(c, next) : defaultLimit(c, next),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));

  // MCP: bearer-only (OAuth access token bound to this resource, or a personal access token).
  const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  app.all('/mcp', async (c) => {
    const challenge = (error?: string) =>
      c.json({ error: error ?? 'unauthorized', error_description: 'Authorization required' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="${SCOPES.read} ${SCOPES.write}"${error ? `, error="${error}"` : ''}`,
      });
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) return challenge();
    const raw = header.slice(7).trim();
    const token = deps.tokens.verify(raw);
    if (!token) return challenge('invalid_token');
    if (token.kind === 'access' && token.resource !== config.mcpResource) return challenge('invalid_token');
    const clientName =
      token.kind === 'pat'
        ? 'Personal token'
        : ((
            deps.db.prepare('SELECT name FROM oauth_clients WHERE client_id = ?').get(token.clientId) as
              | { name: string }
              | undefined
          )?.name ?? 'MCP client');
    return mcp.fetch(c.req.raw, {
      authInfo: {
        token: raw,
        clientId: token.clientId ?? token.tokenId,
        scopes: token.scopes,
        expiresAt: Math.floor(token.expiresAt / 1000),
        resource: new URL(config.mcpResource),
        extra: { userId: token.userId, clientName },
      },
    });
  });

  // Middleware must be registered before the routes it guards.
  app.use('/api/*', identify(deps), sameOrigin(deps));
  app.use('/auth/*', identify(deps), sameOrigin(deps));
  app.route('/', oauthRoutes(deps));
  app.route('/auth', authRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api', apiRoutes(deps));
  app.all('/api/*', () => {
    throw new HttpError(404, 'Not found');
  });

  // The built web app, with SPA fallback.
  const dist = resolve(config.webDist ?? join(import.meta.dirname, '../../web/dist'));
  if (existsSync(join(dist, 'index.html'))) {
    // Re-read index.html when it changes on disk (a rebuild), so it never points at stale asset hashes.
    let cached = { mtime: 0, html: '' };
    const indexHtml = () => {
      const mtime = statSync(join(dist, 'index.html')).mtimeMs;
      if (mtime !== cached.mtime) cached = { mtime, html: readFileSync(join(dist, 'index.html'), 'utf8') };
      return cached.html;
    };
    // serveStatic calls onFound after it has built the response, so a header set there never arrives.
    // Setting it once the response exists is the reliable way.
    const cacheControl = (value: string) =>
      createMiddleware(async (c, next) => {
        await next();
        if (c.res.ok) c.header('Cache-Control', value);
      });
    app.use('/assets/*', cacheControl('public, max-age=31536000, immutable'), serveStatic({ root: dist }));
    // A missing hashed asset is a 404, never the SPA shell (avoids MIME-type confusion).
    app.get('/assets/*', (c) => c.text('Not found', 404));
    // Unhashed files keep their name across deploys, so they must be revalidated: a stale sw.js or
    // manifest keeps an old app version alive, and a CDN would otherwise cache .js/.png by extension.
    app.use('*', cacheControl('no-cache'), serveStatic({ root: dist }));
    app.get('*', (c) => c.html(indexHtml()));
  } else {
    app.get('/', (c) =>
      c.text('Patchbay API is running. Build the web app with `pnpm build`, or run `pnpm dev`.'),
    );
  }

  return app;
}
