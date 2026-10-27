import { type DashboardEnvelope, docSecretIds } from '@patchbay/core';
import { useMutation } from '@tanstack/react-query';
import { Copy, Download, Globe, KeyRound, Lock, Trash2, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Card, cx, Drawer, Modal, Spinner, toast } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { forgetEditKey, saveEditKey } from '../lib/edit-keys.ts';
import { useMe } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';
import { DetailsCard } from './DetailsFields.tsx';
import { EntityColorsCard } from './FormattingFields.tsx';
import { withPublicSecretsConfirmation } from './public-secrets.tsx';

export function SharePanel({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
}) {
  const meta = useEditor((s) => s.meta)!;
  const access = useEditor((s) => s.access)!;
  const title = useEditor((s) => s.doc?.title ?? '');
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const url = `${window.location.origin}/d/${dashboardId}`;

  const secretCount = useEditor((s) => (s.saved ? docSecretIds(s.saved).length : 0));
  const visibility = useMutation({
    mutationFn: (v: 'public' | 'private') =>
      withPublicSecretsConfirmation('publish', (confirm) =>
        api<DashboardEnvelope>(`/api/dashboards/${dashboardId}/settings`, {
          method: 'PATCH',
          body: confirm ? { visibility: v, confirmPublicSecrets: true } : { visibility: v },
          dashboardId,
        }),
      ),
    onSuccess: (env) => {
      if (env) useEditor.getState().setMeta(env.meta, env.access);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const claim = useMutation({
    mutationFn: () =>
      api<DashboardEnvelope>(`/api/dashboards/${dashboardId}/claim`, { body: {}, dashboardId }),
    onSuccess: (env) => {
      forgetEditKey(dashboardId);
      useEditor.getState().setMeta(env.meta, env.access);
      toast('The dashboard is now yours. You can make it private.');
    },
  });
  const duplicate = useMutation({
    mutationFn: () =>
      api<{ envelope: DashboardEnvelope; editKey?: string }>(`/api/dashboards/${dashboardId}/duplicate`, {
        body: {},
        dashboardId,
      }),
    onSuccess: (res) => {
      if (res.editKey) saveEditKey(res.envelope.meta.id, res.editKey, res.envelope.doc.title);
      onClose();
      navigate(`/d/${res.envelope.meta.id}`);
      toast('Copied. This is your own copy.');
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/dashboards/${dashboardId}`, { method: 'DELETE', dashboardId }),
    onSuccess: () => {
      forgetEditKey(dashboardId);
      navigate(me ? '/me' : '/');
      toast('Dashboard deleted');
    },
  });

  return (
    <Drawer open={open} onClose={onClose} title="Details and sharing">
      <div className="space-y-5">
        {/* The toolbar's title opens this panel, so renaming is the first thing in it. */}
        <DetailsCard />
        {access.isOwner ? (
          // Right after the name: "how do I make it public" is the question most people open it with.
          <Card className="space-y-3 p-4">
            <div className="text-[13px] font-medium text-ink-2">Who can open this dashboard</div>
            <div className="grid grid-cols-2 gap-2">
              {(['private', 'public'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={meta.visibility === v}
                  disabled={visibility.isPending}
                  onClick={() => v !== meta.visibility && visibility.mutate(v)}
                  className={cx(
                    'flex min-h-14 items-center gap-2 rounded-xl border p-3 text-left text-sm transition disabled:opacity-60',
                    meta.visibility === v ? 'border-ink bg-surface-2' : 'border-line hover:border-ink-2',
                  )}
                >
                  {visibility.isPending && visibility.variables === v ? (
                    <Spinner className="shrink-0" />
                  ) : v === 'public' ? (
                    <Globe className="size-4 shrink-0" />
                  ) : (
                    <Lock className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block font-medium capitalize">{v}</span>
                    <span className="text-xs text-muted">
                      {v === 'public' ? 'Anyone with the link can view' : 'Only you, signed in'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </Card>
        ) : access.anonymous ? (
          <Card className="space-y-3 p-4">
            <div className="text-[13px] font-medium text-ink-2">Created without an account</div>
            <p className="text-sm text-ink-2">
              Anonymous dashboards are always public
              {access.canEdit ? ', and this browser holds the key that lets you edit it' : ''}. Sign in and
              claim it to own it, make it private and edit it from any device or AI agent.
            </p>
            {access.canEdit ? (
              me ? (
                <Button
                  variant="primary"
                  icon={<UserCheck className="size-4" />}
                  loading={claim.isPending}
                  onClick={() => claim.mutate()}
                >
                  Claim as {me.email}
                </Button>
              ) : (
                <Link to={`/login?returnTo=/d/${dashboardId}`}>
                  <Button variant="primary">Sign in to claim</Button>
                </Link>
              )
            ) : null}
          </Card>
        ) : null}

        <Card className="space-y-3 p-4">
          <div className="text-[13px] font-medium text-ink-2">Link</div>
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs"
              onFocus={(e) => e.target.select()}
            />
            <Button
              icon={<Copy className="size-4" />}
              onClick={() => {
                void navigator.clipboard.writeText(url);
                toast('Link copied');
              }}
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted">
            {meta.visibility === 'public'
              ? 'Anyone with the link can view. Only editors can change it.'
              : 'Only you can open it, after signing in.'}
          </p>
          {meta.visibility === 'public' && secretCount > 0 ? (
            <p className="flex items-center gap-1.5 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs text-ink">
              <KeyRound className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
              Public · shows data fetched with {secretCount} secret{secretCount === 1 ? '' : 's'}
            </p>
          ) : null}
        </Card>

        <EntityColorsCard />

        <Card className="space-y-2 p-4">
          <div className="text-[13px] font-medium text-ink-2">More</div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => duplicate.mutate()}
              loading={duplicate.isPending}
              icon={<Copy className="size-4" />}
            >
              Make a copy
            </Button>
            <a href={`/api/dashboards/${dashboardId}/snapshot.png`} target="_blank" rel="noreferrer">
              <Button icon={<Download className="size-4" />}>PNG snapshot</Button>
            </a>
            {access.isOwner || (access.anonymous && access.canEdit) || me?.isAdmin ? (
              <Button
                variant="danger"
                icon={<Trash2 className="size-4" />}
                onClick={() => setConfirmDelete(true)}
                disabled={access.anonymous && !me?.isAdmin}
              >
                Delete
              </Button>
            ) : null}
          </div>
          {access.anonymous && access.canEdit ? (
            <p className="text-xs text-muted">
              Anonymous dashboards are deleted by the admin when unused; claim it to delete it yourself.
            </p>
          ) : null}
        </Card>
      </div>
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${title}"?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete forever
            </Button>
          </>
        }
      >
        The dashboard folder, its uploaded files and its version history are removed. This cannot be undone.
      </Modal>
    </Drawer>
  );
}
