import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';

/** URL-safe random secret with a recognisable prefix (helps secret scanners and humans). */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

/** Tokens are only ever stored as SHA-256 hashes; a leaked database cannot be replayed. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** PKCE S256: BASE64URL(SHA256(verifier)) must equal the challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

/** Dashboard ids: 12 chars of a lowercase alphabet without look-alikes. */
export const newDashboardId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 12);
export const newId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 16);

const SEAL_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Parses a `SECRETS_KEY`: standard or URL-safe base64 of exactly 32 bytes. Returns null for anything else. */
export function parseSecretKey(raw: string): Buffer | null {
  const text = raw.trim();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
  const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === 32 ? key : null;
}

/** Names a key in the database without revealing anything useful about it. */
export function secretKeyId(key: Buffer): string {
  return createHash('sha256').update('patchbay-secrets-key-id').update(key).digest('hex').slice(0, 16);
}

/**
 * The keys that seal secret values (AES-256-GCM). Key material lives in private fields, so logging a config or
 * deps object never prints it.
 */
export class SecretKeyring {
  readonly currentId: string;
  readonly #current: Buffer;
  readonly #previous: Map<string, Buffer>;

  constructor(current: Buffer, previous: Buffer[] = []) {
    this.#current = current;
    this.currentId = secretKeyId(current);
    this.#previous = new Map(previous.map((k) => [secretKeyId(k), k]));
    this.#previous.delete(this.currentId);
  }

  /** Whether a row sealed with `keyId` can be opened by one of the configured keys. */
  knows(keyId: string): boolean {
    return keyId === this.currentId || this.#previous.has(keyId);
  }

  /** `0x01 ‖ nonce ‖ ciphertext ‖ tag`, with a fresh random nonce; `aad` binds the result to its row. */
  seal(plaintext: string, aad: string): { keyId: string; sealed: Buffer } {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#current, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      keyId: this.currentId,
      sealed: Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, body, cipher.getAuthTag()]),
    };
  }

  /** The plaintext, or null when no configured key has this id or the data, tag, nonce or `aad` do not match. */
  open(keyId: string, sealed: Uint8Array, aad: string): string | null {
    const key = keyId === this.currentId ? this.#current : this.#previous.get(keyId);
    const data = Buffer.from(sealed);
    if (!key || data.length < 1 + NONCE_BYTES + TAG_BYTES || data[0] !== SEAL_VERSION) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 1 + NONCE_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(data.subarray(1 + NONCE_BYTES, data.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
