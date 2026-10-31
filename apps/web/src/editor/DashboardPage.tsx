import type { DashboardEnvelope } from '@patchbay/core';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Check,
  ChevronDown,
  Database,
  Globe,
  History,
  Info,
  LayoutGrid,
  Lock,
  LogIn,
  MonitorPlay,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Redo2,
  Share2,
  Sun,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Logo, ThemeToggle, UserMenu } from '../components/AppShell.tsx';
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  Spinner,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { relativeTime, setTheme, useDocumentTitle, useMe, useTheme } from '../lib/hooks.ts';
import { setMuted, useSoundSettings } from '../lib/sounds.ts';
import { useEditor } from '../state/editor.ts';
import { soundWidgets, useSoundCues } from '../state/sound-cues.ts';
import { useAutosave, useLiveEvents } from '../state/sync.ts';
import { ConnectAiPanel } from './ConnectAiPanel.tsx';
import { DatasetsPanel } from './DatasetsPanel.tsx';
import { DetailsInput } from './DetailsFields.tsx';
import { Grid } from './Grid.tsx';
import { PresentationControls, TvInfo, TvInfoContent, useIdle, usePresentation } from './presentation.tsx';
import { PublicSecretsDialogs, SecretsSaveBanner } from './public-secrets.tsx';
import { SharePanel } from './SharePanel.tsx';
import { MuteButton } from './sound-controls.tsx';
import { VersionsPanel } from './VersionsPanel.tsx';
import { WidgetEditor } from './WidgetEditor.tsx';
import { WidgetFrame } from './WidgetFrame.tsx';

type Panel = 'data' | 'versions' | 'share' | 'ai' | null;

