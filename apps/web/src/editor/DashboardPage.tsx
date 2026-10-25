import type { DashboardEnvelope } from '@patchbay/core';
import { useQuery } from '@tanstack/react-query';
import { Bot, Check, Database, Globe, History, Lock, Pencil, Plus, Redo2, Share2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Logo, ThemeToggle, UserMenu } from '../components/AppShell.tsx';
import { Badge, Button, cx, EmptyState, IconButton, Kbd, Spinner } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { relativeTime, useDocumentTitle } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';
import { useAutosave, useLiveEvents } from '../state/sync.ts';
import { ConnectAiPanel } from './ConnectAiPanel.tsx';
import { DatasetsPanel } from './DatasetsPanel.tsx';
import { Grid } from './Grid.tsx';
import { SharePanel } from './SharePanel.tsx';
import { VersionsPanel } from './VersionsPanel.tsx';
import { WidgetEditor } from './WidgetEditor.tsx';

type Panel = 'data' | 'versions' | 'share' | 'ai' | null;

export default function DashboardPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api<DashboardEnvelope>(`/api/dashboards/${id}`, { dashboardId: id }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const loadedId = useEditor((s) => s.id);
  const load = useEditor((s) => s.load);

  // Load once per fetched envelope; afterwards the editor store is the source of truth.
  useEffect(() => {
    if (query.data) load(query.data);
  }, [query.data, load]);

  if (query.isError) {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    return (
      <div className="min-h-screen">
        <header className="flex h-14 items-center justify-between border-b border-line px-4">
          <Logo />
          <ThemeToggle />
        </header>
        <div className="mx-auto max-w-lg px-4 py-24">
          <EmptyState
            icon={<Lock className="size-8" />}
            title={status === 401 ? 'This dashboard is private' : 'Dashboard not found'}
            action={
              status === 401 ? (
                <Link to={`/login?returnTo=/d/${id}`}>
                  <Button variant="primary">Sign in</Button>
                </Link>
              ) : (
                <Link to="/new">
                  <Button variant="primary">Build a new one</Button>
                </Link>
              )
            }
          >
            {status === 401
              ? 'Sign in with the account that owns it.'
              : 'It may have been deleted, or the link is wrong.'}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!query.data || loadedId !== id) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <Editor id={id} />;
}

function Editor({ id }: { id: string }) {
  const doc = useEditor((s) => s.doc)!;
  const meta = useEditor((s) => s.meta)!;
  const access = useEditor((s) => s.access)!;
  const editing = useEditor((s) => s.editing);
  const setEditing = useEditor((s) => s.setEditing);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const dirty = useEditor((s) => s.doc !== s.saved);
  const saving = useEditor((s) => s.saving);
  const conflict = useEditor((s) => s.conflict);
  const lastRemote = useEditor((s) => s.lastRemote);
  const [panel, setPanel] = useState<Panel>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const live = useLiveEvents(id);
  useAutosave();
  const [search, setSearch] = useSearchParams();
  // Fresh dashboards open straight in edit mode (/d/:id?edit=1).
  useEffect(() => {
    if (search.get('edit') === '1') {
      if (access.canEdit) setEditing(true);
      search.delete('edit');
      setSearch(search, { replace: true });
    }
  }, [search, setSearch, access.canEdit, setEditing]);
  useDocumentTitle(doc.title);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !useEditor.getState().access?.canEdit) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const addWidget = () => {
    if (doc.datasets.length === 0) {
      setPanel('data');
      return;
    }
    setWidgetId('__new__');
  };

  const status = saving ? 'Saving…' : dirty ? 'Unsaved' : `Saved ${relativeTime(meta.updatedAt)}`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          <Logo className="[&>span]:hidden sm:[&>span]:inline" />
          <div className="mx-2 hidden h-6 w-px bg-line sm:block" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <TitleInput />
            ) : (
              <h1 className="truncate text-[15px] font-semibold" title={doc.description || doc.title}>
                {doc.title}
              </h1>
            )}
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              {meta.visibility === 'private' ? (
                <span className="flex items-center gap-1">
                  <Lock className="size-3" /> Private
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Globe className="size-3" /> Public
                </span>
              )}
              <span aria-hidden="true">·</span>
              {access.canEdit ? <span>{status}</span> : <span>Updated {relativeTime(meta.updatedAt)}</span>}
              {lastRemote ? (
                <span className="hidden truncate md:inline">
                  · {lastRemote.actor.label} {relativeTime(new Date(lastRemote.at).toISOString())}
                </span>
              ) : null}
            </div>
          </div>
          {access.canEdit && editing ? (
            <div className="hidden items-center sm:flex">
              <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
                <Undo2 className="size-4" />
              </IconButton>
              <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
                <Redo2 className="size-4" />
              </IconButton>
              <div className="mx-1 h-6 w-px bg-line" />
              <Button
                size="sm"
                variant="ghost"
                icon={<Database className="size-4" />}
                onClick={() => setPanel('data')}
              >
                Data
              </Button>
              <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={addWidget}>
                Widget
              </Button>
            </div>
          ) : null}
          <IconButton label="Version history" onClick={() => setPanel('versions')}>
            <History className="size-4" />
          </IconButton>
          <IconButton label="Connect an AI agent" onClick={() => setPanel('ai')}>
            <Bot className="size-4" />
          </IconButton>
          <IconButton label="Share" onClick={() => setPanel('share')}>
            <Share2 className="size-4" />
          </IconButton>
          {access.canEdit ? (
            <Button
              size="sm"
              variant={editing ? 'primary' : 'secondary'}
              icon={editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
              onClick={() => setEditing(!editing)}
            >
              {editing ? 'Done' : 'Edit'}
            </Button>
          ) : null}
          <div className="hidden items-center gap-1 sm:flex">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
        {editing ? (
          <div className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs text-muted sm:hidden">
            <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
              <Redo2 className="size-4" />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => setPanel('data')}>
              Data
            </Button>
            <Button size="sm" variant="ghost" onClick={addWidget}>
              Widget
            </Button>
          </div>
        ) : null}
      </header>

      {conflict ? <ConflictBanner /> : null}

      <main className="px-3 py-4 sm:px-4">
        {doc.description && !editing ? (
          <p className="mb-4 max-w-3xl text-sm text-ink-2">{doc.description}</p>
        ) : null}
        {editing ? <DescriptionInput /> : null}
        {doc.widgets.length === 0 ? (
          <div className="mx-auto max-w-2xl py-16">
            <EmptyState
              icon={<Database className="size-8" />}
              title="An empty patchbay"
              action={
                access.canEdit ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      variant="primary"
                      icon={<Database className="size-4" />}
                      onClick={() => {
                        setEditing(true);
                        setPanel('data');
                      }}
                    >
                      Add data
                    </Button>
                    <Button icon={<Bot className="size-4" />} onClick={() => setPanel('ai')}>
                      Let your AI build it
                    </Button>
                  </div>
                ) : null
              }
            >
              {access.canEdit ? (
                <>
                  Plug in a public API or your own CSV, then pick from suggested charts. Or connect an AI
                  agent over MCP and ask it to build this dashboard for you; you will see it appear here live.
                </>
              ) : (
                'Nothing here yet.'
              )}
            </EmptyState>
          </div>
        ) : (
          <Grid dashboardId={id} live={live} onEditWidget={(wid) => setWidgetId(wid)} />
        )}
        {editing ? (
          <p className="mt-6 text-center text-xs text-muted">
            Drag widgets by their title, resize from the corner. <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo,{' '}
            <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd> redo. Every change is saved and versioned.
          </p>
        ) : null}
      </main>

      <DatasetsPanel open={panel === 'data'} onClose={() => setPanel(null)} dashboardId={id} />
      <VersionsPanel open={panel === 'versions'} onClose={() => setPanel(null)} dashboardId={id} />
      <SharePanel open={panel === 'share'} onClose={() => setPanel(null)} dashboardId={id} />
      <ConnectAiPanel open={panel === 'ai'} onClose={() => setPanel(null)} dashboardId={id} />
      <WidgetEditor
        widgetId={widgetId}
        onClose={() => setWidgetId(null)}
        onCreated={(wid) => setWidgetId(wid)}
      />
    </div>
  );
}

