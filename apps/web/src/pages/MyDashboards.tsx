import type { DashboardMeta } from '@patchbay/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, LayoutGrid, Lock, MonitorSmartphone, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import { Badge, Button, Card, EmptyState, IconButton, Modal, Spinner, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { forgetEditKey, listEditKeys } from '../lib/edit-keys.ts';
import { relativeTime, useDocumentTitle, useMe } from '../lib/hooks.ts';
import { PageHeader } from './_shared.tsx';

function DashboardCard({ d, onDelete }: { d: DashboardMeta; onDelete: () => void }) {
  return (
    <Card className="group relative flex flex-col p-5 transition hover:border-line-strong">
      <Link to={`/d/${d.id}`} className="absolute inset-0 rounded-xl" aria-label={`Open ${d.title}`} />
      <div className="flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 font-semibold">{d.title}</h3>
        <IconButton
          label={`Delete ${d.title}`}
          onClick={onDelete}
          className="relative z-10 -mt-1 -mr-2 opacity-60 group-hover:opacity-100 hover:text-bad"
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-6 text-xs text-muted">
        {d.visibility === 'private' ? (
          <Badge>
            <Lock className="size-3" /> Private
          </Badge>
        ) : (
          <Badge tone="data">
            <Globe className="size-3" /> Public
          </Badge>
        )}
        <span>Updated {relativeTime(d.updatedAt)}</span>
      </div>
    </Card>
  );
}

function DeviceDashboards() {
  const qc = useQueryClient();
  const { data: user } = useMe();
  const [entries, setEntries] = useState(listEditKeys);
  const claim = useMutation({
    mutationFn: (id: string) => api(`/api/dashboards/${id}/claim`, { body: {}, dashboardId: id }),
    onSuccess: (_r, id) => {
      forgetEditKey(id);
      setEntries(listEditKeys());
      void qc.invalidateQueries({ queryKey: ['my-dashboards'] });
      toast('Dashboard is now yours. You can make it private.', 'good');
    },
  });
  if (entries.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <MonitorSmartphone className="size-5 text-muted" /> On this device
      </h2>
      <p className="mb-4 text-sm text-ink-2">
        Dashboards you created without signing in. This browser holds their edit keys.
        {user ? ' Claim them to own them on every device.' : ' Sign in to claim them.'}
      </p>
      <Card className="divide-y divide-line">
        {entries.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Link to={`/d/${e.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
              {e.title}
            </Link>
            <span className="text-xs text-muted">created {relativeTime(e.createdAt)}</span>
            {user ? (
              <Button
                size="sm"
                loading={claim.isPending && claim.variables === e.id}
                onClick={() => claim.mutate(e.id)}
              >
                Claim
              </Button>
            ) : null}
            <IconButton
              label="Forget on this device"
              onClick={() => {
                forgetEditKey(e.id);
                setEntries(listEditKeys());
              }}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </Card>
    </section>
  );
}

export default function MyDashboards() {
  useDocumentTitle('My dashboards');
  const qc = useQueryClient();
  const { data: user, isLoading: userLoading } = useMe();
  const [toDelete, setToDelete] = useState<DashboardMeta | null>(null);
  const list = useQuery({
    queryKey: ['my-dashboards'],
    queryFn: () => api<DashboardMeta[]>('/api/dashboards'),
    enabled: Boolean(user),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/dashboards/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: ['my-dashboards'] });
      toast('Dashboard deleted');
    },
  });

  return (
    <PageContainer>
      <PageHeader
        title="My dashboards"
        actions={
          <Link to="/new">
            <Button variant="primary" icon={<Plus className="size-4" />}>
              New dashboard
            </Button>
          </Link>
        }
      />

      {userLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !user ? (
        <EmptyState
          icon={<Lock className="size-6" />}
          title="Sign in to see your dashboards"
          action={
            <Link to="/login?returnTo=/me">
              <Button variant="primary">Sign in with Google</Button>
            </Link>
          }
        >
          Signed-in dashboards follow you to every device, can be private, and can be built by your AI agent
          over MCP.
        </EmptyState>
      ) : list.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="size-6" />}
          title="No dashboards yet"
          action={
            <Link to="/new">
              <Button variant="accent">Create your first dashboard</Button>
            </Link>
          }
        >
          Start from a template, or connect your AI agent and ask it to build one.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.data!.map((d) => (
            <DashboardCard key={d.id} d={d} onDelete={() => setToDelete(d)} />
          ))}
        </div>
      )}

      <DeviceDashboards />

      <Modal
        open={toDelete !== null}
        title="Delete dashboard?"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <Button onClick={() => setToDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => toDelete && remove.mutate(toDelete.id)}
            >
              Delete
            </Button>
          </>
        }
      >
        “{toDelete?.title}” and all its versions and uploaded files will be removed permanently.
      </Modal>
    </PageContainer>
  );
}
