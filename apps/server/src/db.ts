/**
 * SQLite holds identities and an index - never dashboard content.
 *
 * Dashboard folders on disk are the source of truth; the `dashboards` table is
 * a cache that the reconciler can rebuild from those folders at any time.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Node's built-in SQLite: no native add-on to compile, so `pnpm install` works
 * on every platform without a C++ toolchain.
 */
export type DB = DatabaseSync;

let warningFilterInstalled = false;

/** node:sqlite still prints an ExperimentalWarning; hide that one, keep all others. */
function silenceSqliteWarning() {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    avatar_url    TEXT,
    google_sub    TEXT UNIQUE,
    created_at    TEXT NOT NULL,
    last_login_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Personal access tokens, OAuth access tokens and OAuth refresh tokens.
  CREATE TABLE tokens (
    id           TEXT PRIMARY KEY,
    hash         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('pat', 'access', 'refresh')),
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id    TEXT,
    grant_id     TEXT,
    name         TEXT,
    scopes       TEXT NOT NULL,
    resource     TEXT,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX tokens_user ON tokens(user_id);
  CREATE INDEX tokens_grant ON tokens(grant_id);

  CREATE TABLE oauth_clients (
    client_id     TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    metadata      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    fetched_at    TEXT
  );

  -- A pending authorization request waiting for the user's consent.
  CREATE TABLE oauth_requests (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    state          TEXT,
    code_challenge TEXT NOT NULL,
    scopes         TEXT NOT NULL,
    resource       TEXT NOT NULL,
    expires_at     TEXT NOT NULL
  );

  CREATE TABLE oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes         TEXT NOT NULL,
    resource       TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_at        TEXT
  );

  CREATE TABLE dashboards (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT,
    title          TEXT NOT NULL,
    visibility     TEXT NOT NULL,
    version        INTEGER NOT NULL,
    widgets        INTEGER NOT NULL DEFAULT 0,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_viewed_at TEXT NOT NULL
  );
  CREATE INDEX dashboards_owner ON dashboards(owner_id);
  CREATE INDEX dashboards_viewed ON dashboards(last_viewed_at);
  `,
  // 2: remember which grant a code produced, so replaying the code can revoke it (RFC 6749 §4.1.2).
  `ALTER TABLE oauth_codes ADD COLUMN grant_id TEXT;`,
  // 3: credentials for HTTP sources (proposal 0003). Per user like tokens, never in dashboard folders, which are
  // copied, inspected and deleted by hand. Only ciphertext is stored; see auth/secrets.ts.
  `
  CREATE TABLE secrets (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL COLLATE NOCASE,
    origin       TEXT NOT NULL,
    path_prefix  TEXT NOT NULL DEFAULT '/',
    placement    TEXT NOT NULL CHECK (placement IN ('bearer', 'header', 'query')),
    param_name   TEXT,
    key_id       TEXT NOT NULL,
    sealed       BLOB NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE (user_id, name)
  );
  CREATE INDEX secrets_user ON secrets(user_id);
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  silenceSqliteWarning();
  // Loaded lazily so the warning filter above is in place first.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export const now = () => new Date().toISOString();
