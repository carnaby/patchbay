/**
 * The dialog that stores a secret's value: create a new secret or replace the value of one. Used by Settings and,
 * in place, by the dataset editor. The value is sent once with `api()` directly (not through `useMutation`, whose
 * cache keeps the variables) and the component holding it unmounts when the dialog closes.
 */
import {
  BindingError,
  bindingLabel,
  describePlacement,
  parseBinding,
  type SecretBinding,
  type SecretInfo,
  type SecretPlacement,
  secretParamIssue,
  secretValueIssue,
} from '@patchbay/core';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api.ts';
import { useMe } from '../lib/hooks.ts';
import type { SecretListItem, SecretsList } from '../lib/secrets.ts';
import { Button, Field, Input, Modal, Segmented } from './ui.tsx';

export interface SecretDraft {
  name?: string;
  sendTo?: string;
  placement?: SecretPlacement;
  paramName?: string;
  value?: string;
}

type Target = { kind: 'create'; initial?: SecretDraft } | { kind: 'replace'; secret: SecretListItem };

/** The instance's host as people know it; in production this is the host of PUBLIC_URL. */
const instanceHost = () => window.location.host;

/**
 * The warning shown before a value is saved or replaced. It has to be impossible to miss: storing a credential on
 * someone else's server is a trust decision, not a form field.
 */
export function SecretWarning({ address, isAdmin }: { address: string | null; isAdmin: boolean }) {
  const instance = instanceHost();
  return (
    <div
      role="note"
      aria-label="Before you save this secret"
      className="rounded-xl border-2 border-warn bg-warn/15 p-4 text-[13px] leading-relaxed text-ink"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="size-5 shrink-0 text-warn" aria-hidden="true" />
        Before you save this secret
      </div>
      <p>
        Patchbay will store this value on <strong>{instance}</strong> and send it with every request your
        datasets make to <strong className="break-all">{address ?? 'the address you enter below'}</strong>.
        After saving, nobody can view it in Patchbay: not you, not AI agents, not people who view your
        dashboards.
      </p>
      <p className="mt-2">
        <strong>The operator of {instance} can technically read it.</strong> The value is encrypted, but the
        server has to decrypt it to use it, so whoever runs this server can get to it. Only continue if you
        trust them with this credential.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Use a key with as little access as possible: read-only, limited to the data you want to show, with
          an expiry if the API offers one.
        </li>
        <li>
          If a dashboard that uses this secret is public, anyone with the link sees the data it returns (never
          the secret itself).
        </li>
        <li>
          For sensitive data, run your own Patchbay. It is open source and runs as a single container:{' '}
          <a
            href="https://github.com/carnaby/patchbay"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            github.com/carnaby/patchbay
          </a>
        </li>
      </ul>
      {isAdmin ? (
        <p className="mt-3 border-t border-warn/50 pt-2">
          You administer this instance. The encryption key (<code className="font-mono">SECRETS_KEY</code>)
          must not be stored in the same backup as the data directory, or the backup holds readable secrets.
        </p>
      ) : null}
    </div>
  );
}

const PLACEMENTS: { value: SecretPlacement; label: string }[] = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
  { value: 'query', label: 'Query parameter' },
];

function parsedBinding(input: string): { binding: SecretBinding | null; error: string | null } {
  // The field starts as "https://"; complaining before anything was typed would only be noise.
  if (!input.trim() || input.trim() === 'https://') return { binding: null, error: null };
  try {
    return { binding: parseBinding(input), error: null };
  } catch (e) {
    return { binding: null, error: e instanceof BindingError ? e.message : 'Invalid address' };
  }
}

