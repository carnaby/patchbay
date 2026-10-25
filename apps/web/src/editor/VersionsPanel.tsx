import type { DashboardEnvelope, VersionInfo } from '@patchbay/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, RotateCcw, User } from 'lucide-react';
import { Button, Drawer, Spinner, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { relativeTime } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';

export function VersionsPanel({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
}) {
  const version = useEditor((s) => s.version);
  const canEdit = useEditor((s) => s.access?.canEdit);
  const versions = useQuery({
    queryKey: ['versions', dashboardId, version],
    queryFn: () => api<VersionInfo[]>(`/api/dashboards/${dashboardId}/versions`, { dashboardId }),
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: (v: number) =>
      api<{ envelope: DashboardEnvelope }>(`/api/dashboards/${dashboardId}/versions/${v}/restore`, {
        body: {},
        dashboardId,
      }),
    onSuccess: (res, v) => {
      const s = useEditor.getState();
      s.acceptRemote(res.envelope, {
        actor: { kind: 'user', label: 'You' },
        changes: [`Restored version ${v}`],
        at: Date.now(),
        version: res.envelope.meta.version,
      });
      toast(`Restored version ${v}`, 'neutral', { label: 'Undo', run: () => useEditor.getState().undo() });
    },
  });

  return (
    <Drawer open={open} onClose={onClose} title="Version history">
      <p className="mb-4 text-sm text-ink-2">
        Every save, by you or by an AI agent, is a version. The last 50 are kept. Restoring creates a new
        version, so nothing is ever lost.
      </p>
      {versions.isLoading ? <Spinner /> : null}
      <ol className="relative space-y-1 border-l border-line pl-4">
        {versions.data?.map((v) => (
          <li key={v.version} className="relative rounded-lg px-3 py-2 hover:bg-surface">
            <span className="absolute top-3.5 -left-[21px] size-2.5 rounded-full border-2 border-page bg-line-strong" />
            <div className="flex items-center gap-2 text-sm">
              {v.actor.kind === 'mcp' ? (
                <Bot className="size-3.5 text-accent" />
              ) : (
                <User className="size-3.5 text-muted" />
              )}
              <span className="font-medium">{v.actor.label}</span>
              <span className="text-xs text-muted">
                v{v.version} · {relativeTime(v.savedAt)}
              </span>
              <span className="flex-1" />
              {v.version === version ? (
                <span className="text-xs text-muted">current</span>
              ) : canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw className="size-3.5" />}
                  loading={restore.isPending && restore.variables === v.version}
                  onClick={() => restore.mutate(v.version)}
                >
                  Restore
                </Button>
              ) : null}
            </div>
            <ul className="mt-0.5 space-y-0.5 text-xs text-ink-2">
              {v.changes.slice(0, 4).map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: change lines
                <li key={i}>{c}</li>
              ))}
              {v.changes.length > 4 ? <li className="text-muted">+{v.changes.length - 4} more</li> : null}
            </ul>
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
