import type { SecretMode } from '@patchbay/core';
import { z } from 'zod';
import { parseSecretKey, SecretKeyring } from './util/crypto.ts';

const bool = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

/**
 * Which header, if any, carries the real client IP for rate limiting.
 * `cloudflare` is separate from the generic setting because CF-Connecting-IP is only trustworthy when
 * every request reaches the origin through Cloudflare; anywhere else a client could simply send it.
 */
const trustProxy = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', 'cloudflare', ''])
  .optional()
  .transform((v): TrustProxy => {
    if (v === 'cloudflare') return 'cloudflare';
    return v === '1' || v === 'true' || v === 'yes' ? 'forwarded' : 'off';
  });

export type TrustProxy = 'off' | 'forwarded' | 'cloudflare';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8787),
  /** Canonical public origin, e.g. https://patchbay.example.com. Used for OAuth issuer and MCP resource URIs. */
  PUBLIC_URL: z.url().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ADMIN_EMAILS: z.string().default(''),
  /** Passwordless "log in as any email" for local development. Refused in production. */
  DEV_LOGIN: bool,
  /** Serve deterministic synthetic data instead of calling public APIs (offline demos, CI). */
  OFFLINE: bool,
  /** Automatically delete anonymous dashboards not viewed for this many days (0 = never). */
  PRUNE_ANONYMOUS_AFTER_DAYS: z.coerce.number().int().min(0).default(0),
  WEB_DIST: z.string().optional(),
  TRUST_PROXY: trustProxy,
  /** Worker threads for data processing; 0 runs pipelines on the main thread. Default: CPUs - 1, max 4. */
  PIPELINE_WORKERS: z.coerce.number().int().min(0).max(32).optional(),
  /** Hard time limit per pipeline run in a worker. */
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  /** Who may store credentials for HTTP sources. Off unless the operator decides otherwise, see proposal 0003. */
  SECRETS: z.enum(['off', 'admins', 'users']).default('off'),
  /** 32 random bytes, base64. Seals secret values; required unless SECRETS=off. */
  SECRETS_KEY: z.string().optional(),
  /** Comma-separated earlier keys, only while rotating: rows sealed with them are re-sealed at startup. */
  SECRETS_KEY_PREVIOUS: z.string().optional(),
});

/**
 * Builds the keyring from the environment. A malformed key is always an error, and a missing one is when secrets are
 * on: the operator clearly meant to enable them, and a half-working feature is worse than a clear refusal to start.
 * Messages never include the key.
 */
function secretKeys(env: { SECRETS: SecretMode; SECRETS_KEY?: string; SECRETS_KEY_PREVIOUS?: string }) {
  const current = env.SECRETS_KEY?.trim() ? parseSecretKey(env.SECRETS_KEY) : null;
  if (env.SECRETS_KEY?.trim() && !current) {
    throw new Error(
      'SECRETS_KEY must be 32 random bytes in base64 (e.g. `openssl rand -base64 32`); the configured value is not',
    );
  }
  const previous = (env.SECRETS_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k, i) => {
      const key = parseSecretKey(k);
      if (!key) throw new Error(`SECRETS_KEY_PREVIOUS entry ${i + 1} is not 32 bytes in base64`);
      return key;
    });
  if (env.SECRETS !== 'off' && !current) {
    throw new Error(
      `SECRETS=${env.SECRETS} needs SECRETS_KEY (32 random bytes in base64, e.g. \`openssl rand -base64 32\`). Set it, or set SECRETS=off.`,
    );
  }
  if (previous.length && !current)
    throw new Error('SECRETS_KEY_PREVIOUS needs a current SECRETS_KEY to rotate to');
  return current ? new SecretKeyring(current, previous) : null;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.parse(env);
  const production = parsed.NODE_ENV === 'production';
  const publicUrl = parsed.PUBLIC_URL.replace(/\/+$/, '');
  // Passwordless login is only ever acceptable on a developer's machine.
  if (
    parsed.DEV_LOGIN &&
    (production || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicUrl).hostname))
  ) {
    throw new Error('DEV_LOGIN is only allowed with NODE_ENV != production and a localhost PUBLIC_URL');
  }
  return {
    env: parsed.NODE_ENV,
    production,
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir: parsed.DATA_DIR,
    google:
      parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET
        ? { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET }
        : null,
    adminEmails: new Set(
      parsed.ADMIN_EMAILS.split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    devLogin: parsed.DEV_LOGIN,
    offline: parsed.OFFLINE,
    pruneAnonymousAfterDays: parsed.PRUNE_ANONYMOUS_AFTER_DAYS,
    webDist: parsed.WEB_DIST,
    trustProxy: parsed.TRUST_PROXY,
    mcpResource: `${publicUrl}/mcp`,
    pipelineWorkers: parsed.PIPELINE_WORKERS,
    pipelineTimeoutMs: parsed.PIPELINE_TIMEOUT_MS,
    secrets: { mode: parsed.SECRETS as SecretMode, keyring: secretKeys(parsed) },
  };
}