function SecretForm({
  target,
  onClose,
  onSaved,
}: {
  target: Target;
  onClose: () => void;
  onSaved?: ((info: SecretInfo) => void) | undefined;
}) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const initial = target.kind === 'create' ? (target.initial ?? {}) : {};
  const replacing = target.kind === 'replace' ? target.secret : null;
  const [name, setName] = useState(initial.name ?? '');
  const [sendTo, setSendTo] = useState(initial.sendTo ?? 'https://');
  const [placement, setPlacement] = useState<SecretPlacement>(initial.placement ?? 'bearer');
  const [paramName, setParamName] = useState(initial.paramName ?? '');
  const [value, setValue] = useState(initial.value ?? '');
  const [showValue, setShowValue] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectivePlacement = replacing?.placement ?? placement;
  const parsed = replacing ? { binding: replacing, error: null } : parsedBinding(sendTo);
  const address = parsed.binding ? bindingLabel(parsed.binding) : null;
  const nameIssue = replacing ? null : name.trim().length > 80 ? 'At most 80 characters' : null;
  const paramIssue = replacing
    ? null
    : secretParamIssue(placement, placement === 'bearer' ? null : paramName.trim());
  const valueIssue = value ? secretValueIssue(value.trim(), effectivePlacement) : null;
  const ready =
    understood &&
    !busy &&
    value.trim().length > 0 &&
    !valueIssue &&
    (replacing !== null || (name.trim().length > 0 && !nameIssue && parsed.binding !== null && !paramIssue));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const info = replacing
        ? await api<SecretInfo>(`/api/secrets/${replacing.id}/value`, {
            method: 'PUT',
            body: { value: value.trim() },
          })
        : await api<SecretInfo>('/api/secrets', {
            body: {
              name: name.trim(),
              sendTo: sendTo.trim(),
              placement,
              paramName: placement === 'bearer' ? null : paramName.trim(),
              value: value.trim(),
            },
          });
      // Drop the value from memory as soon as the server has it.
      setValue('');
      // A picker that adds the new secret right away must not see it as missing until the list refetches.
      qc.setQueryData<SecretsList>(['secrets'], (old) =>
        old
          ? {
              ...old,
              secrets: [
                ...old.secrets.filter((s) => s.id !== info.id),
                {
                  ...info,
                  sentAs: describePlacement(info),
                  usedBy: old.secrets.find((s) => s.id === info.id)?.usedBy ?? [],
                },
              ],
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      onSaved?.(info);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={replacing ? `Replace the value of "${replacing.name}"` : 'Add a secret'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
            {replacing ? 'Replace value' : 'Save secret'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SecretWarning address={address} isAdmin={Boolean(me?.isAdmin)} />

        {replacing ? (
          <div className="space-y-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">
            <div>
              <span className="text-muted">Only sent to </span>
              <code className="font-mono break-all text-ink">{bindingLabel(replacing)}</code>
            </div>
            <div>
              <span className="text-muted">Sent as </span>
              <span className="text-ink">{replacing.sentAs}</span>
            </div>
            <p className="text-xs text-muted">
              The address and how the secret is sent cannot change. To send it elsewhere, add a new secret.
            </p>
          </div>
        ) : (
          <>
            <Field label="Name" error={nameIssue}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  maxLength={80}
                  placeholder="e.g. Shop API, read-only"
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Only send to"
              error={parsed.error}
              hint={
                address
                  ? `Sent only to addresses under ${address}`
                  : 'The address the secret may be sent to, e.g. https://api.example.com/v1/. Anything else never receives it.'
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={sendTo}
                  spellCheck={false}
                  placeholder="https://api.example.com/v1/"
                  onChange={(e) => setSendTo(e.target.value)}
                />
              )}
            </Field>
            <div className="space-y-2">
              <div className="text-[13px] font-medium text-ink-2">Send it as</div>
              <Segmented<SecretPlacement> value={placement} onChange={setPlacement} options={PLACEMENTS} />
              {placement === 'bearer' ? (
                <p className="text-xs text-muted">
                  Sent as <code className="font-mono">Authorization: Bearer …</code>
                </p>
              ) : (
                <Field
                  label={placement === 'header' ? 'Header name' : 'Query parameter name'}
                  error={paramName ? paramIssue : null}
                  hint={
                    placement === 'query'
                      ? 'Prefer a header if the API supports one: query parameters end up in the API’s access logs.'
                      : 'e.g. X-API-Key'
                  }
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={paramName}
                      maxLength={64}
                      spellCheck={false}
                      placeholder={placement === 'header' ? 'X-API-Key' : 'api_key'}
                      onChange={(e) => setParamName(e.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
          </>
        )}

        <Field
          label="Value"
          error={valueIssue}
          hint="Paste only the key or token. It is never shown again after saving."
        >
          {(id) => (
            <div className="flex gap-2">
              <Input
                id={id}
                type={showValue ? 'text' : 'password'}
                value={value}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-1p-ignore
                data-lpignore="true"
                className="font-mono"
                onChange={(e) => setValue(e.target.value)}
              />
              <Button
                aria-label={showValue ? 'Hide value' : 'Show value'}
                title={showValue ? 'Hide value' : 'Show value'}
                onClick={() => setShowValue(!showValue)}
                icon={showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              />
            </div>
          )}
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warn/60 bg-warn/5 p-3 text-sm font-medium text-ink">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-current"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I understand that the operator of {instanceHost()} can access this secret.</span>
        </label>

        {error ? <p className="text-sm text-bad">{error}</p> : null}
        {/* Enter in a field submits; the visible buttons live in the modal footer. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Create or replace dialog. The form, and the value it holds, only exist while the dialog is open: closing it
 * unmounts them, so a typed value never survives in component state.
 */
export function SecretModal({
  target,
  onClose,
  onSaved,
}: {
  target: Target | null;
  onClose: () => void;
  onSaved?: (info: SecretInfo) => void;
}) {
  if (!target) return null;
  return <SecretForm target={target} onClose={onClose} onSaved={onSaved} />;
}
