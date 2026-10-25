import { z } from 'zod';

const bool = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

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
  TRUST_PROXY: bool,
  /** Worker threads for data processing; 0 runs pipelines on the main thread. Default: CPUs - 1, max 4. */
  PIPELINE_WORKERS: z.coerce.number().int().min(0).max(32).optional(),
  /** Hard time limit per pipeline run in a worker. */
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});

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
  };
}
