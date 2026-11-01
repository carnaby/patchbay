import type { DashboardEnvelope, UseCaseInfo } from '@patchbay/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Check, Copy, ExternalLink } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { Button, buttonClass, cx, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { saveEditKey } from '../lib/edit-keys.ts';
import { useMediaQuery } from '../lib/hooks.ts';
import {
  afterEnd,
  keyboardFocusWithin,
  revealScrollLeft,
  type SwipeStartPoint,
  stepIndex,
  swipeEnd,
  swipeStart,
  tabsReducer,
} from '../lib/use-case-tabs.ts';
import { fullscreenElement } from '../lib/use-case-video.ts';
import { Attachment } from './use-cases/Attachment.tsx';
import { UseCaseVideo } from './use-cases/UseCaseVideo.tsx';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** Room left beside a tab scrolled into view, so it never sits flush against the row's edge. */
const TAB_MARGIN = 16;

export function UseCases() {
  const { data } = useQuery({
    queryKey: ['use-cases'],
    queryFn: () => api<UseCaseInfo[]>('/api/use-cases'),
    staleTime: 300_000,
  });
  const list = data ?? [];
  const [tabs, dispatch] = useReducer(tabsReducer, { active: 0, count: 0, dir: 0 });
  useEffect(() => dispatch({ type: 'reset', count: list.length }), [list.length]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRow = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const slide = useRef<HTMLDivElement>(null);
  const swipe = useRef<SwipeStartPoint | null>(null);
  const reduced = useMediaQuery(REDUCED_MOTION);
  // One setting for the whole section, in memory only: a fresh page load cannot autoplay with sound anyway.
  const [muted, setMuted] = useState(true);
  const dialogOpen = useRef(false);

  // Under reduced motion every tab shows its poster, so each is in the cache before its tab does. Otherwise only the
  // first view shows one, which loads with it.
  useEffect(() => {
    if (reduced) for (const u of data ?? []) if (u.poster) new Image().src = u.poster;
  }, [data, reduced]);

  // Whatever changed the tab (a swipe, the end of a video, a key), its button must be visible in the row, which
  // scrolls sideways on narrow screens. Only the row scrolls, never the page.
  useEffect(() => {
    const row = tabRow.current;
    const tab = tabRefs.current[tabs.active];
    if (!row || !tab) return;
    const start = tab.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    const left = revealScrollLeft(
      { scrollLeft: row.scrollLeft, width: row.clientWidth },
      { start, width: tab.offsetWidth },
      TAB_MARGIN,
    );
    if (left !== row.scrollLeft) row.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' });
  }, [tabs.active, reduced]);

  // The incoming tab slides in from the side it comes from, so a change reads as a move, not a blink. Animated in
  // place rather than by remounting the panel: the video element must survive a tab change (see UseCaseVideo).
  // Before paint: an auto-advance (a video's `ended`) is not a discrete event, so a passive effect could run after
  // the incoming tab was painted at full opacity for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every new active tab replays the slide
  useLayoutEffect(() => {
    if (reduced || tabs.dir === 0) return;
    slide.current?.animate(
      [
        { opacity: 0, transform: `translateX(${tabs.dir * 16}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  }, [tabs.active, tabs.dir, reduced]);

  if (list.length === 0) return null; // self-hosted instances without use cases show nothing
  const current = list[tabs.active] ?? list[0]!;

  /** The active tab's video or snapshot ended: true when the section moves on, false when it stays. */
  const endOfTab = (fullscreen: boolean) => {
    const next =
      afterEnd({
        count: list.length,
        reduced,
        fullscreen: fullscreen || fullscreenElement() !== null,
        dialogOpen: dialogOpen.current,
        // The tabs count too: moving on under a keyboard user there would leave focus on a tab that is no longer
        // selected and so out of the Tab order (roving tabindex).
        keyboardFocus: keyboardFocusWithin(document.activeElement, [tabRow.current, panel.current]),
      }) === 'next';
    if (next) dispatch({ type: 'ended' });
    return next;
  };

  const select = (index: number, dir?: -1 | 1, focus = false) => {
    dispatch({ type: 'select', index, dir });
    if (focus) tabRefs.current[index]?.focus();
  };
  // Roving tabindex with arrow keys, as the ARIA tabs pattern expects.
  const onKeyDown = (e: KeyboardEvent) => {
    const n = list.length;
    const i = tabs.active;
    if (e.key === 'ArrowRight') select(stepIndex(i, 1, n), 1, true);
    else if (e.key === 'ArrowLeft') select(stepIndex(i, -1, n), -1, true);
    else if (e.key === 'Home') select(0, undefined, true);
    else if (e.key === 'End') select(n - 1, undefined, true);
    else return;
    e.preventDefault();
  };

  // Touch only: a mouse drag selects text. The panel is `touch-action: pan-y pinch-zoom`, so vertical scrolling and
  // zooming stay with the browser (it cancels the pointer) and a sideways move reaches pointerup.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    // React bubbles events out of portals, so the attachment dialog's own gestures land here too.
    // Zoomed in, a sideways drag is the visitor panning the page, which `pan-y` hands to us instead of the browser.
    const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
    if (e.pointerType !== 'touch' || zoomed || !e.currentTarget.contains(target)) {
      swipe.current = null;
      return;
    }
    const pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, primary: e.isPrimary };
    // Native controls (reduced motion) have a seek bar that is dragged sideways.
    swipe.current = swipeStart(pointer, target.closest('video[controls]') !== null);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    // In full screen the panel cannot change underneath: the new tab would drop the video out of full screen.
    if (list.length < 2 || fullscreenElement()) return;
    const step = swipeEnd(start, { id: e.pointerId, x: e.clientX, y: e.clientY, primary: e.isPrimary });
    if (step) select(stepIndex(tabs.active, step, list.length), step);
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
      <div ref={tabRow} className="-mx-4 mb-6 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
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
                  // The prompt bubble's pairing: unmistakable in both themes.
                  active ? 'bg-ink text-page shadow-sm' : 'text-ink-2 hover:text-ink',
                )}
              >
                {u.tab}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={panel}
        role="tabpanel"
        id="use-case-panel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the ARIA tabs pattern makes the panel reachable from its tab
        tabIndex={0}
        aria-labelledby={`use-case-tab-${current.id}`}
        className="touch-pan-y touch-pinch-zoom rounded-xl"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        <div ref={slide}>
          <UseCaseVideo
            item={current}
            intro={tabs.dir === 0}
            reduced={reduced}
            muted={muted}
            onMutedChange={setMuted}
            onEnded={endOfTab}
          />
          {/* Every tab's text in one grid cell, only the active one visible: the cell is as tall as the longest,
              so the page below does not jump when the tabs change. */}
          <div className="mt-6 grid md:mt-8">
            {list.map((u) => (
              <UseCaseText
                key={u.id}
                item={u}
                active={u.id === current.id}
                onDialogChange={(open) => {
                  dialogOpen.current = open;
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function UseCaseText({
  item,
  active,
  onDialogChange,
}: {
  item: UseCaseInfo;
  active: boolean;
  onDialogChange: (open: boolean) => void;
}) {
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
    <div
      // Inactive tabs only hold the cell's height: invisible, out of the tab order and the accessibility tree.
      inert={!active}
      aria-hidden={active ? undefined : true}
      className={cx(
        'col-start-1 row-start-1 grid content-start gap-6 md:grid-cols-2 md:grid-rows-[auto_1fr] md:gap-x-10',
        !active && 'invisible',
      )}
    >
      <div className="md:col-start-1 md:row-start-1">
        <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
        <p className="mt-1.5 text-ink-2 text-pretty">{item.description}</p>
      </div>

      <figure className="md:col-start-2 md:row-span-2 md:row-start-1">
        <figcaption className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
          <Bot className="size-3.5" aria-hidden="true" /> The prompt the agent got
        </figcaption>
        <blockquote className="rounded-2xl rounded-bl-md bg-ink px-4 py-3 text-sm leading-relaxed text-page">
          {item.prompt}
        </blockquote>
        {item.attachment ? <Attachment attachment={item.attachment} onOpenChange={onDialogChange} /> : null}
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

      <div className="flex flex-col gap-2 sm:flex-row md:col-start-1 md:row-start-2 md:self-start">
        {/* A plain anchor: /showcase/:id is a server redirect to the live dashboard, not a client route. */}
        <a href={`/showcase/${item.id}`} className={buttonClass('accent', 'md', 'sm:flex-1')}>
          <ExternalLink className="size-4" aria-hidden="true" />
          Open live
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
