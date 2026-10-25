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

  purgeExpired() {
    const at = now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at);
    this.db.prepare('DELETE FROM oauth_requests WHERE expires_at < ?').run(at);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(at);
    this.db
      .prepare("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ? AND kind != 'pat'")
      .run(at);
  }
}
