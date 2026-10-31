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

/** Compose passes `${VAR:-}` through as an empty string; that means "not set", not "invalid". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

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
  /** Delete anonymous dashboards still blank (never edited) this many hours after creation (0 = never). */
  PRUNE_BLANK_ANONYMOUS_AFTER_HOURS: z.coerce.number().int().min(0).default(0),
  /**
   * Disk space all anonymous dashboards together may take, in MB (0 = no limit). Above it, anonymous dashboards
   * cannot be created or grown; signed-in users are not affected.
   */
  ANONYMOUS_STORAGE_LIMIT_MB: z.coerce.number().int().min(0).default(1024),
  WEB_DIST: z.string().optional(),
  TRUST_PROXY: trustProxy,
  /** Worker threads for data processing; 0 runs pipelines on the main thread. Default: CPUs - 1, max 4. */
  PIPELINE_WORKERS: z.coerce.number().int().min(0).max(32).optional(),
  /** Hard time limit per pipeline run in a worker. */
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  /** Heap limit of each pipeline worker; a job that needs more fails instead of exhausting the container. */
  PIPELINE_WORKER_MEMORY_MB: z.coerce.number().int().min(16).default(96),
  /** Largest upload, in cells (rows x columns), for dashboards with an owner; also caps HTTP responses. */
  UPLOAD_MAX_CELLS: z.coerce.number().int().min(1000).default(500_000),
  /** Largest upload, in cells, for anonymous dashboards. */
  UPLOAD_MAX_CELLS_ANONYMOUS: z.coerce.number().int().min(1000).default(200_000),
  /** Memory for parsed tables kept between requests (uploads, inline rows, HTTP responses). */
  DATA_CACHE_MB: z.coerce.number().int().min(1).default(32),
  /**
   * The memory the guard measures against (util/memory-pressure.ts), in MB. Default: the container's limit (cgroup);
   * without one the guard is off unless this is set. 0 turns the guard off.
   */
  MEMORY_LIMIT_MB: optional(z.coerce.number().int().min(0)),
  /** Fraction of the limit above which new heavy work (renders, uploads, large pipelines and results) waits. */
  MEMORY_SOFT_FRACTION: z.coerce.number().gt(0).lt(1).default(0.8),
  /** Fraction of the limit above which writes and new live streams wait too. */
  MEMORY_HARD_FRACTION: z.coerce.number().gt(0).max(1).default(0.9),
  /** everyone: any dashboard may load http and feed sources. signed-in: only dashboards with an owner. */
  URL_SOURCES: z.enum(['everyone', 'signed-in']).default('everyone'),
  /** Who may store credentials for HTTP sources. Off unless the operator decides otherwise, see proposal 0003. */
  SECRETS: z.enum(['off', 'admins', 'users']).default('off'),
  /** 32 random bytes, base64. Seals secret values; required unless SECRETS=off. */
  SECRETS_KEY: z.string().optional(),
  /** Comma-separated earlier keys, only while rotating: rows sealed with them are re-sealed at startup. */
  SECRETS_KEY_PREVIOUS: z.string().optional(),
  /** Umami tracker script, e.g. https://umami.example.com/script.js. Analytics are off unless both are set. */
  UMAMI_SCRIPT_URL: optional(
    z.url({ protocol: /^https$/, error: 'UMAMI_SCRIPT_URL must be an https:// URL' }),
  ),
  /** The website ID Umami shows for this site (a UUID). */
  UMAMI_WEBSITE_ID: optional(z.uuid({ error: 'UMAMI_WEBSITE_ID must be the website UUID from Umami' })),
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

/**
 * Analytics are opt-in per deployment: a self-hosted instance sends nothing to any third party unless its operator
 * configures it. Half a configuration is an error rather than a silent no-op, so a typo cannot hide for months.
 */
function analytics(env: { UMAMI_SCRIPT_URL?: string; UMAMI_WEBSITE_ID?: string }) {
  if (!env.UMAMI_SCRIPT_URL && !env.UMAMI_WEBSITE_ID) return null;
  if (!env.UMAMI_SCRIPT_URL || !env.UMAMI_WEBSITE_ID) {
    throw new Error(
      'Umami analytics need both UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID: set both, or neither to turn analytics off',
    );
  }
  const scriptUrl = new URL(env.UMAMI_SCRIPT_URL);
  return {
    scriptUrl: scriptUrl.href,
    origin: scriptUrl.origin,
    websiteId: env.UMAMI_WEBSITE_ID.toLowerCase(),
  };
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
  if (parsed.MEMORY_HARD_FRACTION <= parsed.MEMORY_SOFT_FRACTION) {
    throw new Error('MEMORY_HARD_FRACTION must be larger than MEMORY_SOFT_FRACTION');
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
    pruneBlankAnonymousAfterHours: parsed.PRUNE_BLANK_ANONYMOUS_AFTER_HOURS,
    anonymousStorageBytes: parsed.ANONYMOUS_STORAGE_LIMIT_MB * 1024 * 1024,
    webDist: parsed.WEB_DIST,
    trustProxy: parsed.TRUST_PROXY,
    mcpResource: `${publicUrl}/mcp`,
    pipelineWorkers: parsed.PIPELINE_WORKERS,
    pipelineTimeoutMs: parsed.PIPELINE_TIMEOUT_MS,
    pipelineWorkerMemoryMb: parsed.PIPELINE_WORKER_MEMORY_MB,
    uploadMaxCells: parsed.UPLOAD_MAX_CELLS,
    uploadMaxCellsAnonymous: Math.min(parsed.UPLOAD_MAX_CELLS_ANONYMOUS, parsed.UPLOAD_MAX_CELLS),
    dataCacheBytes: parsed.DATA_CACHE_MB * 1024 * 1024,
    memory: {
      limitMb: parsed.MEMORY_LIMIT_MB,
      soft: parsed.MEMORY_SOFT_FRACTION,
      hard: parsed.MEMORY_HARD_FRACTION,
    },
    urlSources: parsed.URL_SOURCES,
    secrets: { mode: parsed.SECRETS as SecretMode, keyring: secretKeys(parsed) },
    analytics: analytics(parsed),
  };
}
