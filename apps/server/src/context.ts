import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Secrets } from './auth/secrets.ts';
import { SCOPES, type Tokens, type VerifiedToken } from './auth/tokens.ts';
import { SESSION_COOKIE, type UserRow, type Users } from './auth/users.ts';
import type { Config, TrustProxy } from './config.ts';
import type { ConnectorService } from './connectors/registry.ts';
import type { DB } from './db.ts';
import type { LiveHub } from './live/hub.ts';
import type { DashboardService, Principal } from './services/dashboards.ts';
import type { DataService } from './services/data.ts';
import type { PipelineRunner } from './services/pipeline-pool.ts';
import type { ResultWire } from './services/result-wire.ts';
import type { UseCase } from './showcase/load.ts';
import type { DashboardIndex } from './store/dashboard-index.ts';
import type { FolderStore } from './store/folder-store.ts';
import { forbidden, unauthorized } from './util/errors.ts';
import type { OutboundLimiter } from './util/outbound.ts';
import type { RateLimiter } from './util/rate-limit.ts';

export interface Deps {
  config: Config;
  useCases: UseCase[];
  db: DB;
  users: Users;
  tokens: Tokens;
  secrets: Secrets;
  store: FolderStore;
  index: DashboardIndex;
  connectors: ConnectorService;
  data: DataService;
  /**
   * Requests to addresses that users (or OAuth clients) chose: http and feed sources and client metadata documents
   * share one limiter, so none of them can be used to turn the server into a crawler.
   */
  outbound: OutboundLimiter;
  /** Data results on their way to clients: serialised once, shared, within a byte budget. */
  wire: ResultWire;
  pipeline: PipelineRunner;
  hub: LiveHub;
  dashboards: DashboardService;
  limits: {
    api: RateLimiter;
    writes: RateLimiter;
    auth: RateLimiter;
    mcp: RateLimiter;
    creates: RateLimiter;
    /** Snapshots that have to be drawn (not cache hits), per client; see chargeSnapshot in render/gate.ts. */
    snapshots: RateLimiter;
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
      if (!token) throw unauthorized('Invalid or expired access token');
      // OAuth access tokens are audience-bound to the MCP resource (RFC 8707), so /mcp is the only place that
      // accepts them: one leaked from an MCP client must not reach the REST API. PATs work everywhere.
      if (token.kind !== 'pat')
        throw unauthorized(
          'OAuth access tokens only work on /mcp; use a personal access token for the REST API',
        );
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
      viaToken: token !== null,
      readOnly: token !== null && !token.scopes.includes(SCOPES.write),
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

/**
 * For routes that manage access itself (tokens, connected clients, OAuth consent): a bearer token must not be able
 * to mint, list or revoke credentials, or a leaked one could approve a fresh grant that outlives its own revocation.
 */
export function requireSessionUser(c: Ctx): UserRow {
  const user = requireUser(c);
  if (c.get('token')) throw forbidden('This needs a signed-in session in the web app, not a token');
  return user;
}

export function clientIp(c: Ctx, trustProxy: TrustProxy): string {
  if (trustProxy === 'cloudflare') {
    // Cloudflare overwrites this header on every request it proxies. Without it the request did not come
    // through Cloudflare (e.g. a health check from inside the host), so the socket address is the truth.
    const connecting = c.req.header('cf-connecting-ip')?.trim();
    if (connecting && isIP(connecting)) return connecting;
  } else if (trustProxy === 'forwarded') {
    // The right-most entry is the one added by our own proxy; left entries are client-controlled.
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/**
 * One IPv6 subscriber usually holds a whole /64 (often a /56 or /48), so keying limits by the full address would
 * hand everyone 2^64 buckets. Limits that create lasting state use the wider prefix.
 */
export const IPV6_CLIENT_PREFIX = 64;
export const IPV6_CREATE_PREFIX = 56;

/** The key every per-client limit uses: an IPv4 address as is, an IPv6 address reduced to its prefix. */
export function rateKey(ip: string, v6Prefix: number = IPV6_CLIENT_PREFIX): string {
  const bare = ip.split('%')[0]!;
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return ip;
  const groups = ipv6Groups(bare);
  // A dual-stack socket reports IPv4 clients as ::ffff:a.b.c.d; they are IPv4 clients.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const masked = groups.map((g, i) => {
    const bits = Math.max(0, Math.min(16, v6Prefix - i * 16));
    return bits === 0 ? 0 : g & ((0xffff << (16 - bits)) & 0xffff);
  });
  return `${masked.map((g) => g.toString(16)).join(':')}/${v6Prefix}`;
}

/** Eight 16-bit groups of a valid IPv6 address (`::` expanded, a trailing dotted IPv4 part converted). */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
}

/** The rate limit key for the caller of this request. */
export function clientKey(c: Ctx, trustProxy: TrustProxy, v6Prefix: number = IPV6_CLIENT_PREFIX): string {
  return rateKey(clientIp(c, trustProxy), v6Prefix);
}
