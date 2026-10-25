import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { SCOPES, type Tokens, type VerifiedToken } from './auth/tokens.ts';
import { SESSION_COOKIE, type UserRow, type Users } from './auth/users.ts';
import type { Config } from './config.ts';
import type { ConnectorService } from './connectors/registry.ts';
import type { DB } from './db.ts';
import type { LiveHub } from './live/hub.ts';
import type { DashboardService, Principal } from './services/dashboards.ts';
import type { DataService } from './services/data.ts';
import type { DashboardIndex } from './store/dashboard-index.ts';
import type { FolderStore } from './store/folder-store.ts';
import { forbidden, unauthorized } from './util/errors.ts';
import type { RateLimiter } from './util/rate-limit.ts';

export interface Deps {
  config: Config;
  db: DB;
  users: Users;
  tokens: Tokens;
  store: FolderStore;
  index: DashboardIndex;
  connectors: ConnectorService;
  data: DataService;
  hub: LiveHub;
  dashboards: DashboardService;
  limits: {
    api: RateLimiter;
    writes: RateLimiter;
    auth: RateLimiter;
    mcp: RateLimiter;
    creates: RateLimiter;
  };
}

export type Env = {
  Variables: {
    user: UserRow | null;
    token: VerifiedToken | null;
    principal: Principal;
  };
};

export type Ctx = Context<Env>;

/** Resolves who is calling: session cookie, bearer token, and/or an anonymous edit key. */
export function identify(deps: Deps) {
  return createMiddleware<Env>(async (c, next) => {
    let user: UserRow | null = null;
    let token: VerifiedToken | null = null;
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      token = deps.tokens.verify(auth.slice(7).trim());
      // OAuth access tokens are audience-bound to the MCP resource; PATs work everywhere.
      if (token && token.kind === 'access' && token.resource !== deps.config.mcpResource) token = null;
      if (!token) throw unauthorized('Invalid or expired access token');
      user = deps.users.byId(token.userId);
    } else {
      user = deps.users.userForSession(getCookie(c, SESSION_COOKIE));
    }
    // A token's scopes bound what it can do over REST too, not only over MCP.
    if (token && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !token.scopes.includes(SCOPES.write)) {
      throw forbidden('This token is read-only (missing the dashboards:write scope)');
    }
    c.set('user', user);
    c.set('token', token);
    c.set('principal', {
      user,
      // Admin powers are for interactive sessions only, never for tokens.
      isAdmin: token ? false : deps.users.isAdmin(user),
      editKey: c.req.header('x-edit-key') || undefined,
    });
    await next();
  });
}

/**
 * CSRF guard for cookie-authenticated writes: the Origin must be our own.
 * Bearer-token requests are not ambient credentials and skip the check.
 */
export function sameOrigin(deps: Deps) {
  const allowed = new URL(deps.config.publicUrl).origin;
  return createMiddleware<Env>(async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !c.get('token')) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      const ok = origin
        ? origin === allowed
        : site === undefined || site === 'same-origin' || site === 'none';
      if (!ok) throw forbidden('Cross-site request rejected');
    }
    await next();
  });
}

export function requireUser(c: Ctx): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function clientIp(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    // The right-most entry is the one added by our own proxy; left entries are client-controlled.
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}
