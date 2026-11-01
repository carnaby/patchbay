import type { UseCaseInfo } from '@patchbay/core';
import { ImageOff, Maximize2, Minimize2, Play, Volume2, VolumeX } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui.tsx';
import { useMediaQuery, useTheme } from '../../lib/hooks.ts';
import { chooseVideo, fullscreenElement, resumeAt, type VideoChoice } from '../../lib/use-case-video.ts';

/** Tailwind's `md`: below it the square cut fills a phone screen better than 16:9. */
const WIDE = '(min-width: 768px)';
/** How long a tab without a video stays before the next one shows. */
const SNAPSHOT_DWELL_MS = 9000;

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const doc = () => document as WebkitDocument;

/** True while the element is at least partly on screen. */
function useOnScreen(ref: { current: Element | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      threshold: 0.4,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

/**
 * Full screen for the wrapper, so our sound and full screen buttons stay on top of the video. The iPhone has no
 * element full screen, only the native video player, which keeps its own volume control.
 */
function useFullscreen(
  wrap: RefObject<HTMLDivElement | null>,
  video: RefObject<HTMLVideoElement | null>,
  button: RefObject<HTMLButtonElement | null>,
) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const v = video.current;
    const onChange = () => {
      const now = fullscreenElement() === wrap.current;
      setActive(now);
      // Clicking the video leaves focus outside; the button inside is the way back for keyboards and readers.
      if (now && !wrap.current?.contains(document.activeElement))
        button.current?.focus({ preventScroll: true });
    };
    const onBegin = () => setActive(true);
    const onEnd = () => setActive(false);
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    v?.addEventListener('webkitbeginfullscreen', onBegin);
    v?.addEventListener('webkitendfullscreen', onEnd);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      v?.removeEventListener('webkitbeginfullscreen', onBegin);
      v?.removeEventListener('webkitendfullscreen', onEnd);
    };
  }, [wrap, video, button]);

  /** Returns true when it starts entering full screen. */
  const toggle = (): boolean => {
    const el = wrap.current as WebkitElement | null;
    const v = video.current as WebkitVideo | null;
    if (!el || !v) return false;
    if (active) {
      if (doc().exitFullscreen)
        void doc()
          .exitFullscreen()
          .catch(() => {});
      else doc().webkitExitFullscreen?.();
      return false;
    }
    try {
      if (doc().fullscreenEnabled && el.requestFullscreen) void el.requestFullscreen().catch(() => {});
      else if (doc().webkitFullscreenEnabled && el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
      else return false;
    } catch {
      // The iPhone refuses before the video's metadata has loaded; the next tap works.
      return false;
    }
    return true;
  };
  return { active, toggle };
}

