import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
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
import { DashboardIndex } from './store/dashboard-index.ts';
import { FolderStore } from './store/folder-store.ts';
import { HttpError, toHttpError } from './util/errors.ts';
import { RateLimiter } from './util/rate-limit.ts';

export async function createDeps(config: Config): Promise<Deps> {
  const db = openDatabase(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'patchbay.db'));
  const store = new FolderStore(config.dataDir === ':memory:' ? '/tmp/patchbay-memory' : config.dataDir);
  await store.init();
  const index = new DashboardIndex(db);
  const connectors = new ConnectorService({ offline: config.offline });
  const data = new DataService(connectors, store);
  const hub = new LiveHub(data, (id) => store.readDoc(id));
  const dashboards = new DashboardService(store, index, hub);
  return {
    config,
    db,
    users: new Users(db, config.adminEmails),
    tokens: new Tokens(db),
    store,
    index,
    connectors,
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
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

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
    app.use(
      '/assets/*',
      serveStatic({
        root: dist,
        onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    );
    // A missing hashed asset is a 404, never the SPA shell (avoids MIME-type confusion).
    app.get('/assets/*', (c) => c.text('Not found', 404));
    app.use('*', serveStatic({ root: dist }));
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml());
    });
  } else {
    app.get('/', (c) =>
      c.text('Patchbay API is running. Build the web app with `pnpm build`, or run `pnpm dev`.'),
    );
  }

  return app;
}
