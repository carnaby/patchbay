/**
 * Credentials for HTTP data sources: storage and encryption only.
 *
 * Mirrors `Tokens`: every method is scoped by user id, and the rules about who may do what live in
 * DashboardService. Values are sealed with AES-256-GCM; the associated data ties each ciphertext to its row, its
 * owner and its binding, so a sealed value copied elsewhere in the database (another row, user or address) does not
 * decrypt even for someone who can write to the database but lacks the key.
 *
 * Nothing here returns a value except `unseal`, whose only caller is `DashboardService.credentialsFor`.
 */
import type { SecretInfo, SecretPlacement } from '@patchbay/core';
import { type DB, now } from '../db.ts';
import { newId, type SecretKeyring } from '../util/crypto.ts';
import { badRequest, HttpError } from '../util/errors.ts';

interface SecretRow {
  id: string;
  user_id: string;
  name: string;
  origin: string;
  path_prefix: string;
  placement: SecretPlacement;
  param_name: string | null;
  key_id: string;
  sealed: Uint8Array;
  revision: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** A secret ready to be sent. Exists only for the duration of one data request. */
export interface UnsealedSecret {
  info: SecretInfo;
  revision: number;
  /** null when no configured key can decrypt it (key lost or changed without rotation). */
  value: string | null;
}

const LAST_USED_INTERVAL_MS = 60_000;

const toInfo = (r: SecretRow): SecretInfo => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  pathPrefix: r.path_prefix,
  placement: r.placement,
  paramName: r.param_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

/** Associated data: changing any of these fields in the database makes the ciphertext unreadable. */
function aad(
  r: Pick<SecretRow, 'id' | 'user_id' | 'origin' | 'path_prefix' | 'placement' | 'param_name'>,
): string {
  return ['pb-secret-v1', r.id, r.user_id, r.origin, r.path_prefix, r.placement, r.param_name ?? ''].join(
    '\n',
  );
}

export class Secrets {
  private readonly db: DB;
  private readonly keyring: SecretKeyring | null;

  constructor(db: DB, keyring: SecretKeyring | null) {
    this.db = db;
    this.keyring = keyring;
  }

  private row(userId: string, id: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE id = ? AND user_id = ?').get(id, userId) as
      | SecretRow
      | undefined;
  }

  private requireKeyring(): SecretKeyring {
    // The switch decides earlier; this only guards against a caller that skipped it.
    if (!this.keyring) throw new HttpError(503, 'Secrets are turned off on this server.');
    return this.keyring;
  }

  list(userId: string): SecretInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM secrets WHERE user_id = ? ORDER BY name COLLATE NOCASE')
      .all(userId) as unknown as SecretRow[];
    return rows.map(toInfo);
  }

  info(userId: string, id: string): SecretInfo | null {
    const r = this.row(userId, id);
    return r ? toInfo(r) : null;
  }

  count(userId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM secrets WHERE user_id = ?').get(userId) as { n: number }
    ).n;
  }

  private assertNameFree(userId: string, name: string, except?: string) {
    const clash = this.db
      .prepare('SELECT id FROM secrets WHERE user_id = ? AND name = ? AND id != ?')
      .get(userId, name, except ?? '') as { id: string } | undefined;
    if (clash) throw badRequest(`You already have a secret named "${name}"`);
  }

  create(
    userId: string,
    input: {
      name: string;
      origin: string;
      pathPrefix: string;
      placement: SecretPlacement;
      paramName: string | null;
    },
    value: string,
  ): SecretInfo {
    const keyring = this.requireKeyring();
    this.assertNameFree(userId, input.name);
    const at = now();
    const base = {
      id: `sec_${newId()}`,
      user_id: userId,
      origin: input.origin,
      path_prefix: input.pathPrefix,
      placement: input.placement,
      param_name: input.paramName,
    };
    const { keyId, sealed } = keyring.seal(value, aad(base));
    this.db
      .prepare(
        `INSERT INTO secrets (id, user_id, name, origin, path_prefix, placement, param_name, key_id, sealed, revision, created_at, updated_at)
         VALUES (@id, @user_id, @name, @origin, @path_prefix, @placement, @param_name, @key_id, @sealed, 1, @at, @at)`,
      )
      .run({ ...base, name: input.name, key_id: keyId, sealed, at });
    return this.info(userId, base.id)!;
  }

  rename(userId: string, id: string, name: string): SecretInfo | null {
    if (!this.row(userId, id)) return null;
    this.assertNameFree(userId, name, id);
    this.db
      .prepare('UPDATE secrets SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(name, now(), id, userId);
    return this.info(userId, id);
  }

  /** Re-seals a new value under the same binding. The revision bump invalidates every cache keyed on it. */
  replaceValue(userId: string, id: string, value: string): SecretInfo | null {
    const keyring = this.requireKeyring();
    const r = this.row(userId, id);
    if (!r) return null;
    const { keyId, sealed } = keyring.seal(value, aad(r));
    this.db
      .prepare(
        'UPDATE secrets SET key_id = ?, sealed = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?',
      )
      .run(keyId, sealed, now(), id, userId);
    return this.info(userId, id);
  }

  remove(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM secrets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /** Decrypts one of the user's secrets for a request. null when the user has no secret with this id. */
  unseal(userId: string, id: string): UnsealedSecret | null {
    const r = this.row(userId, id);
    if (!r) return null;
    const value = this.keyring?.open(r.key_id, r.sealed, aad(r)) ?? null;
    return { info: toInfo(r), revision: r.revision, value };
  }

  /** Records use at most once a minute per secret, so a one-second live refresh is not a write per second. */
  markUsed(info: SecretInfo) {
    if (info.lastUsedAt && Date.now() - Date.parse(info.lastUsedAt) < LAST_USED_INTERVAL_MS) return;
    this.db.prepare('UPDATE secrets SET last_used_at = ? WHERE id = ?').run(now(), info.id);
  }

  /**
   * Re-seals every row sealed with a previous key under the current one, in one transaction. Rows no configured key
   * can open are left untouched (their owners can replace the value) and counted.
   */
  rotate(): { resealed: number; undecryptable: number } {
    if (!this.keyring) return { resealed: 0, undecryptable: 0 };
    const keyring = this.keyring;
    const stale = this.db
      .prepare('SELECT * FROM secrets WHERE key_id != ?')
      .all(keyring.currentId) as unknown as SecretRow[];
    let resealed = 0;
    let undecryptable = 0;
    const update = this.db.prepare('UPDATE secrets SET key_id = ?, sealed = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const r of stale) {
        const value = keyring.open(r.key_id, r.sealed, aad(r));
        if (value === null) {
          undecryptable++;
          continue;
        }
        const { keyId, sealed } = keyring.seal(value, aad(r));
        update.run(keyId, sealed, r.id);
        resealed++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { resealed, undecryptable };
  }

  /** Number of secrets per user, for the admin page: whom to tell if the key and a database copy leaked. */
  countsByUser(): { userId: string; email: string; secrets: number }[] {
    return this.db
      .prepare(
        `SELECT s.user_id AS userId, u.email AS email, COUNT(*) AS secrets
         FROM secrets s JOIN users u ON u.id = s.user_id GROUP BY s.user_id ORDER BY secrets DESC`,
      )
      .all() as unknown as { userId: string; email: string; secrets: number }[];
  }
}