function TitleInput() {
  const title = useEditor((s) => s.doc!.title);
  const apply = useEditor((s) => s.apply);
  return (
    <input
      aria-label="Dashboard title"
      value={title}
      maxLength={120}
      onChange={(e) =>
        e.target.value.trim() &&
        apply([{ op: 'setMeta', title: e.target.value }], 'Renamed dashboard', { coalesce: 'title' })
      }
      className="w-full max-w-md truncate rounded-md bg-transparent px-1 -ml-1 text-[15px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2"
    />
  );
}

function DescriptionInput() {
  const description = useEditor((s) => s.doc!.description);
  const apply = useEditor((s) => s.apply);
  return (
    <textarea
      aria-label="Dashboard description"
      placeholder="Add a short description (optional)"
      value={description}
      rows={1}
      maxLength={1000}
      onChange={(e) =>
        apply([{ op: 'setMeta', description: e.target.value }], 'Edited description', {
          coalesce: 'description',
        })
      }
      className={cx(
        'mb-3 block w-full max-w-3xl resize-none rounded-md bg-transparent px-1 -ml-1 text-sm text-ink-2 outline-none hover:bg-surface-2 focus:bg-surface-2',
      )}
    />
  );
}

function ConflictBanner() {
  const resolve = useEditor((s) => s.resolveConflict);
  const conflict = useEditor((s) => s.conflict)!;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2.5 text-sm">
      <Badge tone="bad">Conflict</Badge>
      <span className="text-ink-2">
        {conflict.meta.lastActor?.label ?? 'Someone'} changed this dashboard while you were editing, and the
        changes overlap.
      </span>
      <span className="flex-1" />
      <Button size="sm" onClick={() => resolve('theirs')}>
        Use theirs
      </Button>
      <Button size="sm" variant="primary" onClick={() => resolve('mine')}>
        Keep mine
      </Button>
    </div>
  );
}
