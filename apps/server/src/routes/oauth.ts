/**
 * A small OAuth 2.1 authorization server for MCP clients, following the MCP
 * authorization spec:
 *
 * - RFC 9728 protected resource metadata + RFC 8414 server metadata
 * - Authorization code flow with mandatory PKCE (S256), public clients only
 * - Client registration via Client ID Metadata Documents (preferred) or
 *   RFC 7591 dynamic registration
 * - RFC 8707 resource indicators: tokens are bound to the /mcp resource
 * - Rotating refresh tokens with reuse detection, RFC 7009 revocation
 *
 * The end user authenticates with their normal Patchbay (Google) session and
 * approves the client on a consent screen.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { normalizeScopes, SCOPES } from '../auth/tokens.ts';
import { clientKey, type Deps, type Env, IPV6_CREATE_PREFIX, requireSessionUser } from '../context.ts';
import { now } from '../db.ts';
import { newId, randomToken, sha256, verifyPkce } from '../util/crypto.ts';
import { HttpError, notFound } from '../util/errors.ts';
import { safeFetchJson } from '../util/safe-fetch.ts';

interface ClientRow {
  client_id: string;
  kind: 'dcr' | 'cimd';
  name: string;
  redirect_uris: string;
  metadata: string;
  fetched_at: string | null;
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: string;
  resource: string;
  expires_at: string;
}

const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const CIMD_REFRESH_MS = 24 * 3_600_000;
const CIMD_FAILURE_TTL_MS = 5 * 60_000;
const cimdFailures = new Map<string, number>();

/** Redirect URIs: https, loopback http (RFC 8252), or a private-use app scheme. */
export function isAcceptableRedirect(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Private-use URI schemes for native apps (RFC 8252 §7.1), minus dangerous ones.
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
  );
}

/** Loopback redirects may use any port (RFC 8252 §7.3); everything else must match exactly. */
export function redirectMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  try {
    const c = new URL(candidate);
    if (c.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(c.hostname)) return false;
    return registered.some((r) => {
      const u = new URL(r);
      return (
        u.protocol === c.protocol &&
        u.hostname === c.hostname &&
        u.pathname === c.pathname &&
        u.search === c.search
      );
    });
  } catch {
    return false;
  }
}

/**
 * Registration is open to anyone, so every field and list is capped and only these fields are stored. Unknown
 * metadata is dropped rather than refused: RFC 7591 §2 says a server must ignore metadata it does not understand,
 * and real clients send extras (contacts, policy_uri, software_statement, ...).
 */
const shortList = z.array(z.string().max(64)).max(8);
const RegistrationSchema = z.object({
  redirect_uris: z.array(z.string().max(1000)).min(1).max(8),
  client_name: z.string().max(120).optional(),
  client_uri: z.url().max(1000).optional(),
  logo_uri: z.url().max(1000).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: shortList.optional(),
  response_types: shortList.optional(),
  scope: z.string().max(500).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional(),
});

/**
 * A client metadata document is a few hundred bytes; anyone can make /oauth/authorize fetch one, before signing in,
 * so the fetch is held far below the limits of data sources: a small body, few JSON values, a short timeout, and
 * the outbound limiter that data sources use (a few at a time across the server, fewer per host).
 */
export const CIMD_MAX_BYTES = 16 * 1024;
export const CIMD_MAX_VALUES = 256;
export const CIMD_TIMEOUT_MS = 5000;

const CimdSchema = z.object({
  client_id: z.string().max(1000),
  client_name: z.string().max(120),
  redirect_uris: z.array(z.string().max(1000)).min(1).max(20),
  client_uri: z.string().max(1000).optional(),
  logo_uri: z.string().max(1000).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
});

/** The fields kept from a metadata document; anything else it holds is never stored. */
function storedCimd(doc: z.infer<typeof CimdSchema>) {
  return {
    client_id: doc.client_id,
    client_name: doc.client_name,
    redirect_uris: doc.redirect_uris,
    ...(doc.client_uri !== undefined ? { client_uri: doc.client_uri } : {}),
    ...(doc.logo_uri !== undefined ? { logo_uri: doc.logo_uri } : {}),
    ...(doc.token_endpoint_auth_method !== undefined
      ? { token_endpoint_auth_method: doc.token_endpoint_auth_method }
      : {}),
  };
}

