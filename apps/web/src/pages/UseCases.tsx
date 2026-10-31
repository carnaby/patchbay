import type { DashboardEnvelope, UseCaseInfo } from '@patchbay/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Check, Copy, ExternalLink, ImageOff, Play, Volume2, VolumeX } from 'lucide-react';
import { type KeyboardEvent, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Button, cx, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { saveEditKey } from '../lib/edit-keys.ts';
import { tabsReducer } from '../lib/use-case-tabs.ts';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Subscribed rather than read once, so toggling the OS setting takes effect without a reload.
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== 'function') return () => {};
      const mq = matchMedia(REDUCED_MOTION);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

export function UseCases() {
  const { data } = useQuery({
    queryKey: ['use-cases'],
    queryFn: () => api<UseCaseInfo[]>('/api/use-cases'),
    staleTime: 300_000,
  });
  const list = data ?? [];
  const [tabs, dispatch] = useReducer(tabsReducer, { active: 0, count: 0, interacted: false });
  useEffect(() => dispatch({ type: 'reset', count: list.length }), [list.length]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  if (list.length === 0) return null; // self-hosted instances without use cases show nothing
  const current = list[tabs.active] ?? list[0]!;

  const select = (index: number, focus = false) => {
    dispatch({ type: 'select', index });
    if (focus) tabRefs.current[index]?.focus();
  };
  // Roving tabindex with arrow keys, as the ARIA tabs pattern expects.
  const onKeyDown = (e: KeyboardEvent) => {
    const n = list.length;
    const i = tabs.active;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next, true);
  };

  return (
    <section
      id="use-cases"
      className="mx-auto max-w-6xl scroll-mt-16 px-4 py-20"
      aria-labelledby="use-cases-title"
    >
      <div className="mx-auto mb-8 max-w-2xl text-center">
        <div className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Use cases</div>
        <h2
          id="use-cases-title"
          className="text-[clamp(1.6rem,4vw,2.3rem)] leading-tight font-semibold tracking-tight text-balance"
        >
          One sentence to your agent. A live dashboard.
        </h2>
        <p className="mt-3 text-ink-2 text-pretty">
          Real dashboards, each built by an AI agent from the prompt shown. Open them live or copy one and
          make it yours.
        </p>
      </div>

      {/* The row scrolls sideways on narrow screens instead of wrapping into several lines. */}
      <div className="-mx-4 mb-6 overflow-x-auto px-4 pb-1">
        <div
          role="tablist"
          aria-label="Use cases"
          className="mx-auto flex w-max gap-1 rounded-xl bg-surface-2 p-1"
        >
          {list.map((u, i) => {
            const active = i === tabs.active;
            return (
              <button
                key={u.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`use-case-tab-${u.id}`}
                aria-selected={active}
                aria-controls="use-case-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => select(i)}
                onKeyDown={onKeyDown}
                className={cx(
                  'h-9 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition',
                  active ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
                )}
              >
                {u.tab}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id="use-case-panel"
        aria-labelledby={`use-case-tab-${current.id}`}
        className="grid items-start gap-6 md:grid-cols-[3fr_2fr] md:gap-8"
      >
        <UseCaseVideo
          key={current.id}
          item={current}
          loop={tabs.interacted}
          onEnded={() => dispatch({ type: 'ended' })}
        />
        <UseCaseText key={`t-${current.id}`} item={current} />
      </div>
    </section>
  );
}

function UseCaseText({ item }: { item: UseCaseInfo }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopied(true);
    } catch {
      toast('Copy failed, select the text and copy it manually', 'bad');
    }
  };

  const duplicate = useMutation({
    mutationFn: () =>
      api<{ envelope: DashboardEnvelope; editKey?: string }>(
        `/api/dashboards/${item.dashboardId}/duplicate`,
        {
          body: {},
        },
      ),
    onSuccess: ({ envelope, editKey }) => {
      if (editKey) saveEditKey(envelope.meta.id, editKey, envelope.doc.title);
      navigate(`/d/${envelope.meta.id}`);
    },
    onError: () => toast('Could not copy this dashboard. Try again in a moment.', 'bad'),
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
        <p className="mt-1.5 text-ink-2 text-pretty">{item.description}</p>
      </div>

      <figure>
        <figcaption className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
          <Bot className="size-3.5" aria-hidden="true" /> The prompt the agent got
        </figcaption>
        <blockquote className="rounded-2xl rounded-bl-md bg-ink px-4 py-3 text-sm leading-relaxed text-page">
          {item.prompt}
        </blockquote>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={copyPrompt}
          icon={copied ? <Check className="size-4 text-good" /> : <Copy className="size-4" />}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </Button>
        <span className="sr-only" role="status">
          {copied ? 'Prompt copied to the clipboard' : ''}
        </span>
      </figure>

      <div className="flex flex-col gap-2 sm:flex-row">
        {/* A plain anchor: /showcase/:id is a server redirect to the live dashboard, not a client route. */}
        <a href={`/showcase/${item.id}`} className="sm:flex-1">
          <Button variant="accent" className="w-full" icon={<ExternalLink className="size-4" />}>
            Open live
          </Button>
        </a>
        <Button
          variant="secondary"
          className="sm:flex-1"
          loading={duplicate.isPending}
          onClick={() => duplicate.mutate()}
          icon={<Copy className="size-4" />}
        >
          Make your own copy
        </Button>
      </div>
    </div>
  );
}

function UseCaseVideo({ item, loop, onEnded }: { item: UseCaseInfo; loop: boolean; onEnded: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);
  const reduced = usePrefersReducedMotion();
  const hasVideo = Boolean(item.video) && !videoFailed;

  useEffect(() => {
    const video = ref.current;
    if (!video || reduced || !hasVideo) return;
    // Play only while on screen: off-screen videos cost bandwidth and battery for nothing.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [reduced, hasVideo]);

  if (!hasVideo) return <Snapshot item={item} />;

  return (
    <div className="relative">
      <video
        ref={ref}
        src={item.video ?? undefined}
        poster={item.poster ?? undefined}
        muted={muted}
        loop={loop}
        playsInline
        preload="metadata"
        controls={reduced}
        onEnded={onEnded}
        onError={() => setVideoFailed(true)}
        aria-label={`${item.title}: screen recording of the agent building the dashboard`}
        className="aspect-video w-full rounded-xl border border-line bg-surface-2 object-cover"
      />
      {reduced ? (
        <button
          type="button"
          aria-label="Play video"
          onClick={() => void ref.current?.play()}
          className="absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-ink/80 text-page backdrop-blur hover:bg-ink"
        >
          <Play className="size-6 translate-x-0.5" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
        aria-pressed={!muted}
        onClick={() => setMuted((m) => !m)}
        className={cx(
          'absolute right-2 flex size-9 items-center justify-center rounded-full bg-ink/70 text-page backdrop-blur hover:bg-ink',
          // Native controls (reduced motion) occupy the bottom edge.
          reduced ? 'top-2' : 'bottom-2',
        )}
      >
        {muted ? (
          <VolumeX className="size-4" aria-hidden="true" />
        ) : (
          <Volume2 className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// No video yet: the live dashboard's server snapshot stands in. The endpoint is rate limited, so a failed
// load degrades to a plain card instead of a broken image.
function Snapshot({ item }: { item: UseCaseInfo }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 p-6 text-center">
        <ImageOff className="size-6 text-muted" aria-hidden="true" />
        <div className="font-medium">{item.title}</div>
        <div className="text-sm text-ink-2">Preview unavailable. Open the live dashboard instead.</div>
      </div>
    );
  }
  return (
    <img
      src={`/api/dashboards/${item.dashboardId}/snapshot.png`}
      alt={`${item.title}: snapshot of the live dashboard`}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-video w-full rounded-xl border border-line bg-surface-2 object-cover"
    />
  );
}
