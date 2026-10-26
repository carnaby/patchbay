/**
 * Web-side rules for secrets: when to ask before data fetched with secrets becomes public, and how to explain
 * credential problems to the owner. Pure functions without React or browser APIs, so they are unit-tested; the
 * rules themselves (binding, placement, what counts as a new reference) come from core, shared with the server.
 */
import {
  bindingMatches,
  bindingMismatchMessage,
  CONFIRM_PUBLIC_SECRETS,
  CREDENTIAL_ERRORS,
  type DashboardDoc,
  placementConflict,
  type SecretInfo,
  type SecretMode,
  type Source,
  secretRefChanges,
  sourceSecretIds,
} from '@patchbay/core';

/** A row of `GET /api/secrets`. */
export interface SecretListItem extends SecretInfo {
  /** "Authorization: Bearer", "Header X-API-Key", "Query parameter api_key". */
  sentAs: string;
  usedBy?: { dashboardId: string; dashboardTitle: string; datasetId: string; datasetName: string }[];
}

export interface SecretsList {
  mode: SecretMode;
  canUseSecrets: boolean;
  secrets: SecretListItem[];
}

/** A secret named in the server's 428 answer; the name is null when the secret no longer exists. */
export interface PublicSecretRef {
  id: string;
  name: string | null;
}

/**
 * The secrets a `428 confirm_public_secrets` answer asks about, or null for any other error. Duck-typed on
 * `status` and `body` so it works for `ApiError` without importing the fetch wrapper.
 */
export function publicSecretsRequest(error: unknown): PublicSecretRef[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 428 || typeof body !== 'object' || body === null) return null;
  const { code, secrets } = body as { code?: unknown; secrets?: unknown };
  if (code !== CONFIRM_PUBLIC_SECRETS) return null;
  if (!Array.isArray(secrets)) return [];
  return secrets
    .filter((s): s is { id: string; name?: unknown } => typeof s?.id === 'string')
    .map((s) => ({ id: s.id, name: typeof s.name === 'string' ? s.name : null }));
}

/**
 * Fingerprints of the secret references `next` introduces or retargets compared with `prev` (the server's rule,
 * `secretRefChanges`): one per dataset, made of its id, URL and secret ids. A confirmation covers exactly these, so
 * pointing a confirmed secret at another URL later asks again, as the server does.
 */
export function introducedSecretRefs(prev: DashboardDoc, next: DashboardDoc): string[] {
  const changed = new Set(secretRefChanges(prev, next));
  return next.datasets
    .filter((d) => changed.has(d.id) && d.source.kind === 'http')
    .map((d) => `${d.id} ${(d.source as { url: string }).url} ${sourceSecretIds(d.source).join(',')}`);
}

/** The secret ids behind `introducedSecretRefs`, once each, to name them in the confirmation. */
export function introducedSecretIds(prev: DashboardDoc, next: DashboardDoc): string[] {
  const changed = new Set(secretRefChanges(prev, next));
  return [
    ...new Set(next.datasets.filter((d) => changed.has(d.id)).flatMap((d) => sourceSecretIds(d.source))),
  ];
}

/**
 * Whether a save from `prev` to `next` may carry `confirmPublicSecrets: true`: only when it introduces references
 * and the user confirmed every one of them. Anything unconfirmed is sent without the flag, so the server answers
 * 428 and the user is asked; the flag is never sent on the user's behalf for something they did not see.
 */
export function confirmedForSave(
  prev: DashboardDoc,
  next: DashboardDoc,
  confirmed: readonly string[],
): boolean {
  const refs = introducedSecretRefs(prev, next);
  return refs.length > 0 && refs.every((r) => confirmed.includes(r));
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Display names for secrets the server named, falling back to the id for one that was deleted. */
export function secretRefNames(refs: PublicSecretRef[]): string[] {
  return refs.map((r) => r.name ?? `a deleted secret (${r.id})`);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'this address';
  }
};