export function UseCaseVideo({
  item,
  loop,
  auto,
  reduced,
  onEnded,
  onInteract,
}: {
  item: UseCaseInfo;
  loop: boolean;
  auto: boolean;
  reduced: boolean;
  onEnded: () => void;
  onInteract: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const wide = useMediaQuery(WIDE);
  const wanted = chooseVideo(item, !wide, failed);
  const [shown, setShown] = useState<VideoChoice | null>(wanted);
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const fullscreen = useFullscreen(wrap, ref, fullscreenButton);
  const toggleFullscreen = () => {
    // Entering is a deliberate act: the visitor is watching this one, so the tabs must not move on underneath.
    if (fullscreen.toggle()) onInteract();
  };

  // Rotating a phone crosses the breakpoint. The other cut continues where this one was instead of restarting, and
  // nothing changes under full screen (ours or the iPhone's player), where the box no longer follows the layout.
  // A source that failed is replaced at once.
  const src = shown?.src;
  const wantedSrc = wanted?.src;
  const wantedSquare = wanted?.square ?? false;
  const shownFailed = src !== undefined && failed.has(src);
  useEffect(() => {
    if (wantedSrc === src || (fullscreen.active && !shownFailed)) return;
    const v = ref.current;
    resume.current = v && !shownFailed ? { time: v.currentTime, play: !v.paused } : null;
    setShown(wantedSrc ? { src: wantedSrc, square: wantedSquare } : null);
  }, [wantedSrc, wantedSquare, src, shownFailed, fullscreen.active]);

  useEffect(() => {
    const video = ref.current;
    if (!video || reduced || !src) return;
    // Play only while on screen: off-screen videos cost bandwidth and battery for nothing. Observed again when the
    // source changes (crossing the md breakpoint), because a new source starts paused.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [reduced, src]);

  if (!shown) return <Snapshot item={item} auto={auto} onEnded={onEnded} />;

  const full = fullscreen.active;
  const square = shown.square;
  return (
    <div
      ref={wrap}
      className={cx(
        'relative overflow-hidden bg-cover bg-center',
        full ? 'bg-black' : 'rounded-xl border border-line bg-surface-2',
        // The square box stays within the viewport's height (a phone held sideways), centred.
        full ? '' : square ? 'mx-auto aspect-square w-full max-w-[80svh]' : 'aspect-video',
      )}
      // The poster stays behind the video, so a frame is always visible before the first one decodes (no blink on
      // a tab change). The 16:9 poster is cropped, never stretched, in the square box.
      style={!full && item.poster ? { backgroundImage: `url("${item.poster}")` } : undefined}
    >
      {/* A click on the video is a mouse and touch shortcut; the full screen button is the keyboard path. */}
      <video
        ref={ref}
        src={src}
        // The square box shows the 16:9 poster as its background (cropped); as a poster it would be letterboxed.
        poster={square ? undefined : (item.poster ?? undefined)}
        muted={muted}
        loop={loop}
        playsInline
        preload="metadata"
        controls={reduced}
        onClick={reduced || full ? undefined : toggleFullscreen}
        onLoadedMetadata={(e) => {
          const r = resume.current;
          if (!r) return;
          resume.current = null;
          e.currentTarget.currentTime = resumeAt(r.time, e.currentTarget.duration);
          if (r.play) void e.currentTarget.play().catch(() => {});
        }}
        onEnded={() => {
          setPlaying(false);
          if (auto) onEnded();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        // Remembered per source: a broken square cut falls back to 16:9 before the snapshot.
        onError={() => setFailed((f) => new Set(f).add(shown.src))}
        aria-label={`${item.title}: screen recording of the agent building the dashboard`}
        className={cx(
          'absolute inset-0 size-full',
          full ? 'object-contain' : 'object-cover',
          !reduced && !full && 'cursor-zoom-in',
        )}
      />
      {reduced && !playing ? (
        <button
          type="button"
          aria-label="Play video"
          onClick={() => {
            onInteract();
            void ref.current?.play();
          }}
          className="absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-ink/80 text-page backdrop-blur hover:bg-ink"
        >
          <Play className="size-6 translate-x-0.5" aria-hidden="true" />
        </button>
      ) : null}
      {/* Native controls (reduced motion) occupy the bottom edge. */}
      <div className={cx('absolute right-2 flex gap-2', reduced ? 'top-2' : 'bottom-2')}>
        <OverlayButton ref={fullscreenButton} label="Full screen" pressed={full} onClick={toggleFullscreen}>
          {full ? (
            <Minimize2 className="size-4" aria-hidden="true" />
          ) : (
            <Maximize2 className="size-4" aria-hidden="true" />
          )}
        </OverlayButton>
        <OverlayButton
          label="Sound"
          pressed={!muted}
          onClick={() => {
            onInteract();
            setMuted((m) => !m);
          }}
        >
          {muted ? (
            <VolumeX className="size-4" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4" aria-hidden="true" />
          )}
        </OverlayButton>
      </div>
    </div>
  );
}

function OverlayButton({
  ref,
  label,
  pressed,
  onClick,
  children,
}: {
  ref?: RefObject<HTMLButtonElement | null>;
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      // Fixed colours rather than theme ones: the buttons sit on the (light) recording or on full screen black. The
      // focus ring is two-tone for the same reason: white on a black halo shows on both.
      className="flex size-9 items-center justify-center rounded-full bg-black/65 text-white ring-1 ring-white/25 backdrop-blur hover:bg-black/85 focus-visible:shadow-[0_0_0_5px_black] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
    >
      {children}
    </button>
  );
}

// No video yet: the live dashboard's server snapshot stands in. The endpoint is rate limited, so a failed
// load degrades to a plain card instead of a broken image.
function Snapshot({ item, auto, onEnded }: { item: UseCaseInfo; auto: boolean; onEnded: () => void }) {
  const [failed, setFailed] = useState(false);
  const theme = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(box);
  const advance = useRef(onEnded);
  advance.current = onEnded;
  // Only a video's end moves the tabs on, so a tab without one needs its own clock: it runs only while the section
  // is on screen and is cleared on tab change or unmount.
  useEffect(() => {
    if (!auto || !visible) return;
    const t = setTimeout(() => advance.current(), SNAPSHOT_DWELL_MS);
    return () => clearTimeout(t);
  }, [auto, visible]);
  // One outer element for both states: the visibility observer must not be left watching a removed node.
  return (
    <div ref={box}>
      {failed ? (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 p-6 text-center">
          <ImageOff className="size-6 text-muted" aria-hidden="true" />
          <div className="font-medium">{item.title}</div>
          <div className="text-sm text-ink-2">Preview unavailable. Open the live dashboard instead.</div>
        </div>
      ) : (
        <img
          src={`/api/dashboards/${item.dashboardId}/snapshot.png${theme === 'dark' ? '?theme=dark' : ''}`}
          alt={`${item.title}: snapshot of the live dashboard`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="aspect-video w-full rounded-xl border border-line bg-surface-2 object-cover"
        />
      )}
    </div>
  );
}
