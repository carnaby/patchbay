/**
 * Secrets for HTTP sources: the rules the editor and the server must agree on.
 *
 * A secret is bound to an origin and a path prefix and decides itself how it is sent. The server enforces every
 * rule here at save time and again on every request hop; the editor uses the same functions to explain problems
 * before anything is saved. Nothing in this module ever sees a secret's value except `secretValueIssue`, which
 * validates a value the user is typing and never repeats it in its messages.
 */
import type { DashboardDoc, Source } from './schema.ts';

export const SECRET_PLACEMENTS = ['bearer', 'header', 'query'] as const;
export type SecretPlacement = (typeof SECRET_PLACEMENTS)[number];

/** The instance switch (`SECRETS`): who may store and use secrets. */
export type SecretMode = 'off' | 'admins' | 'users';

export const MAX_SECRETS_PER_SOURCE = 3;
export const MAX_SECRETS_PER_USER = 20;
export const SECRET_VALUE_MIN = 8;
export const SECRET_VALUE_MAX = 4096;

/** Where a secret may be sent: `URL.origin` plus a path prefix that always ends with "/". */
export interface SecretBinding {
  origin: string;
  pathPrefix: string;
}

/** Public metadata of a saved secret. Never contains the value or anything derived from it. */
export interface SecretInfo extends SecretBinding {
  id: string;
  name: string;
  placement: SecretPlacement;
  /** Header or query parameter name; null for bearer. */
  paramName: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

/**
 * Parses the "Only send to" field. The result is what the secret is bound to forever: changing where a value may be
 * sent is the one change that could leak it, so it is not an operation (create a new secret instead).
 */
export function parseBinding(input: string): SecretBinding {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BindingError('Enter a full address, e.g. https://api.example.com/v1/');
  }
  if (url.protocol !== 'https:') throw new BindingError('Secrets are only sent to https:// addresses');
  if (url.username || url.password)
    throw new BindingError('The address must not contain a user name or password');
  // An empty "?" or "#" leaves search/hash empty, so look at the input as well.
  if (url.search || url.hash || /[?#]/.test(raw))
    throw new BindingError('The address must not have a query or fragment');
  // Data sources may only use the default port (see safe-fetch), so a binding with another port could never be used.
  if (url.port) throw new BindingError('Only the default HTTPS port is supported');
  if (hasEncodedSeparator(url.pathname) || hasDotSegmentWithParams(url.pathname)) {
    throw new BindingError('The path must not contain encoded slashes, backslashes or percent signs');
  }
  const pathPrefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (pathPrefix.length > 200) throw new BindingError('The path is too long');
  return { origin: url.origin, pathPrefix };
}

/** The binding as one string, for messages: "https://api.example.com/v1/". */
export function bindingLabel(binding: SecretBinding): string {
  return `${binding.origin}${binding.pathPrefix}`;
}

// Servers may decode %2F, %5C (and, decoding twice, %25) into separators after our comparison.
function hasEncodedSeparator(path: string): boolean {
  return /%2f|%5c|%25/i.test(path);
}

// `..;/` is a dot segment to many Java servers but not to the URL parser.
function hasDotSegmentWithParams(path: string): boolean {
  return path.split('/').some((segment) => {
    if (!segment.includes(';')) return false;
    const head = segment.split(';')[0]!.replace(/%2e/gi, '.');
    return head === '.' || head === '..';
  });
}

export type BindingMismatch = 'origin' | 'path' | 'encoding' | 'param';

/**
 * Whether a request to `url` may carry a secret with this binding. Checked for every request hop, so a redirect
 * cannot take a secret anywhere the user did not allow.
 */
export function bindingMatches(
  binding: SecretBinding & { placement?: SecretPlacement; paramName?: string | null },
  url: string,
): { ok: true } | { ok: false; reason: BindingMismatch } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'origin' };
  }
  // Comparing parsed origins normalises case and IDN; a trailing-dot host differs and therefore fails safe.
  if (u.origin !== binding.origin || u.username || u.password) return { ok: false, reason: 'origin' };
  const path = u.pathname;
  if (binding.pathPrefix !== '/' && (hasEncodedSeparator(path) || hasDotSegmentWithParams(path))) {
    return { ok: false, reason: 'encoding' };
  }
  // The exact path the prefix was made from ("/v1/orders" for "/v1/orders/") is the address the user typed.
  if (!path.startsWith(binding.pathPrefix) && `${path}/` !== binding.pathPrefix) {
    return { ok: false, reason: 'path' };
  }
  if (binding.placement === 'query' && binding.paramName) {
    // A document must not shadow or duplicate the secret's parameter. Servers differ on case, so ignore it.
    const name = binding.paramName.toLowerCase();
    for (const key of u.searchParams.keys())
      if (key.toLowerCase() === name) return { ok: false, reason: 'param' };
  }
  return { ok: true };
}