export interface CredentialIssue {
  /** The secret the issue is about; absent for issues of the whole source. */
  secretId?: string;
  message: string;
}

/**
 * Problems with the credentials of an HTTP source, explained for its owner while typing (before any preview
 * request). The server checks the same rules on save and again on every request.
 */
export function credentialIssues(
  source: Source,
  context: { secrets: SecretListItem[]; mode: SecretMode; canUseSecrets: boolean },
): CredentialIssue[] {
  const ids = sourceSecretIds(source);
  if (ids.length === 0 || source.kind !== 'http') return [];
  if (!context.canUseSecrets) {
    const why =
      context.mode === 'admins'
        ? 'This instance only lets administrators use secrets.'
        : CREDENTIAL_ERRORS.off;
    return [
      {
        message: `${why} Your secrets are kept; ask the operator, or remove the credentials to load the URL without them.`,
      },
    ];
  }
  const issues: CredentialIssue[] = [];
  const found: SecretListItem[] = [];
  for (const id of ids) {
    const secret = context.secrets.find((s) => s.id === id);
    if (!secret) {
      issues.push({
        secretId: id,
        message: `The secret this dataset used no longer exists. Pick one of your secrets for ${hostOf(source.url)}.`,
      });
      continue;
    }
    found.push(secret);
    const match = bindingMatches(secret, source.url);
    if (!match.ok) issues.push({ secretId: id, message: bindingMismatchMessage(secret, match.reason) });
  }
  const conflict = placementConflict(found);
  if (conflict) issues.push({ message: conflict });
  return issues;
}

/**
 * Detail for the owner next to a dataset error. Viewers only ever see the server's generic message; the owner
 * gets told what to do about it.
 */
export function credentialErrorHint(
  error: string,
  context: { hasSecrets: boolean; canAddSecrets: boolean },
): string | null {
  switch (error) {
    case CREDENTIAL_ERRORS.unavailable:
      return 'The secret this dataset uses no longer exists. Open the dataset and pick one of your secrets.';
    case CREDENTIAL_ERRORS.bound:
      return 'The URL is outside the address the secret is bound to. Open the dataset to change the URL back or pick another secret.';
    case CREDENTIAL_ERRORS.off:
      return 'Your secrets are kept; ask the operator, or remove the credentials to load the URL without them.';
    case CREDENTIAL_ERRORS.undecryptable:
      return 'Replace the value under Settings → Secrets to store it again.';
    case CREDENTIAL_ERRORS.conflict:
      return 'Two secrets on this dataset set the same header or parameter. Remove one.';
  }
  if (/^Upstream responded 40[13]\b/.test(error)) {
    if (context.hasSecrets)
      return 'The API rejected the credential. Check it is still valid, then replace the value under Settings → Secrets.';
    return context.canAddSecrets ? 'This API probably needs a secret. Add one under Credentials.' : null;
  }
  return null;
}

/** What the Settings page shows for secrets, from the instance switch and what the user already stored. */
export type SecretsSectionMode = 'hidden' | 'manage' | 'cleanup';

export function secretsSectionMode(
  list: Pick<SecretsList, 'mode' | 'canUseSecrets' | 'secrets'>,
): SecretsSectionMode {
  if (list.canUseSecrets) return 'manage';
  // Users can always see and delete what they stored; with nothing stored and the switch off there is nothing to say.
  if (list.mode === 'off' && list.secrets.length === 0) return 'hidden';
  return 'cleanup';
}

/** The "Only send to" suggestion for a URL: its origin, so the secret works for every path of that API. */
export function suggestedSendTo(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? `${u.origin}/` : '';
  } catch {
    return '';
  }
}

/**
 * Takes a credential-like query parameter out of a URL, for "Move it into a secret". Returns the URL without it
 * and the value, or null when the parameter is absent or empty.
 */
export function extractQueryParam(url: string, name: string): { url: string; value: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const value = u.searchParams.get(name);
  if (!value) return null;
  u.searchParams.delete(name);
  return { url: u.toString(), value };
}
