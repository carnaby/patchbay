import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import { parseSecretKey, SecretKeyring, secretKeyId } from '../util/crypto.ts';
import { Secrets } from './secrets.ts';
import { Users } from './users.ts';

const key = () => randomBytes(32);
const b64 = (k: Buffer) => k.toString('base64');
const AAD = 'pb-secret-v1\nsec_x\nu_1\nhttps://api.example.com\n/\nbearer\n';

describe('sealing secret values', () => {
  it('round-trips with a fresh nonce every time', () => {
    const ring = new SecretKeyring(key());
    const a = ring.seal('token-value-1', AAD);
    const b = ring.seal('token-value-1', AAD);
    expect(a.sealed.equals(b.sealed)).toBe(false);
    expect(a.sealed[0]).toBe(0x01);
    expect(a.sealed.length).toBe(1 + 12 + 'token-value-1'.length + 16);
    expect(ring.open(a.keyId, a.sealed, AAD)).toBe('token-value-1');
  });

  it('fails on any tampering, another row or another key', () => {
    const ring = new SecretKeyring(key());
    const { keyId, sealed } = ring.seal('token-value-1', AAD);
    const flip = (i: number) => {
      const copy = Buffer.from(sealed);
      copy[i] = copy[i]! ^ 0x01;
      return copy;
    };
    expect(ring.open(keyId, flip(0), AAD)).toBeNull(); // version byte
    expect(ring.open(keyId, flip(3), AAD)).toBeNull(); // nonce
    expect(ring.open(keyId, flip(14), AAD)).toBeNull(); // ciphertext
    expect(ring.open(keyId, flip(sealed.length - 1), AAD)).toBeNull(); // tag
    expect(ring.open(keyId, sealed.subarray(0, 20), AAD)).toBeNull();
    expect(ring.open(keyId, sealed, AAD.replace('u_1', 'u_2'))).toBeNull();
    expect(new SecretKeyring(key()).open(keyId, sealed, AAD)).toBeNull();
    expect(ring.open('0123456789abcdef', sealed, AAD)).toBeNull();
  });

  it('never prints key material', () => {
    const k = key();
    const ring = new SecretKeyring(k, [key()]);
    const config = loadConfig({ SECRETS: 'users', SECRETS_KEY: b64(k) });
    for (const shown of [
      inspect(ring, { depth: 5 }),
      inspect(config, { depth: 5 }),
      JSON.stringify(config),
    ]) {
      expect(shown).not.toContain(b64(k));
      expect(shown).not.toContain(k.toString('hex'));
    }
    expect(ring.currentId).toBe(secretKeyId(k));
    expect(ring.currentId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts only keys that decode to exactly 32 bytes', () => {
    const k = key();
    expect(parseSecretKey(b64(k))?.equals(k)).toBe(true);
    expect(parseSecretKey(k.toString('base64url'))?.equals(k)).toBe(true);
    for (const bad of [
      '',
      'short',
      b64(randomBytes(31)),
      b64(randomBytes(33)),
      `${b64(k)}x`,
      k.toString('hex'),
    ]) {
      expect(parseSecretKey(bad), bad).toBeNull();
    }
  });
});

describe('SECRETS configuration', () => {
  it('is off by default and needs no key then', () => {
    expect(loadConfig({}).secrets).toEqual({ mode: 'off', keyring: null });
    expect(loadConfig({ SECRETS: 'off' }).secrets.keyring).toBeNull();
  });

  it('refuses to start when secrets are on without a valid key, without echoing the key', () => {
    expect(() => loadConfig({ SECRETS: 'users' })).toThrow(/SECRETS=users needs SECRETS_KEY/);
    expect(() => loadConfig({ SECRETS: 'admins', SECRETS_KEY: ' ' })).toThrow(/SECRETS_KEY/);
    const bad = b64(randomBytes(16));
    let message = '';
    try {
      loadConfig({ SECRETS: 'users', SECRETS_KEY: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/32 random bytes/);
    expect(message).not.toContain(bad);
    // A malformed key is an error even while the feature is off: it is certainly not what the operator meant.
    expect(() => loadConfig({ SECRETS: 'off', SECRETS_KEY: bad })).toThrow(/SECRETS_KEY/);
    expect(() =>
      loadConfig({ SECRETS: 'users', SECRETS_KEY: b64(key()), SECRETS_KEY_PREVIOUS: 'nope' }),
    ).toThrow(/SECRETS_KEY_PREVIOUS entry 1/);
    expect(() => loadConfig({ SECRETS: 'sometimes' })).toThrow();
    expect(loadConfig({ SECRETS: 'admins', SECRETS_KEY: b64(key()) }).secrets.mode).toBe('admins');
  });
});

describe('Secrets storage', () => {
  const setup = (ring: SecretKeyring | null) => {
    const db = openDatabase(':memory:');
    const users = new Users(db, new Set());
    const alice = users.upsert({ email: 'alice@example.com', name: 'Alice' });
    const bob = users.upsert({ email: 'bob@example.com', name: 'Bob' });
    return { db, alice, bob, secrets: new Secrets(db, ring) };
  };
  const input = {
    name: 'Shop',
    origin: 'https://api.example.com',
    pathPrefix: '/v1/',
    placement: 'bearer' as const,
    paramName: null,
  };

  it('stores only ciphertext and scopes everything by user', () => {
    const { db, alice, bob, secrets } = setup(new SecretKeyring(key()));
    const info = secrets.create(alice.id, input, 'value-of-alice');
    expect(info.id).toMatch(/^sec_[A-Za-z0-9]{16}$/);
    expect(JSON.stringify(info)).not.toContain('value-of-alice');
    const row = db.prepare('SELECT * FROM secrets').get() as Record<string, unknown>;
    expect(Buffer.from(row.sealed as Uint8Array).toString('latin1')).not.toContain('value-of-alice');
    expect(secrets.unseal(alice.id, info.id)?.value).toBe('value-of-alice');
    expect(secrets.unseal(bob.id, info.id)).toBeNull();
    expect(secrets.info(bob.id, info.id)).toBeNull();
    expect(secrets.list(bob.id)).toEqual([]);
    expect(secrets.rename(bob.id, info.id, 'Mine')).toBeNull();
    expect(secrets.replaceValue(bob.id, info.id, 'value-of-bob')).toBeNull();
    expect(secrets.remove(bob.id, info.id)).toBe(false);
    expect(() => secrets.create(alice.id, { ...input, name: 'shop' }, 'x'.repeat(8))).toThrow(/already have/);
    expect(secrets.create(bob.id, input, 'value-of-bob').name).toBe('Shop');
  });

  it('bumps the revision on every value change, not on renames', () => {
    const { alice, secrets } = setup(new SecretKeyring(key()));
    const info = secrets.create(alice.id, input, 'first-value');
    expect(secrets.unseal(alice.id, info.id)?.revision).toBe(1);
    secrets.rename(alice.id, info.id, 'Renamed');
    expect(secrets.unseal(alice.id, info.id)?.revision).toBe(1);
    secrets.replaceValue(alice.id, info.id, 'second-value');
    expect(secrets.unseal(alice.id, info.id)).toMatchObject({ revision: 2, value: 'second-value' });
  });

  it('does not decrypt a sealed value moved to another row, user or binding', () => {
    const { db, alice, bob, secrets } = setup(new SecretKeyring(key()));
    const a = secrets.create(alice.id, input, 'value-of-alice');
    const b = secrets.create(bob.id, input, 'value-of-bob');
    const sealedA = (
      db.prepare('SELECT sealed FROM secrets WHERE id = ?').get(a.id) as { sealed: Uint8Array }
    ).sealed;
    // Someone with write access to the database but without the key copies Alice's value into Bob's row...
    db.prepare('UPDATE secrets SET sealed = ? WHERE id = ?').run(sealedA, b.id);
    expect(secrets.unseal(bob.id, b.id)?.value).toBeNull();
    // ...or re-points Alice's own row at a host they control, or moves it to Bob.
    db.prepare("UPDATE secrets SET origin = 'https://evil.example' WHERE id = ?").run(a.id);
    expect(secrets.unseal(alice.id, a.id)?.value).toBeNull();
    db.prepare("UPDATE secrets SET origin = 'https://api.example.com', path_prefix = '/' WHERE id = ?").run(
      a.id,
    );
    expect(secrets.unseal(alice.id, a.id)?.value).toBeNull();
    db.prepare(
      "UPDATE secrets SET path_prefix = '/v1/', placement = 'query', param_name = 'k' WHERE id = ?",
    ).run(a.id);
    expect(secrets.unseal(alice.id, a.id)?.value).toBeNull();
    db.prepare(
      "UPDATE secrets SET placement = 'bearer', param_name = NULL, name = 'Moved', user_id = ? WHERE id = ?",
    ).run(bob.id, a.id);
    expect(secrets.unseal(bob.id, a.id)?.value).toBeNull();
    db.prepare('UPDATE secrets SET user_id = ? WHERE id = ?').run(alice.id, a.id);
    expect(secrets.unseal(alice.id, a.id)?.value).toBe('value-of-alice');
  });

  it('rotates to a new key, after which the old one is no longer needed', () => {
    const oldKey = key();
    const newKey = key();
    const { db, alice, secrets } = setup(new SecretKeyring(oldKey));
    const a = secrets.create(alice.id, input, 'value-a-123');
    const b = secrets.create(alice.id, { ...input, name: 'Other' }, 'value-b-123');
    const rotating = new Secrets(db, new SecretKeyring(newKey, [oldKey]));
    expect(rotating.rotate()).toEqual({ resealed: 2, undecryptable: 0 });
    expect(rotating.rotate()).toEqual({ resealed: 0, undecryptable: 0 });
    const after = new Secrets(db, new SecretKeyring(newKey));
    expect(after.unseal(alice.id, a.id)?.value).toBe('value-a-123');
    expect(after.unseal(alice.id, b.id)?.value).toBe('value-b-123');
    const keyIds = db.prepare('SELECT DISTINCT key_id FROM secrets').all() as { key_id: string }[];
    expect(keyIds).toEqual([{ key_id: secretKeyId(newKey) }]);
    // Rotation re-seals but is not a value change.
    expect(after.unseal(alice.id, a.id)?.revision).toBe(1);
  });

  it('counts rows no configured key can open and leaves them untouched', () => {
    const lost = key();
    const { db, alice, secrets } = setup(new SecretKeyring(lost));
    const a = secrets.create(alice.id, input, 'value-a-123');
    const before = db.prepare('SELECT key_id, sealed FROM secrets').get();
    const fresh = new Secrets(db, new SecretKeyring(key()));
    expect(fresh.rotate()).toEqual({ resealed: 0, undecryptable: 1 });
    expect(db.prepare('SELECT key_id, sealed FROM secrets').get()).toEqual(before);
    expect(fresh.unseal(alice.id, a.id)).toMatchObject({ value: null, info: { name: 'Shop' } });
    // The owner can store a value again under the current key.
    fresh.replaceValue(alice.id, a.id, 'value-a-new');
    expect(fresh.unseal(alice.id, a.id)?.value).toBe('value-a-new');
  });

  it('lists and deletes without a key, but cannot seal', () => {
    const ring = new SecretKeyring(key());
    const { db, alice } = setup(ring);
    const created = new Secrets(db, ring).create(alice.id, input, 'value-a-123');
    const off = new Secrets(db, null);
    expect(off.list(alice.id).map((s) => s.id)).toEqual([created.id]);
    expect(off.unseal(alice.id, created.id)?.value).toBeNull();
    expect(() => off.create(alice.id, { ...input, name: 'x' }, 'value-x-123')).toThrow(/turned off/);
    expect(off.rotate()).toEqual({ resealed: 0, undecryptable: 0 });
    expect(off.remove(alice.id, created.id)).toBe(true);
  });

  it('writes last-used at most once a minute', () => {
    const { db, alice, secrets } = setup(new SecretKeyring(key()));
    const a = secrets.create(alice.id, input, 'value-a-123');
    secrets.markUsed(secrets.info(alice.id, a.id)!);
    const first = secrets.info(alice.id, a.id)!.lastUsedAt;
    expect(first).toBeTruthy();
    db.prepare("UPDATE secrets SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
    const stale = secrets.info(alice.id, a.id)!;
    secrets.markUsed({ ...stale, lastUsedAt: new Date().toISOString() });
    expect(secrets.info(alice.id, a.id)!.lastUsedAt).toBe('2000-01-01T00:00:00.000Z');
    secrets.markUsed(stale);
    expect(secrets.info(alice.id, a.id)!.lastUsedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('deletes a user’s secrets with the user and counts per user for the admin', () => {
    const { db, alice, bob, secrets } = setup(new SecretKeyring(key()));
    secrets.create(alice.id, input, 'value-a-123');
    secrets.create(alice.id, { ...input, name: 'Two' }, 'value-a-456');
    secrets.create(bob.id, input, 'value-b-123');
    expect(secrets.countsByUser()).toEqual([
      { userId: alice.id, email: 'alice@example.com', secrets: 2 },
      { userId: bob.id, email: 'bob@example.com', secrets: 1 },
    ]);
    db.prepare('DELETE FROM users WHERE id = ?').run(alice.id);
    expect(secrets.count(alice.id)).toBe(0);
    expect(secrets.count(bob.id)).toBe(1);
  });
});