/** A sentence for a mismatch, naming the secret's address (shown to the owner and their agents only). */
export function bindingMismatchMessage(
  secret: SecretBinding & { name: string; paramName?: string | null },
  reason: BindingMismatch,
): string {
  const where = bindingLabel(secret);
  switch (reason) {
    case 'origin':
    case 'path':
      return `Secret "${secret.name}" is only sent to ${where}. Use a URL under that address or pick another secret.`;
    case 'encoding':
      return `Secret "${secret.name}" is only sent to ${where}; URLs with encoded slashes, backslashes, percent signs or ";" dot segments are refused.`;
    case 'param':
      return `The URL already has a "${secret.paramName}" query parameter, which secret "${secret.name}" adds itself. Remove it from the URL.`;
  }
}

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const QUERY_NAME = /^[A-Za-z0-9_.~-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'content-type',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'accept',
  'user-agent',
]);

/** Checks the header or query parameter name for a placement; returns a message, or null when valid. */
export function secretParamIssue(
  placement: SecretPlacement,
  paramName: string | null | undefined,
): string | null {
  if (placement === 'bearer') return paramName ? 'A bearer token has no parameter name' : null;
  if (!paramName) return placement === 'header' ? 'Enter the header name' : 'Enter the query parameter name';
  if (placement === 'header') {
    if (!HEADER_TOKEN.test(paramName))
      return "Header names are 1-64 characters of letters, digits and !#$%&'*+.^_`|~-";
    const lower = paramName.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('proxy-'))
      return `The header "${paramName}" cannot carry a secret`;
    return null;
  }
  return QUERY_NAME.test(paramName)
    ? null
    : 'Query parameter names are 1-64 characters of A-Z, a-z, 0-9 and _.~-';
}

/**
 * Validates a secret value (already trimmed). Messages never repeat the value. Values sent in a header must be
 * printable ASCII: anything else would either be rejected by the HTTP client or mangled on the way.
 */
export function secretValueIssue(value: string, placement: SecretPlacement): string | null {
  if (value.length < SECRET_VALUE_MIN) return `The value must be at least ${SECRET_VALUE_MIN} characters`;
  if (value.length > SECRET_VALUE_MAX) return `The value must be at most ${SECRET_VALUE_MAX} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(value))
    return 'The value must not contain control characters or line breaks';
  if (placement === 'bearer' && /^bearer\s/i.test(value)) return 'Paste only the token, without "Bearer"';
  if (placement !== 'query' && !/^[\x20-\x7e]+$/.test(value)) {
    return 'Values sent in a header must be plain ASCII characters';
  }
  return null;
}

/** How a secret is sent, for lists: "Authorization: Bearer", "Header X-API-Key", "Query parameter api_key". */
export function describePlacement(secret: { placement: SecretPlacement; paramName: string | null }): string {
  if (secret.placement === 'bearer') return 'Authorization: Bearer';
  if (secret.placement === 'header') return `Header ${secret.paramName}`;
  return `Query parameter ${secret.paramName}`;
}

/** Two secrets on one source must not write the same header or query parameter. Returns a message or null. */
export function placementConflict(
  secrets: { name: string; placement: SecretPlacement; paramName: string | null }[],
): string | null {
  const seen = new Map<string, string>();
  for (const s of secrets) {
    const slot =
      s.placement === 'query'
        ? `query:${s.paramName?.toLowerCase()}`
        : `header:${s.placement === 'bearer' ? 'authorization' : s.paramName?.toLowerCase()}`;
    const other = seen.get(slot);
    if (other) return `Secrets "${other}" and "${s.name}" would both set ${describePlacement(s)}`;
    seen.set(slot, s.name);
  }
  return null;
}

/** Secret ids a source references (only HTTP sources can). */
export function sourceSecretIds(source: Source): string[] {
  return source.kind === 'http' ? (source.secrets ?? []) : [];
}

/** Every secret id a document references, once. */
export function docSecretIds(doc: DashboardDoc): string[] {
  return [...new Set(doc.datasets.flatMap((d) => sourceSecretIds(d.source)))];
}

/**
 * Ids of datasets in `next` that introduce or retarget a secret reference: new datasets with secrets, datasets that
 * gained a secret, and datasets with secrets whose URL changed. Removing a secret, or leaving references alone, is
 * not a change: those are never re-checked, so deleting a secret never blocks unrelated edits.
 */
export function secretRefChanges(prev: DashboardDoc, next: DashboardDoc): string[] {
  const before = new Map(prev.datasets.map((d) => [d.id, d.source]));
  return next.datasets.flatMap((d) => {
    const ids = sourceSecretIds(d.source);
    if (ids.length === 0) return [];
    const old = before.get(d.id);
    if (old?.kind !== 'http' || d.source.kind !== 'http' || old.url !== d.source.url) return [d.id];
    const had = new Set(sourceSecretIds(old));
    return ids.some((id) => !had.has(id)) ? [d.id] : [];
  });
}

const CREDENTIAL_PARAMS = new Set([
  'key',
  'apikey',
  'token',
  'accesstoken',
  'secret',
  'password',
  'auth',
  'signature',
]);

/** Query parameters of `url` that look like credentials ("api_key", "access-token", …), for a warning. */
export function credentialLikeParams(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const names = [...new Set(u.searchParams.keys())];
  return names.filter((n) => CREDENTIAL_PARAMS.has(n.toLowerCase().replace(/[-_]/g, '')));
}
