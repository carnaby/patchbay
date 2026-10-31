import type { AdminDashboardRow } from '@patchbay/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Spinner,
  Toggle,
  toast,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { relativeTime, useDocumentTitle } from '../lib/hooks.ts';
import { formatBytes, PageHeader } from './_shared.tsx';

interface AdminData {
  dashboards: AdminDashboardRow[];
  stats: {
    dashboards: number;
    anonymous: number;
    users: number;
    totalBytes: number;
    /** The server's memory guard; null when it knows no memory limit. */
    memory: { level: 'normal' | 'soft' | 'hard'; usedBytes: number; limitBytes: number } | null;
  };
}

const PRESSURE: Record<'normal' | 'soft' | 'hard', string> = {
  normal: '',
  soft: ' · refusing heavy work',
  hard: ' · refusing writes',
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </Card>
  );
}

function PruneCard() {
  const qc = useQueryClient();
  const [days, setDays] = useState('30');
  const [onlyAnonymous, setOnlyAnonymous] = useState(true);
  const [preview, setPreview] = useState<string[] | null>(null);
  const body = { olderThanDays: Math.max(1, Number(days) || 30), onlyAnonymous };
  const dry = useMutation({
    mutationFn: () => api<{ ids: string[] }>('/api/admin/prune', { body: { ...body, dryRun: true } }),
    onSuccess: (r) => setPreview(r.ids),
  });
  const prune = useMutation({
    mutationFn: () => api<{ ids: string[] }>('/api/admin/prune', { body }),
    onSuccess: (r) => {
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ['admin'] });
      toast(`Deleted ${r.ids.length} dashboard(s)`);
    },
  });
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Clean up unused dashboards</h2>
      <p className="mt-1 text-sm text-ink-2">
        Delete dashboards nobody has opened for a while. Every dashboard remembers when it was last viewed.
      </p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Field label="Not viewed for (days)" className="sm:w-48">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
        <div className="sm:w-64 sm:pb-2">
          <Toggle checked={onlyAnonymous} onChange={setOnlyAnonymous} label="Only anonymous dashboards" />
        </div>
        <Button
          variant="danger"
          loading={dry.isPending}
          onClick={() => dry.mutate()}
          icon={<Trash2 className="size-4" />}
        >
          Find &amp; delete…
        </Button>
      </div>
      <Modal
        open={preview !== null}
        title={preview?.length ? `Delete ${preview.length} dashboard(s)?` : 'Nothing to delete'}
        onClose={() => setPreview(null)}
        footer={
          preview?.length ? (
            <>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              <Button variant="danger" loading={prune.isPending} onClick={() => prune.mutate()}>
                Delete permanently
              </Button>
            </>
          ) : (
            <Button onClick={() => setPreview(null)}>Close</Button>
          )
        }
      >
        {preview?.length
          ? `${preview.length} ${onlyAnonymous ? 'anonymous ' : ''}dashboard(s) were not viewed in the last ${body.olderThanDays} days. Their folders, versions and files will be removed.`
          : 'No dashboards match these conditions.'}
      </Modal>
    </Card>
  );
}

interface SecretCounts {
  mode: 'off' | 'admins' | 'users';
  users: { userId: string; email: string; secrets: number }[];
}

const MODE_LABEL: Record<SecretCounts['mode'], string> = {
  off: 'off (nobody can store secrets)',
  admins: 'admins only',
  users: 'every signed-in user',
};

/**
 * Counts only, never names or values. If the encryption key and a copy of the database leak together, rotation
 * cannot help: the operator has to know whom to tell to revoke their credentials.
 */
