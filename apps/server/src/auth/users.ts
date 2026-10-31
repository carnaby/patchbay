import type { PublicUser } from '@patchbay/core';
import { type DB, now } from '../db.ts';
import { newId, randomToken, sha256 } from '../util/crypto.ts';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_sub: string | null;
}

export const SESSION_COOKIE = 'pb_session';
const SESSION_DAYS = 30;
export const OAUTH_CLIENT_UNUSED_TTL_MS = 24 * 3_600_000;
export const OAUTH_CLIENT_IDLE_TTL_MS = 90 * 86_400_000;

export class Users {
  private readonly db: DB;
  private readonly adminEmails: Set<string>;

  constructor(db: DB, adminEmails: Set<string>) {
    this.db = db;
    this.adminEmails = adminEmails;
  }

  toPublic(u: UserRow): PublicUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatar_url,
      isAdmin: this.adminEmails.has(u.email.toLowerCase()),
    };
  }

  isAdmin(u: { email: string } | null | undefined): boolean {
    return Boolean(u && this.adminEmails.has(u.email.toLowerCase()));
  }

  byId(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  /** Creates or updates a user from a verified identity (Google, or dev login). */
  upsert(identity: {
    email: string;
    name: string;
    avatarUrl?: string | null;
    googleSub?: string | null;
  }): UserRow {
    const email = identity.email.toLowerCase();
    const existing =
      (identity.googleSub
        ? (this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(identity.googleSub) as
            | UserRow
            | undefined)
        : undefined) ??
      (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined);
    const at = now();
    if (existing) {
      this.db
        .prepare(
          'UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url), google_sub = COALESCE(?, google_sub), last_login_at = ? WHERE id = ?',
        )
        .run(email, identity.name, identity.avatarUrl ?? null, identity.googleSub ?? null, at, existing.id);
      return this.byId(existing.id)!;
    }
    const id = `u_${newId()}`;
    this.db
      .prepare(
        'INSERT INTO users (id, email, name, avatar_url, google_sub, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, email, identity.name, identity.avatarUrl ?? null, identity.googleSub ?? null, at, at);
    return this.byId(id)!;
  }

  createSession(userId: string): { token: string; expires: Date } {
    const token = randomToken('pbs_');
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, now(), expires.toISOString());
    return { token, expires };
  }

  userForSession(token: string | undefined): UserRow | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), now()) as UserRow | undefined;
    return row ?? null;
  }

  deleteSession(token: string | undefined) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
  }

  /**
   * Removes everything the database holds for a user in one transaction: dashboard index rows, secrets, tokens
   * (personal, OAuth access and refresh), authorization codes, sessions and the user. The foreign keys would
   * cascade most of it, but the counts are what the operator logs, and nothing should depend on a pragma.
   * Pending authorization requests carry no user id (they are anonymous until consent) and expire by themselves.
   */
  eraseUser(userId: string) {
    const run = (sql: string) => Number(this.db.prepare(sql).run(userId).changes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const counts = {
        dashboardRows: run('DELETE FROM dashboards WHERE owner_id = ?'),
        secrets: run('DELETE FROM secrets WHERE user_id = ?'),
        tokens: run('DELETE FROM tokens WHERE user_id = ?'),
        codes: run('DELETE FROM oauth_codes WHERE user_id = ?'),
        sessions: run('DELETE FROM sessions WHERE user_id = ?'),
        users: run('DELETE FROM users WHERE id = ?'),
      };
      this.db.exec('COMMIT');
      return counts;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  purgeExpired() {
    const at = now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at);
    this.db.prepare('DELETE FROM oauth_requests WHERE expires_at < ?').run(at);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(at);
    this.db
      .prepare("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ? AND kind != 'pat'")
      .run(at);
    this.purgeOAuthClients(Date.now());
  }

  /**
   * Anyone can register an OAuth client, so registrations must not pile up. A client that never obtained a grant
   * goes after a day; one that did goes once it has held no live token for a long time. Client metadata documents
   * are only a cache of a URL and can be fetched again, so they follow the short rule.
   */
  purgeOAuthClients(nowMs: number) {
    const at = new Date(nowMs).toISOString();
    const unusedBefore = new Date(nowMs - OAUTH_CLIENT_UNUSED_TTL_MS).toISOString();
    const idleBefore = new Date(nowMs - OAUTH_CLIENT_IDLE_TTL_MS).toISOString();
    return this.db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE (
             (kind = 'dcr' AND last_used_at IS NULL AND created_at < @unusedBefore)
             OR (kind = 'dcr' AND last_used_at < @idleBefore)
             OR (kind = 'cimd' AND COALESCE(last_used_at, created_at) < @unusedBefore)
           )
           AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = oauth_clients.client_id
                           AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > @at))
           AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.client_id
                           AND c.used_at IS NULL AND c.expires_at > @at)
           AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.client_id
                           AND r.expires_at > @at)`,
      )
      .run({ at, unusedBefore, idleBefore }).changes;
  }
}
