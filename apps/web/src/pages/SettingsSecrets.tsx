/** Settings → Secrets: credentials for HTTP data sources. Values go in once and are never shown again. */
import { bindingLabel, MAX_SECRETS_PER_USER } from '@patchbay/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { SecretModal } from '../components/SecretModal.tsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  toast,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { relativeTime } from '../lib/hooks.ts';
import { type SecretListItem, type SecretsList, secretsSectionMode } from '../lib/secrets.ts';

function UsedBy({ usedBy }: { usedBy: NonNullable<SecretListItem['usedBy']> }) {
  if (usedBy.length === 0) return <span className="text-muted">no dataset yet</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {usedBy.map((u) => (
        <Link
          key={`${u.dashboardId}/${u.datasetId}`}
          to={`/d/${u.dashboardId}`}
          className="text-ink hover:underline"
          title={`${u.dashboardTitle} → ${u.datasetName}`}
        >
          {u.dashboardTitle} → {u.datasetName}
        </Link>
      ))}
    </span>
  );
}

function SecretRow({
  secret,
  canChange,
  onRename,
  onReplace,
  onDelete,
}: {
  secret: SecretListItem;
  canChange: boolean;
  onRename: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex gap-3 px-4 py-3 text-sm">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{secret.name}</span>
          <Badge>{secret.sentAs}</Badge>
        </div>
        <div className="text-xs text-ink-2">
          Only sent to <code className="font-mono break-all text-ink">{bindingLabel(secret)}</code>
        </div>
        <div className="flex gap-1 text-xs text-ink-2">
          <span className="shrink-0 text-muted">Used by</span>
          <UsedBy usedBy={secret.usedBy ?? []} />
        </div>
        <div className="text-xs text-muted">
          {secret.lastUsedAt ? `Last used ${relativeTime(secret.lastUsedAt)}` : 'Never used'} · Updated{' '}
          {relativeTime(secret.updatedAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        {canChange ? (
          <>
            <IconButton label={`Rename ${secret.name}`} onClick={onRename}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton label={`Replace the value of ${secret.name}`} onClick={onReplace}>
              <RefreshCw className="size-4" />
            </IconButton>
          </>
        ) : null}
        <IconButton label={`Delete ${secret.name}`} onClick={onDelete} className="hover:text-bad">
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

function RenameModal({ secret, onClose }: { secret: SecretListItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(secret?.name ?? '');
  const rename = useMutation({
    mutationFn: () => api(`/api/secrets/${secret!.id}`, { method: 'PATCH', body: { name: name.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      onClose();
    },
  });
  return (
    <Modal
      open={secret !== null}
      title="Rename secret"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || name.trim().length > 80}
            loading={rename.isPending}
            onClick={() => rename.mutate()}
          >
            Rename
          </Button>
        </>
      }
    >
      <Field label="Name" error={rename.error ? errorMessage(rename.error) : null}>
        {(id) => (
          <Input
            id={id}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && rename.mutate()}
          />
        )}
      </Field>
      <p className="mt-2 text-xs text-muted">Datasets refer to the secret by its id, so they keep working.</p>
    </Modal>
  );
}

function DeleteModal({ secret, onClose }: { secret: SecretListItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      toast('Secret deleted');
      onClose();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const usedBy = secret?.usedBy ?? [];
  return (
    <Modal
      open={secret !== null}
      title={`Delete "${secret?.name}"?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => secret && remove.mutate(secret.id)}
          >
            Delete secret
          </Button>
        </>
      }
    >
      {usedBy.length ? (
        <>
          <p>These datasets use it and will stop loading:</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {usedBy.map((u) => (
              <li key={`${u.dashboardId}/${u.datasetId}`}>
                {u.dashboardTitle} → {u.datasetName}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>No dataset uses it.</p>
      )}
      <p className="mt-3">
        The value is removed from this server. If it may have leaked, also revoke it where it was issued.
      </p>
    </Modal>
  );
}

/** Explains why secrets cannot be added here, while still allowing users to clean up what they stored. */
function SwitchNotice({ list }: { list: SecretsList }) {
  return (
    <div className="mb-4 flex gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {list.mode === 'admins'
          ? 'This instance only lets administrators store secrets.'
          : 'Secrets are turned off on this server.'}{' '}
        {list.secrets.length
          ? 'The secrets you saved are kept but not used. You can delete them.'
          : 'Datasets can only load public endpoints.'}
      </span>
    </div>
  );
}

export function SecretsManager({ list }: { list: SecretsList }) {
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<SecretListItem | null>(null);
  const [renaming, setRenaming] = useState<SecretListItem | null>(null);
  const [deleting, setDeleting] = useState<SecretListItem | null>(null);
  const manage = secretsSectionMode(list) === 'manage';
  const full = list.secrets.length >= MAX_SECRETS_PER_USER;

  return (
    <>
      {manage ? null : <SwitchNotice list={list} />}
      {list.secrets.length ? (
        <Card className="divide-y divide-line">
          {list.secrets.map((s) => (
            <SecretRow
              key={s.id}
              secret={s}
              canChange={manage}
              onRename={() => setRenaming(s)}
              onReplace={() => setReplacing(s)}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </Card>
      ) : manage ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="No secrets yet">
          Add an API key or token, then pick it under Credentials in a JSON URL dataset. It is only ever sent
          to the address you allow.
        </EmptyState>
      ) : null}
      {manage ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            disabled={full}
            onClick={() => setAdding(true)}
          >
            Add a secret
          </Button>
          {full ? (
            <span className="text-xs text-muted">
              You can store up to {MAX_SECRETS_PER_USER} secrets. Delete one you no longer use first.
            </span>
          ) : null}
        </div>
      ) : null}

      <SecretModal target={adding ? { kind: 'create' } : null} onClose={() => setAdding(false)} />
      <SecretModal
        target={replacing ? { kind: 'replace', secret: replacing } : null}
        onClose={() => setReplacing(null)}
        onSaved={() => toast('Value replaced')}
      />
      <RenameModal key={renaming?.id ?? 'none'} secret={renaming} onClose={() => setRenaming(null)} />
      <DeleteModal secret={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