export default function DashboardPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api<DashboardEnvelope>(`/api/dashboards/${id}`, { dashboardId: id }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: me, isLoading: meLoading } = useMe();
  const loadedId = useEditor((s) => s.id);
  const load = useEditor((s) => s.load);

  // Load once per fetched envelope; afterwards the editor store is the source of truth.
  useEffect(() => {
    if (query.data) load(query.data);
  }, [query.data, load]);

  if (query.isError) {
    // The server answers a private dashboard exactly like a missing one, so a signed-out visitor gets a generic
    // hint that signing in may help.
    const signedOut = !meLoading && !me;
    return (
      <div className="min-h-screen">
        <header className="flex h-14 items-center justify-between border-b border-line px-4">
          <Logo />
          <ThemeToggle />
        </header>
        <div className="mx-auto max-w-lg px-4 py-24">
          <EmptyState
            icon={<Lock className="size-8" />}
            title="Dashboard not found"
            action={
              signedOut ? (
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
            {signedOut
              ? 'It may have been deleted or the link is wrong. If it is private, sign in with the account that owns it.'
              : 'It may have been deleted, the link is wrong, or it is private to another account.'}
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
  useSoundCues(id);
  const hasSounds = soundWidgets(doc.widgets).length > 0;
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

  // Presentation mode for wall screens; /d/:id?present=1 opens straight into it (kiosk links).
  const presentation = usePresentation(search.get('present') === '1');
  const { presenting } = presentation;
  const idle = useIdle(presenting);
  useEffect(() => {
    if (presenting) setEditing(false);
  }, [presenting, setEditing]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (e.key === 'Escape' && useEditor.getState().expanded) {
        useEditor.getState().setExpanded(null);
        return;
      }
      if (e.key.toLowerCase() === 'f' && !useEditor.getState().editing) {
        e.preventDefault();
        void (presentation.presenting ? presentation.stop() : presentation.start());
      } else if (e.key === 'Escape' && presentation.presenting) {
        void presentation.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentation]);

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

  // Opens even without datasets: text, clock and search widgets need none, and the drawer points to Data.
  const addWidget = () => setWidgetId('__new__');

  const status = saving ? 'Saving…' : dirty ? 'Unsaved' : `Saved ${relativeTime(meta.updatedAt)}`;

  return (
    <div className={cx('min-h-screen', presenting && idle && 'cursor-none')}>
      {presenting ? (
        <PresentationControls
          title={doc.title}
          idle={idle}
          onExit={() => void presentation.stop()}
          onFullscreen={() => void presentation.requestFullscreen()}
          hasSounds={hasSounds}
        />
      ) : null}
      <header
        className={cx(
          'sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur',
          presenting && 'hidden',
        )}
      >
        {/*
          What stays visible as the screen narrows (nothing may overlap, everything stays reachable):
          - always: logo mark, title + status line, Edit/Done, and below lg the "More" menu;
          - sm and up: the labelled Share button, theme and account;
          - lg and up: history, AI, present, TV info and mute inline, plus the editing tools in this row.
          Below lg the editing tools get a row of their own; everything else lives in the "More" menu.
          Below sm, controls grow to 40 px touch targets.
        */}
        <div className="flex h-14 items-center gap-1.5 px-3 sm:gap-2 sm:px-4">
          <Logo className="shrink-0 [&>span]:hidden sm:[&>span]:inline" />
          <div className="mx-1 hidden h-6 w-px shrink-0 bg-line sm:block lg:mx-2" />
          <div className="min-w-0 flex-1">
            <h1 className="flex min-w-0">
              <TitleButton
                title={doc.title}
                hint={access.canEdit ? 'Rename, describe or share' : doc.description || 'About and sharing'}
                onClick={() => setPanel('share')}
              />
            </h1>
            <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
              <VisibilityBadge visibility={meta.visibility} onClick={() => setPanel('share')} />
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate">
                {access.canEdit ? status : `Updated ${relativeTime(meta.updatedAt)}`}
              </span>
              {lastRemote ? (
                <span className="hidden min-w-0 truncate md:inline">
                  · {lastRemote.actor.label} {relativeTime(new Date(lastRemote.at).toISOString())}
                </span>
              ) : null}
            </div>
          </div>
          {access.canEdit && editing ? (
            <div className="hidden shrink-0 items-center lg:flex">
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
              <div className="mx-1 h-6 w-px bg-line" />
            </div>
          ) : null}
          <div className="hidden shrink-0 items-center lg:flex">
            <IconButton label="Version history" onClick={() => setPanel('versions')}>
              <History className="size-4" />
            </IconButton>
            <IconButton label="Connect an AI agent" onClick={() => setPanel('ai')}>
              <Bot className="size-4" />
            </IconButton>
            {hasSounds ? <MuteButton /> : null}
            <IconButton label="Present on a screen (F)" onClick={() => void presentation.start()}>
              <MonitorPlay className="size-4" />
            </IconButton>
            <TvInfo dashboardId={id} isPrivate={meta.visibility === 'private'} />
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Share2 className="size-4" />}
            onClick={() => setPanel('share')}
            className="max-sm:hidden"
          >
            Share
          </Button>
          {access.canEdit ? (
            <Button
              size="sm"
              variant={editing ? 'primary' : 'secondary'}
              icon={editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
              onClick={() => setEditing(!editing)}
              className="max-sm:h-10"
            >
              {editing ? 'Done' : 'Edit'}
            </Button>
          ) : null}
          <ToolbarMenu
            dashboardId={id}
            isPrivate={meta.visibility === 'private'}
            hasSounds={hasSounds}
            onPanel={setPanel}
            onPresent={() => void presentation.start()}
          />
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
        {access.canEdit && editing ? (
          <div className="flex items-center gap-1 border-t border-line px-3 py-1 sm:px-4 lg:hidden">
            <IconButton label="Undo" onClick={undo} disabled={!canUndo} className="max-sm:size-10">
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Redo" onClick={redo} disabled={!canRedo} className="max-sm:size-10">
              <Redo2 className="size-4" />
            </IconButton>
            <div className="mx-1 h-6 w-px bg-line" />
            <Button
              size="sm"
              variant="ghost"
              icon={<Database className="size-4" />}
              onClick={() => setPanel('data')}
              className="max-sm:h-10"
            >
              Data
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-4" />}
              onClick={addWidget}
              className="max-sm:h-10"
            >
              Widget
            </Button>
          </div>
        ) : null}
      </header>

      {conflict && !presenting ? <ConflictBanner /> : null}
      {presenting ? null : <SecretsSaveBanner />}

      <main className={cx('px-3 sm:px-4', presenting ? 'py-3' : 'py-4')}>
        {doc.description && !editing && !presenting ? (
          <p className="mb-4 max-w-3xl text-sm text-ink-2">{doc.description}</p>
        ) : null}
        {editing ? (
          <DetailsInput
            field="description"
            inline
            label="Dashboard description"
            placeholder="Add a short description (optional)"
            className="mb-3 max-w-3xl"
          />
        ) : null}
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
                    <Button
                      icon={<Plus className="size-4" />}
                      onClick={() => {
                        setEditing(true);
                        addWidget();
                      }}
                    >
                      Add widget
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
      </main>

      <DatasetsPanel open={panel === 'data'} onClose={() => setPanel(null)} dashboardId={id} />
      <VersionsPanel open={panel === 'versions'} onClose={() => setPanel(null)} dashboardId={id} />
      <SharePanel open={panel === 'share'} onClose={() => setPanel(null)} dashboardId={id} />
      <ConnectAiPanel open={panel === 'ai'} onClose={() => setPanel(null)} dashboardId={id} />
      <ExpandedWidget dashboardId={id} live={live} />
      <PublicSecretsDialogs />
      <WidgetEditor
        widgetId={widgetId}
        onClose={() => setWidgetId(null)}
        onCreated={(wid) => setWidgetId(wid)}
      />
    </div>
  );
}

/**
 * The dashboard's name, as a quiet button that opens the details and sharing panel, where it is renamed. The
 * chevron stays visible because touch screens have no hover to reveal that the title does something.
 */
function TitleButton({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-haspopup="dialog"
      className="group -ml-1 flex min-w-0 max-w-full cursor-pointer items-center gap-0.5 rounded-md px-1 text-left text-[15px] font-semibold transition hover:bg-surface-2"
    >
      <span className="truncate">{title}</span>
      <span className="sr-only">. Details and sharing</span>
      <ChevronDown
        className="size-3.5 shrink-0 text-muted transition group-hover:text-ink group-focus-visible:text-ink"
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * "Private"/"Public" next to the title. People look here when they want to share, so it opens the share panel.
 * The hit area reaches down to the toolbar's bottom edge to be easier to tap without covering the title.
 */
function VisibilityBadge({ visibility, onClick }: { visibility: 'public' | 'private'; onClick: () => void }) {
  const Icon = visibility === 'private' ? Lock : Globe;
  const label = visibility === 'private' ? 'Private' : 'Public';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}. Change who can open this dashboard`}
      title="Change who can open this dashboard"
      className="relative -ml-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 font-medium text-ink-2 underline decoration-line-strong decoration-dotted underline-offset-2 transition after:absolute after:-inset-x-1 after:-top-0.5 after:-bottom-2.5 hover:bg-surface-2 hover:text-ink"
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Overflow for whatever the toolbar has no room for at the current width. Items that are visible in the toolbar
 * at a breakpoint are hidden here at that breakpoint, so nothing shows up twice.
 */
function ToolbarMenu({
  dashboardId,
  isPrivate,
  hasSounds,
  onPanel,
  onPresent,
}: {
  dashboardId: string;
  isPrivate: boolean;
  hasSounds: boolean;
  onPanel: (panel: Panel) => void;
  onPresent: () => void;
}) {
  const [tvOpen, setTvOpen] = useState(false);
  const { muted } = useSoundSettings();
  const theme = useTheme();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <Menu
        label="More actions"
        icon={<MoreHorizontal className="size-4" />}
        className="max-sm:size-10 lg:hidden"
      >
        <MenuItem
          icon={<Share2 className="size-4" />}
          onSelect={() => onPanel('share')}
          className="sm:hidden"
        >
          Share
        </MenuItem>
        <MenuItem icon={<History className="size-4" />} onSelect={() => onPanel('versions')}>
          Version history
        </MenuItem>
        <MenuItem icon={<Bot className="size-4" />} onSelect={() => onPanel('ai')}>
          Connect an AI agent
        </MenuItem>
        <MenuItem icon={<MonitorPlay className="size-4" />} onSelect={onPresent}>
          Present on a screen
        </MenuItem>
        <MenuItem icon={<Info className="size-4" />} onSelect={() => setTvOpen(true)}>
          Showing this on a TV
        </MenuItem>
        {hasSounds ? (
          <MenuItem
            icon={muted ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            onSelect={() => setMuted(!muted)}
          >
            {muted ? 'Unmute sounds on this screen' : 'Mute sounds on this screen'}
          </MenuItem>
        ) : null}
        <MenuSeparator className="sm:hidden" />
        <MenuItem
          icon={theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="sm:hidden"
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </MenuItem>
        {me ? (
          <MenuItem
            icon={<LayoutGrid className="size-4" />}
            onSelect={() => navigate('/me')}
            className="sm:hidden"
          >
            My dashboards
          </MenuItem>
        ) : (
          <MenuItem
            icon={<LogIn className="size-4" />}
            onSelect={() =>
              navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`)
            }
            className="sm:hidden"
          >
            Sign in
          </MenuItem>
        )}
      </Menu>
      <Modal open={tvOpen} onClose={() => setTvOpen(false)} title="Showing this on a TV">
        <TvInfoContent dashboardId={dashboardId} isPrivate={isPrivate} />
      </Modal>
    </>
  );
}

/** One widget maximised over the dashboard; Esc or the button closes it. */
function ExpandedWidget({ dashboardId, live }: { dashboardId: string; live: boolean }) {
  const expanded = useEditor((s) => s.expanded);
  const widget = useEditor((s) => s.doc?.widgets.find((w) => w.id === s.expanded));
  if (!expanded || !widget) return null;
  return (
    <div
      className="fixed inset-0 z-40 bg-page p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={widget.title ?? widget.id}
    >
      <WidgetFrame
        dashboardId={dashboardId}
        widget={widget}
        live={live}
        editing={false}
        onEdit={() => {}}
        expanded
      />
    </div>
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
