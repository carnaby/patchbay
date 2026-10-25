import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';

/** URL-safe random secret with a recognisable prefix (helps secret scanners and humans). */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

/** Secrets are only ever stored as SHA-256 hashes; a leaked database cannot be replayed. */
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
