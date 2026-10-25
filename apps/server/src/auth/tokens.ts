/**
 * Bearer tokens for the MCP endpoint and the API.
 *
 * - Personal access tokens (`pb_pat_…`) for development, scripts and clients
 *   without OAuth support. Created by the user, revocable, optionally expiring.
 * - OAuth access tokens (`pb_at_…`, 1 h) and refresh tokens (`pb_rt_…`, 30 d)
 *   issued by the built-in authorization server. Refresh tokens rotate on every
 *   use; replaying an old one revokes the whole grant (theft detection).
 *
 * Only SHA-256 hashes are stored.
 */
import { type DB, now } from '../db.ts';
import { newId, randomToken, sha256 } from '../util/crypto.ts';

export const SCOPES = {
  read: 'dashboards:read',
  write: 'dashboards:write',
} as const;
export const ALL_SCOPES: string[] = [SCOPES.read, SCOPES.write];

const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 86_400;

export interface TokenRow {
  id: string;
  kind: 'pat' | 'access' | 'refresh';
  user_id: string;
  client_id: string | null;
  grant_id: string | null;
  name: string | null;
  scopes: string;
  resource: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface VerifiedToken {
  tokenId: string;
  kind: TokenRow['kind'];
  userId: string;
  clientId: string | null;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
}

export interface PatInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface GrantInfo {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export function normalizeScopes(
  raw: string | string[] | undefined | null,
  fallback: string[] = ALL_SCOPES,
): string[] {
  const list = (Array.isArray(raw) ? raw : (raw ?? '').split(/\s+/)).filter(Boolean);
  const valid = list.filter((s) => (ALL_SCOPES as string[]).includes(s));
  const result = valid.length ? valid : fallback;
  // Write implies read.
  return result.includes(SCOPES.write) && !result.includes(SCOPES.read)
    ? [SCOPES.read, ...result]
    : [...new Set(result)];
}

export class Tokens {
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  private insert(row: Omit<TokenRow, 'created_at' | 'last_used_at' | 'revoked_at'> & { hash: string }) {
    this.db
      .prepare(
        `INSERT INTO tokens (id, hash, kind, user_id, client_id, grant_id, name, scopes, resource, created_at, expires_at)
         VALUES (@id, @hash, @kind, @user_id, @client_id, @grant_id, @name, @scopes, @resource, @created_at, @expires_at)`,
      )
      .run({ ...row, created_at: now() });
  }

  createPat(
    userId: string,
    name: string,
    scopes: string[],
    expiresInDays?: number,
  ): { token: string; info: PatInfo } {
    const token = randomToken('pb_pat_');
    const id = `tok_${newId()}`;
    const expires = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    this.insert({
      id,
      hash: sha256(token),
      kind: 'pat',
      user_id: userId,
      client_id: null,
      grant_id: null,
      name,
      scopes: normalizeScopes(scopes).join(' '),
      resource: null,
      expires_at: expires,
    });
    return { token, info: this.listPats(userId).find((p) => p.id === id)! };
  }

  listPats(userId: string): PatInfo[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tokens WHERE user_id = ? AND kind = 'pat' AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(userId) as TokenRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? 'Token',
      scopes: r.scopes.split(' '),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  revokePat(userId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = 'pat' AND revoked_at IS NULL",
        )
        .run(now(), id, userId).changes > 0
    );
  }

  issueOAuth(
    userId: string,
    clientId: string,
    scopes: string[],
    resource: string,
    grantId = `grant_${newId()}`,
  ) {
    const access = randomToken('pb_at_');
    const refresh = randomToken('pb_rt_');
    const base = {
      user_id: userId,
      client_id: clientId,
      grant_id: grantId,
      name: null,
      scopes: scopes.join(' '),
      resource,
    };
    this.insert({
      ...base,
      id: `tok_${newId()}`,
      hash: sha256(access),
      kind: 'access',
      expires_at: new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString(),
    });
    this.insert({
      ...base,
      id: `tok_${newId()}`,
      hash: sha256(refresh),
      kind: 'refresh',
      expires_at: new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString(),
    });
    return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL_SEC, scopes };
  }

  /** Rotates a refresh token. Returns null for unknown/expired tokens; revokes the grant on reuse. */
  refresh(raw: string, clientId: string, requestedScopes?: string[]) {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'")
      .get(sha256(raw)) as TokenRow | undefined;
    if (!row || row.client_id !== clientId) return null;
    if (row.revoked_at) {
      // A rotated token came back: someone else has a copy. Kill the whole grant.
      this.revokeGrantById(row.grant_id!);
      return null;
    }
    if (row.expires_at && row.expires_at < now()) return null;
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(now(), row.id);
    const granted = row.scopes.split(' ');
    const scopes = requestedScopes?.length ? requestedScopes.filter((s) => granted.includes(s)) : granted;
    return this.issueOAuth(
      row.user_id,
      clientId,
      scopes.length ? scopes : granted,
      row.resource ?? '',
      row.grant_id!,
    );
  }

  verify(raw: string): VerifiedToken | null {
    if (!/^pb_(pat|at)_/.test(raw)) return null;
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE hash = ? AND kind IN ('pat', 'access') AND revoked_at IS NULL")
      .get(sha256(raw)) as TokenRow | undefined;
    if (!row) return null;
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Date.now() + 365 * 86_400_000;
    if (expiresAt <= Date.now()) return null;
    // Throttle last-used writes to once a minute per token.
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
      this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    }
    return {
      tokenId: row.id,
      kind: row.kind,
      userId: row.user_id,
      clientId: row.client_id,
      scopes: row.scopes.split(' '),
      resource: row.resource,
      expiresAt,
    };
  }

  /** Revokes an access or refresh token (RFC 7009). Unknown tokens are silently ignored. */
  revokeRaw(raw: string, clientId?: string) {
    const row = this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(sha256(raw)) as
      | TokenRow
      | undefined;
    if (!row || (clientId && row.client_id !== clientId)) return;
    if (row.kind === 'refresh' && row.grant_id) this.revokeGrantById(row.grant_id);
    else this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(now(), row.id);
  }

  listGrants(userId: string): GrantInfo[] {
    const rows = this.db
      .prepare(
        `SELECT t.grant_id, t.client_id, MIN(t.created_at) AS created_at, MAX(t.last_used_at) AS last_used_at,
                MAX(t.scopes) AS scopes, c.name AS client_name
         FROM tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.grant_id IS NOT NULL AND t.revoked_at IS NULL AND t.expires_at > ?
         GROUP BY t.grant_id ORDER BY created_at DESC`,
      )
      .all(userId, now()) as {
      grant_id: string;
      client_id: string;
      created_at: string;
      last_used_at: string | null;
      scopes: string;
      client_name: string | null;
    }[];
    return rows.map((r) => ({
      grantId: r.grant_id,
      clientId: r.client_id,
      clientName: r.client_name ?? r.client_id,
      scopes: r.scopes.split(' '),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  revokeGrant(userId: string, grantId: string): boolean {
    return (
      this.db
        .prepare('UPDATE tokens SET revoked_at = ? WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL')
        .run(now(), grantId, userId).changes > 0
    );
  }

  private revokeGrantById(grantId: string) {
    this.db
      .prepare('UPDATE tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL')
      .run(now(), grantId);
  }
}