/** Where approving sends the user, in the form the consent screen shows it. */
export function describeRedirect(raw: string): { kind: 'web' | 'loopback' | 'app'; target: string } {
  const url = new URL(raw);
  if (url.protocol === 'https:') return { kind: 'web', target: url.host };
  if (url.protocol === 'http:') return { kind: 'loopback', target: url.host };
  return { kind: 'app', target: url.host ? `${url.protocol}//${url.host}` : url.protocol };
}

function oauthError(status: 400 | 401, error: string, description: string) {
  return new HttpError(status, description, { error, error_description: description });
}

export function oauthRoutes(deps: Deps) {
  const { db, config, tokens } = deps;
  const app = new Hono<Env>();
  const issuer = config.publicUrl;
  const resourceMetadata = {
    resource: config.mcpResource,
    authorization_servers: [issuer],
    scopes_supported: [SCOPES.read, SCOPES.write],
    bearer_methods_supported: ['header'],
    resource_name: 'Patchbay',
    resource_documentation: 'https://github.com/carnaby/patchbay/blob/main/guide/mcp.md',
  };

  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata));
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPES.read, SCOPES.write],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  /** Feeds the purge of unused registrations (Users.purgeOAuthClients). */
  const markClientUsed = (clientId: string) =>
    db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(now(), clientId);

  const getClient = (clientId: string) =>
    (db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined) ??
    null;

  /**
   * Resolves a client id: a registered (DCR) id, or an https URL pointing to its metadata document. `client` is who
   * asks, for the outbound limiter's fairness.
   *
   * An unknown document is fetched before the user signs in, as MCP clients expect: they open this URL in a browser
   * that often has no Patchbay session yet, and the redirect URI has to be known before any error may be sent back
   * to it. Sending the user to sign in first would need this request to survive the Google round trip, for a gain
   * the limits already give: the fetch is small and bounded (CIMD_*), shares the outbound limiter, /authorize is
   * rate limited per client, and failures are remembered (`cimdFailures`).
   */
  async function resolveClient(
    clientId: string,
    client: string,
  ): Promise<{ id: string; name: string; redirectUris: string[] }> {
    const existing = getClient(clientId);
    const fresh =
      existing &&
      (existing.kind === 'dcr' ||
        (existing.fetched_at && Date.now() - Date.parse(existing.fetched_at) < CIMD_REFRESH_MS));
    if (existing && fresh)
      return {
        id: existing.client_id,
        name: existing.name,
        redirectUris: JSON.parse(existing.redirect_uris),
      };
    if (!/^https:\/\/[^/]+\/.+/.test(clientId)) throw oauthError(400, 'invalid_client', 'Unknown client_id');
    // Failed metadata fetches are remembered briefly so /authorize cannot be used as a fetch amplifier.
    const failedAt = cimdFailures.get(clientId);
    if (failedAt && Date.now() - failedAt < CIMD_FAILURE_TTL_MS) {
      throw oauthError(400, 'invalid_client', 'Client metadata document is unavailable');
    }
    // No redirects: the document must live at the URL that is the client's identity, not wherever that URL points.
    const fetched = await deps.outbound
      .run(client, clientId, () =>
        safeFetchJson(clientId, {
          redirects: 0,
          maxBytes: CIMD_MAX_BYTES,
          maxValues: CIMD_MAX_VALUES,
          timeoutMs: CIMD_TIMEOUT_MS,
        }),
      )
      .then(
        (json) => ({ json }),
        (e: unknown) => ({ error: e }),
      );
    // Our own refusals (the limiter is full, the host's budget is spent) say nothing about the document: they are not
    // remembered as a failure.
    if ('error' in fetched && fetched.error instanceof HttpError && [429, 503].includes(fetched.error.status))
      throw oauthError(400, 'invalid_client', 'The server is busy; try again in a minute');
    const doc = CimdSchema.safeParse('json' in fetched ? fetched.json : null);
    if (!doc.success) {
      cimdFailures.set(clientId, Date.now());
      if (cimdFailures.size > 1000) cimdFailures.delete(cimdFailures.keys().next().value!);
      throw oauthError(400, 'invalid_client', 'Client metadata document is invalid');
    }
    if (doc.data.client_id !== clientId)
      throw oauthError(400, 'invalid_client', 'client_id in the metadata document does not match its URL');
    const uris = doc.data.redirect_uris.filter(isAcceptableRedirect);
    if (uris.length === 0)
      throw oauthError(400, 'invalid_client', 'No acceptable redirect_uris in the metadata document');
    db.prepare(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, metadata, created_at, fetched_at)
       VALUES (?, 'cimd', ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
         metadata = excluded.metadata, fetched_at = excluded.fetched_at`,
    ).run(
      clientId,
      doc.data.client_name,
      JSON.stringify(uris),
      JSON.stringify(storedCimd(doc.data)),
      now(),
      now(),
    );
    return { id: clientId, name: doc.data.client_name, redirectUris: uris };
  }

  app.post('/oauth/register', async (c) => {
    if (!deps.limits.auth.take(`register:${clientKey(c, config.trustProxy, IPV6_CREATE_PREFIX)}`, 5))
      throw new HttpError(429, 'Too many registrations');
    const body = RegistrationSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw oauthError(400, 'invalid_client_metadata', 'Invalid registration request');
    const bad = body.data.redirect_uris.find((u) => !isAcceptableRedirect(u));
    if (bad) throw oauthError(400, 'invalid_redirect_uri', `Redirect URI not allowed: ${bad}`);
    if (body.data.token_endpoint_auth_method && body.data.token_endpoint_auth_method !== 'none') {
      throw oauthError(
        400,
        'invalid_client_metadata',
        'Only public clients (token_endpoint_auth_method "none") are supported',
      );
    }
    const clientId = `pbc_${newId()}`;
    const name = body.data.client_name?.trim() || 'MCP client';
    db.prepare(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, metadata, created_at) VALUES (?, 'dcr', ?, ?, ?, ?)`,
    ).run(clientId, name, JSON.stringify(body.data.redirect_uris), JSON.stringify(body.data), now());
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: body.data.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  });

  app.get('/oauth/authorize', async (c) => {
    if (!deps.limits.auth.take(`authorize:${clientKey(c, config.trustProxy)}`)) {
      return c.redirect('/oauth/error?reason=Too%20many%20requests');
    }
    const q = c.req.query();
    const clientId = q.client_id ?? '';
    const redirectUri = q.redirect_uri ?? '';
    // Errors before the client and redirect are validated must NOT redirect (open redirect guard).
    let client: Awaited<ReturnType<typeof resolveClient>>;
    try {
      client = await resolveClient(clientId, `ip:${clientKey(c, config.trustProxy)}`);
    } catch (e) {
      return c.redirect(
        `/oauth/error?reason=${encodeURIComponent(e instanceof Error ? e.message : 'invalid_client')}`,
      );
    }
    if (!redirectMatches(client.redirectUris, redirectUri)) {
      return c.redirect(
        `/oauth/error?reason=${encodeURIComponent('redirect_uri is not registered for this client')}`,
      );
    }
    const fail = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (q.state) url.searchParams.set('state', q.state);
      url.searchParams.set('iss', issuer);
      return c.redirect(url.toString());
    };
    if (q.response_type !== 'code')
      return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256')
      return fail('invalid_request', 'PKCE with S256 is required');
    const resource = (q.resource ?? config.mcpResource).replace(/\/$/, '');
    if (resource !== config.mcpResource && resource !== config.publicUrl) {
      return fail('invalid_target', `Unknown resource; use ${config.mcpResource}`);
    }
    const id = `req_${newId()}`;
    db.prepare(
      `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      client.id,
      redirectUri,
      q.state ?? null,
      q.code_challenge,
      normalizeScopes(q.scope).join(' '),
      config.mcpResource,
      new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    );
    return c.redirect(`/oauth/consent?request=${id}`);
  });

  const pendingRequest = (id: string) => {
    const row = db.prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(id, now()) as
      | RequestRow
      | undefined;
    if (!row) throw notFound('This authorization request has expired. Start again from your MCP client.');
    return row;
  };

  /** Data for the consent screen. A web session is required: a token must never approve a new grant. */
  app.get('/api/oauth/requests/:id', (c) => {
    requireSessionUser(c);
    const row = pendingRequest(c.req.param('id'));
    const client = getClient(row.client_id);
    const kind = client?.kind ?? 'dcr';
    const redirect = describeRedirect(row.redirect_uri);
    // Names are self-declared either way; what the user can check is who published the metadata (the host of a
    // metadata document URL) and where the code goes.
    return c.json({
      id: row.id,
      clientName: client?.name ?? row.client_id,
      clientKind: kind,
      clientId: row.client_id,
      clientHost: kind === 'cimd' ? new URL(row.client_id).host : null,
      redirectHost: redirect.target,
      redirectKind: redirect.kind,
      scopes: row.scopes.split(' '),
    });
  });

  app.post('/api/oauth/requests/:id', async (c) => {
    const user = requireSessionUser(c);
    const row = pendingRequest(c.req.param('id'));
    const body = z
      .object({ approve: z.boolean(), scopes: z.array(z.string()).optional() })
      .parse(await c.req.json());
    db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(row.id);
    const url = new URL(row.redirect_uri);
    if (row.state) url.searchParams.set('state', row.state);
    url.searchParams.set('iss', issuer);
    if (!body.approve) {
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'The user denied access');
      return c.json({ redirect: url.toString() });
    }
    // The user may narrow (never widen) the requested scopes.
    const requested = row.scopes.split(' ');
    const granted = normalizeScopes(
      body.scopes?.filter((s) => requested.includes(s)) ?? requested,
      requested,
    );
    const code = randomToken('pb_code_');
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at, grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256(code),
      row.client_id,
      user.id,
      row.redirect_uri,
      row.code_challenge,
      granted.join(' '),
      row.resource,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
      `grant_${newId()}`,
    );
    url.searchParams.set('code', code);
    return c.json({ redirect: url.toString() });
  });

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.limits.auth.take(`token:${clientKey(c, config.trustProxy)}`))
      throw new HttpError(429, 'Too many requests');
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
    const f = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined);
    const clientId = f('client_id');
    if (!clientId) throw oauthError(401, 'invalid_client', 'client_id is required');

    if (f('grant_type') === 'authorization_code') {
      const code = f('code');
      const verifier = f('code_verifier');
      if (!code || !verifier) throw oauthError(400, 'invalid_request', 'code and code_verifier are required');
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(code)) as
        | {
            client_id: string;
            user_id: string;
            redirect_uri: string;
            code_challenge: string;
            scopes: string;
            resource: string;
            expires_at: string;
            used_at: string | null;
            grant_id: string | null;
          }
        | undefined;
      if (row?.used_at && row.grant_id) {
        // A code used twice was intercepted: revoke whatever the first use produced.
        tokens.revokeGrantById(row.grant_id);
      }
      if (!row || row.used_at || row.expires_at < now())
        throw oauthError(400, 'invalid_grant', 'The authorization code is invalid or expired');
      db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(now(), sha256(code));
      if (row.client_id !== clientId)
        throw oauthError(400, 'invalid_grant', 'Code was issued to another client');
      // OAuth 2.1: redirect_uri must be repeated and match when it was part of the authorization request.
      if (f('redirect_uri') !== row.redirect_uri)
        throw oauthError(400, 'invalid_grant', 'redirect_uri mismatch');
      if (!verifyPkce(verifier, row.code_challenge))
        throw oauthError(400, 'invalid_grant', 'PKCE verification failed');
      const resource = f('resource')?.replace(/\/$/, '');
      if (resource && resource !== config.mcpResource && resource !== config.publicUrl) {
        throw oauthError(400, 'invalid_target', 'Unknown resource');
      }
      const issued = tokens.issueOAuth(
        row.user_id,
        clientId,
        row.scopes.split(' '),
        row.resource,
        row.grant_id ?? undefined,
      );
      markClientUsed(clientId);
      return c.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.scopes.join(' '),
      });
    }

    if (f('grant_type') === 'refresh_token') {
      const refresh = f('refresh_token');
      if (!refresh) throw oauthError(400, 'invalid_request', 'refresh_token is required');
      const scope = f('scope');
      const issued = tokens.refresh(refresh, clientId, scope ? scope.split(' ') : undefined);
      if (!issued)
        throw oauthError(400, 'invalid_grant', 'The refresh token is invalid, expired or was revoked');
      markClientUsed(clientId);
      return c.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.scopes.join(' '),
      });
    }

    throw oauthError(400, 'unsupported_grant_type', 'Supported: authorization_code, refresh_token');
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
    if (typeof form.token === 'string')
      tokens.revokeRaw(form.token, typeof form.client_id === 'string' ? form.client_id : undefined);
    return c.body(null, 200);
  });

  return app;
}
