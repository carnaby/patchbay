import type { DashboardEnvelope } from '@patchbay/core';
import { useMutation } from '@tanstack/react-query';
import { Copy, Download, Globe, Lock, Trash2, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Card, cx, Drawer, Modal, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { forgetEditKey, saveEditKey } from '../lib/edit-keys.ts';
import { useMe } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';

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

  const visibility = useMutation({
    mutationFn: (v: 'public' | 'private') =>
      api<DashboardEnvelope>(`/api/dashboards/${dashboardId}/settings`, {
        method: 'PATCH',
        body: { visibility: v },
        dashboardId,
      }),
    onSuccess: (env) => useEditor.getState().setMeta(env.meta, env.access),
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
    <Drawer open={open} onClose={onClose} title="Share">
      <div className="space-y-5">
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
        </Card>

        {access.isOwner ? (
          <Card className="space-y-3 p-4">
            <div className="text-[13px] font-medium text-ink-2">Visibility</div>
            <div className="grid grid-cols-2 gap-2">
              {(['public', 'private'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => v !== meta.visibility && visibility.mutate(v)}
                  className={cx(
                    'flex items-center gap-2 rounded-xl border p-3 text-left text-sm transition',
                    meta.visibility === v ? 'border-ink bg-surface-2' : 'border-line hover:border-ink-2',
                  )}
                >
                  {v === 'public' ? <Globe className="size-4" /> : <Lock className="size-4" />}
                  <span>
                    <span className="block font-medium capitalize">{v}</span>
                    <span className="text-xs text-muted">
                      {v === 'public' ? 'Anyone with the link' : 'Only you'}
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
