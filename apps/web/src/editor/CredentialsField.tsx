/**
 * Credentials of an HTTP source: the owner picks saved secrets by id; the document never holds a value. Problems
 * are explained while typing with the same rules the server applies (core's binding matcher and placement check).
 */
import {
  bindingLabel,
  bindingMatches,
  credentialLikeParams,
  MAX_SECRETS_PER_SOURCE,
  type SecretInfo,
  type Source,
  sourceSecretIds,
} from '@patchbay/core';
import { AlertTriangle, KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import { type SecretDraft, SecretModal } from '../components/SecretModal.tsx';
import { Field, IconButton, Select } from '../components/ui.tsx';
import { useSecrets, useSecretsStatus } from '../lib/hooks.ts';
import {
  type CredentialIssue,
  credentialIssues,
  extractQueryParam,
  type SecretListItem,
  suggestedSendTo,
} from '../lib/secrets.ts';
import { useEditor } from '../state/editor.ts';

type HttpSource = Extract<Source, { kind: 'http' }>;

const NEW_SECRET = '__new__';

export interface CredentialContext {
  /** The instance switch from /api/me. */
  mode: 'off' | 'admins' | 'users';
  /** Owner of a dashboard that may use secrets right now. */
  canUseSecrets: boolean;
  /** Anonymous dashboards can never hold references. */
  anonymous: boolean;
  owner: boolean;
  /** The owner's secrets; null while loading or when not the owner. */
  secrets: SecretListItem[] | null;
}

export function useCredentialContext(): CredentialContext {
  const access = useEditor((s) => s.access);
  const { data: status } = useSecretsStatus();
  const owner = Boolean(access?.isOwner);
  const list = useSecrets(owner);
  return {
    mode: status?.mode ?? 'off',
    canUseSecrets: owner && Boolean(status?.canUseSecrets),
    anonymous: Boolean(access?.anonymous),
    owner,
    secrets: list.data?.secrets ?? null,
  };
}

/** Issues for the owner; empty while the list is loading (the server still checks on save and use). */
export function issuesFor(source: Source, context: CredentialContext): CredentialIssue[] {
  if (!context.owner || context.secrets === null) return [];
  return credentialIssues(source, {
    secrets: context.secrets,
    mode: context.mode,
    canUseSecrets: context.canUseSecrets,
  });
}

function withSecrets(source: HttpSource, ids: string[]): HttpSource {
  const { secrets: _old, ...rest } = source;
  return ids.length ? { ...rest, secrets: ids } : rest;
}

function mismatchLabel(secret: SecretListItem, url: string): string {
  const match = bindingMatches(secret, url);
  if (match.ok) return '';
  if (match.reason === 'param') return `the URL already has a "${secret.paramName}" parameter`;
  if (match.reason === 'encoding') return 'refuses encoded characters in this URL';
  return `only sent to ${bindingLabel(secret)}`;
}

/** The hint under the URL field. */
export function urlHint(context: CredentialContext) {
  return context.canUseSecrets
    ? 'Don’t put keys into the URL; use Credentials instead. Private network addresses are blocked.'
    : 'A public JSON endpoint without credentials. Private network addresses are blocked.';
}

/** Warns about keys pasted into the URL and offers to move one into a secret. */
export function UrlKeyWarning({
  source,
  context,
  onChange,
}: {
  source: HttpSource;
  context: CredentialContext;
  onChange: (s: HttpSource) => void;
}) {
  const [draft, setDraft] = useState<{ param: string; secret: SecretDraft; url: string } | null>(null);
  const params = credentialLikeParams(source.url);
  if (params.length === 0) return null;
  const ids = sourceSecretIds(source);
  const canMove = context.canUseSecrets && ids.length < MAX_SECRETS_PER_SOURCE;
  const host = (() => {
    try {
      return new URL(source.url).host;
    } catch {
      return 'API';
    }
  })();
  return (
    <div className="space-y-2 rounded-lg border border-warn/60 bg-warn/10 p-3 text-[13px] text-ink">
      {params.map((param) => {
        const extracted = extractQueryParam(source.url, param);
        return (
          <div key={param} className="flex flex-wrap items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              The URL contains <code className="font-mono">{param}</code>, which looks like a key. Everyone
              who can view this dashboard, and every AI agent working on it, can read the URL and its saved
              versions.
            </span>
            {canMove && extracted ? (
              <button
                type="button"
                className="shrink-0 font-medium underline"
                onClick={() =>
                  setDraft({
                    param,
                    url: extracted.url,
                    secret: {
                      name: `${host} ${param}`.slice(0, 80),
                      sendTo: suggestedSendTo(source.url),
                      placement: 'query',
                      paramName: param,
                      value: extracted.value,
                    },
                  })
                }
              >
                Move it into a secret
              </button>
            ) : null}
          </div>
        );
      })}
      {canMove ? (
        <p className="text-xs text-ink-2">
          If this dashboard was ever public, also revoke the key where it was issued: earlier versions still
          hold it.
        </p>
      ) : null}
      <SecretModal
        target={draft ? { kind: 'create', initial: draft.secret } : null}
        onClose={() => setDraft(null)}
        onSaved={(info: SecretInfo) => {
          if (!draft) return;
          // The secret now adds the parameter itself, so it must leave the URL (a duplicate would be refused).
          onChange(withSecrets({ ...source, url: draft.url }, [...ids, info.id]));
        }}
      />
    </div>
  );
}

export function CredentialsField({
  source,
  context,
  onChange,
}: {
  source: HttpSource;
  context: CredentialContext;
  onChange: (s: HttpSource) => void;
}) {
  const [creating, setCreating] = useState<SecretDraft | null>(null);
  const ids = sourceSecretIds(source);
  const settingsLink = (
    <a href="/settings#secrets" target="_blank" rel="noreferrer" className="underline">
      Settings → Secrets
    </a>
  );

  if (ids.length === 0 && (context.mode === 'off' || (!context.owner && !context.anonymous))) return null;

  if (context.anonymous) {
    return (
      <Field label="Credentials" hint="Sign in and claim this dashboard to use secrets.">
        {(fid) => (
          <Select id={fid} disabled value="">
            <option value="">None (public endpoint)</option>
          </Select>
        )}
      </Field>
    );
  }

  if (!context.canUseSecrets && ids.length === 0) {
    return (
      <p className="text-xs text-muted">
        {context.mode === 'admins'
          ? 'Credentials: this instance only lets administrators use secrets.'
          : 'Credentials are turned off on this server.'}
      </p>
    );
  }

  const secrets = context.secrets ?? [];
  const issues = issuesFor(source, context);
  const sourceIssues = issues.filter((i) => !i.secretId);
  const candidates = secrets.filter((s) => !ids.includes(s.id));
  const usable = candidates.filter((s) => bindingMatches(s, source.url).ok);
  const elsewhere = candidates.filter((s) => !bindingMatches(s, source.url).ok);
  const canAdd = context.canUseSecrets && ids.length < MAX_SECRETS_PER_SOURCE;

  return (
    <div className="space-y-2">
      <div className="text-[13px] font-medium text-ink-2">Credentials</div>
      {ids.map((id) => {
        const secret = secrets.find((s) => s.id === id);
        const own = issues.filter((i) => i.secretId === id);
        return (
          <div
            key={id}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${
              own.length ? 'border-bad/50 bg-bad/5' : 'border-line bg-surface'
            }`}
          >
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              {secret ? (
                <>
                  <div className="font-medium">{secret.name}</div>
                  <div className="text-xs text-muted">
                    Sent as {secret.sentAs} · only sent to{' '}
                    <span className="font-mono break-all">{bindingLabel(secret)}</span>
                  </div>
                </>
              ) : (
                <div className="font-medium">{context.secrets === null ? 'Loading…' : 'Missing secret'}</div>
              )}
              {own.map((i) => (
                <p key={i.message} className="mt-1 text-xs text-bad">
                  {i.message}
                </p>
              ))}
            </div>
            <IconButton
              label="Remove this credential"
              onClick={() =>
                onChange(
                  withSecrets(
                    source,
                    ids.filter((x) => x !== id),
                  ),
                )
              }
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
        );
      })}

      {canAdd ? (
        <Select
          aria-label={ids.length ? 'Add another secret' : 'Credentials'}
          value=""
          onChange={(e) => {
            const value = e.target.value;
            if (value === NEW_SECRET) setCreating({ sendTo: suggestedSendTo(source.url) });
            else if (value) onChange(withSecrets(source, [...ids, value]));
          }}
        >
          <option value="">{ids.length ? 'Add another secret…' : 'None (public endpoint)'}</option>
          {usable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.sentAs}
            </option>
          ))}
          {elsewhere.length ? (
            <optgroup label="Bound to other addresses">
              {elsewhere.map((s) => (
                <option key={s.id} value={s.id} disabled>
                  {s.name}: {mismatchLabel(s, source.url)}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value={NEW_SECRET}>Add a secret…</option>
        </Select>
      ) : null}

      {sourceIssues.map((i) => (
        <p key={i.message} className="flex items-start gap-1.5 text-xs text-bad">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {i.message}
        </p>
      ))}
      <p className="text-xs text-muted">
        The server sends them with every request, only to the address each secret is bound to. Values are
        never shown; manage them in {settingsLink}.
      </p>

      <SecretModal
        target={creating ? { kind: 'create', initial: creating } : null}
        onClose={() => setCreating(null)}
        onSaved={(info) => {
          if (bindingMatches(info, source.url).ok) onChange(withSecrets(source, [...ids, info.id]));
        }}
      />
    </div>
  );
}