function SecretCountsCard() {
  const query = useQuery({
    queryKey: ['admin', 'secrets'],
    queryFn: () => api<SecretCounts>('/api/admin/secrets'),
  });
  if (!query.data) return null;
  const { mode, users } = query.data;
  if (mode === 'off' && users.length === 0) return null;
  const total = users.reduce((sum, u) => sum + u.secrets, 0);
  return (
    <Card className="mb-10 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="size-4 text-muted" aria-hidden="true" />
        Stored secrets
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Secrets: {MODE_LABEL[mode]}. {total} secret{total === 1 ? '' : 's'} stored by {users.length} user
        {users.length === 1 ? '' : 's'}. If <code className="font-mono">SECRETS_KEY</code> and a copy of the
        data directory ever leak together, these are the people who must revoke their credentials at the
        source.
      </p>
      {users.length ? (
        <table className="mt-4 w-full max-w-md text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 font-medium">User</th>
              <th className="py-2 text-right font-medium">Secrets</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.userId} className="border-b border-line/60 last:border-0">
                <td className="max-w-64 truncate py-2 text-ink-2">{u.email}</td>
                <td className="tabular py-2 text-right">{u.secrets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

export default function Admin() {
  useDocumentTitle('Admin');
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [toDelete, setToDelete] = useState<AdminDashboardRow | null>(null);
  const query = useQuery({ queryKey: ['admin'], queryFn: () => api<AdminData>('/api/admin/dashboards') });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/dashboards/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: ['admin'] });
      toast('Dashboard deleted');
    },
  });
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = query.data?.dashboards ?? [];
    return q
      ? all.filter((d) => `${d.title} ${d.ownerEmail ?? 'anonymous'} ${d.id}`.toLowerCase().includes(q))
      : all;
  }, [query.data, filter]);

  if (query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 401)) {
    return (
      <PageContainer>
        <EmptyState icon={<ShieldAlert className="size-6" />} title="Admins only">
          This page is available only to the administrator email configured on the server.
        </EmptyState>
      </PageContainer>
    );
  }
  if (query.isLoading || !query.data) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  const { stats } = query.data;
  return (
    <PageContainer>
      <PageHeader
        title="Admin"
        subtitle="Every dashboard on this server. Folders on disk are the source of truth; this list is re-synced on every visit."
      />
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Dashboards" value={stats.dashboards} />
        <Stat label="Anonymous" value={stats.anonymous} />
        <Stat label="Users" value={stats.users} />
        <Stat label="Disk used" value={formatBytes(stats.totalBytes)} />
        {stats.memory && (
          <Stat
            label={`Memory of ${formatBytes(stats.memory.limitBytes)}${PRESSURE[stats.memory.level]}`}
            value={formatBytes(stats.memory.usedBytes)}
          />
        )}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title, owner or id"
            className="pl-9"
            aria-label="Filter dashboards"
          />
        </div>
        <span className="text-sm text-muted">{rows.length} shown</span>
      </div>
      <Card className="mb-10 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Dashboard</th>
              <th className="px-4 py-2.5 font-medium">Owner</th>
              <th className="px-4 py-2.5 font-medium">Visibility</th>
              <th className="px-4 py-2.5 text-right font-medium">Widgets</th>
              <th className="px-4 py-2.5 text-right font-medium">Size</th>
              <th className="px-4 py-2.5 font-medium">Last viewed</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2/50">
                <td className="max-w-64 px-4 py-2.5">
                  <Link to={`/d/${d.id}`} className="block truncate font-medium hover:underline">
                    {d.title}
                  </Link>
                  <span className="font-mono text-[11px] text-muted">{d.id}</span>
                </td>
                <td className="max-w-48 truncate px-4 py-2.5 text-ink-2">
                  {d.ownerEmail ?? <span className="text-muted italic">anonymous</span>}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={d.visibility === 'public' ? 'data' : 'neutral'}>{d.visibility}</Badge>
                </td>
                <td className="tabular px-4 py-2.5 text-right">{d.widgets}</td>
                <td className="tabular px-4 py-2.5 text-right">{formatBytes(d.sizeBytes)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">{relativeTime(d.lastViewedAt)}</td>
                <td className="px-2 py-2.5">
                  <IconButton
                    label={`Delete ${d.title}`}
                    onClick={() => setToDelete(d)}
                    className="hover:text-bad"
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted">
                  No dashboards
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <SecretCountsCard />

      <PruneCard />

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
        “{toDelete?.title}” ({toDelete?.ownerEmail ?? 'anonymous'}) will be removed permanently, with all
        versions and files.
      </Modal>
    </PageContainer>
  );
}
