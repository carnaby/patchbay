import type { UseCaseInfo } from '@patchbay/core';
import { ImageOff, Maximize2, Minimize2, Play, Volume2, VolumeX } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui.tsx';
import { useMediaQuery, useTheme } from '../../lib/hooks.ts';
import {
  chooseVideo,
  fullscreenElement,
  playVideo,
  resumeAt,
  type VideoChoice,
  videoLook,
} from '../../lib/use-case-video.ts';

/** Tailwind's `md`: below it the square cut fills a phone screen better than 16:9. */
const WIDE = '(min-width: 768px)';
/** How long a tab without a video stays before the next one shows. */
const SNAPSHOT_DWELL_MS = 9000;
/**
 * The page colour baked into every recording, which opens on an empty chat and an empty grid. Behind an incoming
 * video it makes the fade-in seamless, where the poster would flash the finished dashboard first. Fixed in both
 * themes, like the recordings.
 */
const RECORDING_BG = '#f9f9f7';

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
  intro,
  reduced,
  muted,
  onMutedChange,
  onEnded,
}: {
  item: UseCaseInfo;
  /** The section's first view, before any tab change: the poster shows until the first frame decodes. */
  intro: boolean;
  reduced: boolean;
  /** Shared by every tab: sound turned on stays on for the next one. */
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  /** The recording ended; false when the section stays on this tab, which then plays again. */
  onEnded: (fullscreen: boolean) => boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  /** The first frame has decoded, so the video can fade in over the box. */
  const [ready, setReady] = useState(false);
  /** The browser will not start it on its own (iOS Low Power Mode): the poster says what this tab is. */
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const wide = useMediaQuery(WIDE);
  const wanted = chooseVideo(item, !wide, failed);
  const [shown, setShown] = useState<VideoChoice | null>(wanted);
  // A tab change keeps this component and its <video>, which Safari would otherwise make muted again (see the
  // render below), so the per-tab state starts over here instead of through a remount.
  const [shownItem, setShownItem] = useState(item.id);
  if (shownItem !== item.id) {
    setShownItem(item.id);
    setShown(wanted);
    setReady(false);
    setBlocked(false);
    setPlaying(false);
  }
  /** Where the other cut continues after a rotation; tied to its source, so a tab change in between drops it. */
  const resume = useRef<{ src: string; time: number; play: boolean } | null>(null);
  const onScreen = useRef(false);
  const fullscreen = useFullscreen(wrap, ref, fullscreenButton);
  const toggleFullscreen = () => {
    fullscreen.toggle();
  };
  const start = useCallback(
    (video: HTMLVideoElement) => {
      void playVideo(
        video,
        () => onMutedChange(true),
        () => onScreen.current,
      ).then((r) => {
        if (r === 'blocked') setBlocked(true);
      });
    },
    [onMutedChange],
  );

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
    // An ended video restarts from the beginning on its next Play, so the other cut should too.
    resume.current =
      v && wantedSrc && !shownFailed
        ? { src: wantedSrc, time: v.ended ? 0 : v.currentTime, play: !v.paused }
        : null;
    setShown(wantedSrc ? { src: wantedSrc, square: wantedSquare } : null);
  }, [wantedSrc, wantedSquare, src, shownFailed, fullscreen.active]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;
    // Play only while on screen: off-screen videos cost bandwidth and battery for nothing. Observed again when the
    // source changes (a tab change or the md breakpoint), because a new source starts paused. Under reduced motion
    // nothing starts on its own, but whether the video is on screen still matters to `playVideo`.
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen.current = Boolean(entry?.isIntersecting);
        if (reduced) return;
        if (onScreen.current) start(video);
        else video.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [reduced, src, start]);

  const full = fullscreen.active;
  const square = shown?.square ?? false;
  const look = videoLook({ intro, reduced, blocked, ready, poster: item.poster ?? null });
  return (
    <>
      {/* Keyed on the tab, so two tabs without a video in a row each get their own clock. */}
      {shown ? null : <Snapshot key={item.id} item={item} reduced={reduced} onEnded={() => onEnded(false)} />}
      {/* Mounted for good, hidden behind a snapshot: Safari lets a <video> that has played with sound play with
          sound again after its source changes, while a new element needs a fresh tap. So sound turned on stays on
          from tab to tab. */}
      <div
        ref={wrap}
        hidden={!shown}
        className={cx(
          'relative overflow-hidden bg-cover bg-center',
          full ? 'bg-black' : 'rounded-xl border border-line bg-surface-2',
          // The square box stays within the viewport's height (a phone held sideways), centred.
          full ? '' : square ? 'mx-auto aspect-square w-full max-w-[80svh]' : 'aspect-video',
        )}
        // The poster stays behind the video until its first frame decodes; the 16:9 poster is cropped, never
        // stretched, in the square box. Without one, the recording's own background colour stands in.
        style={
          full
            ? undefined
            : look.poster
              ? { backgroundImage: `url("${look.poster}")` }
              : { backgroundColor: RECORDING_BG }
        }
      >
        {/* A click on the video is a mouse and touch shortcut; the full screen button is the keyboard path. */}
        <video
          ref={ref}
          src={src}
          // The square box shows the 16:9 poster as its background (cropped); as a poster it would be letterboxed.
          poster={square ? undefined : (look.poster ?? undefined)}
          muted={muted}
          playsInline
          preload="metadata"
          controls={reduced}
          onClick={reduced || full ? undefined : toggleFullscreen}
          onLoadedMetadata={(e) => {
            const r = resume.current;
            resume.current = null;
            if (!r || r.src !== e.currentTarget.getAttribute('src')) return;
            e.currentTarget.currentTime = resumeAt(r.time, e.currentTarget.duration);
            if (r.play) start(e.currentTarget);
          }}
          onLoadedData={() => setReady(true)}
          onEnded={(e) => {
            setPlaying(false);
            // Not the `loop` attribute: whether to stay is decided at the end, from what the visitor is doing then.
            // Under reduced motion a video the visitor started rests on its last frame instead of starting over.
            if (!onEnded(fullscreen.active) && !reduced) start(e.currentTarget);
          }}
          onPlay={() => setPlaying(true)}
          onPlaying={() => setReady(true)}
          onPause={() => setPlaying(false)}
          // Remembered per source: a broken square cut falls back to 16:9 before the snapshot.
          onError={(e) => {
            const failedSrc = e.currentTarget.getAttribute('src');
            if (failedSrc) setFailed((f) => new Set(f).add(failedSrc));
          }}
          aria-label={`${item.title}: screen recording of the agent building the dashboard`}
          className={cx(
            'absolute inset-0 size-full',
            full ? 'object-contain' : 'object-cover',
            !reduced && !full && 'cursor-zoom-in',
            // An incoming video fades in on its first frame, so the box never blinks black or shows the previous
            // tab's last frame. Hiding is instant; only the fade-in is animated.
            look.hidden ? 'opacity-0' : 'transition-opacity duration-200',
          )}
        />
        {reduced && !playing ? (
          <button
            type="button"
            aria-label="Play video"
            onClick={() => {
              if (ref.current) start(ref.current);
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
              const v = ref.current;
              // Unmuted and played inside the tap itself: that is what lets Safari keep the sound on this element
              // for the next tabs. Playing an already playing video changes nothing else.
              if (v) {
                v.muted = !muted;
                if (muted && !v.paused) void v.play().catch(() => {});
              }
              onMutedChange(!muted);
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
    </>
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
function Snapshot({
  item,
  reduced,
  onEnded,
}: {
  item: UseCaseInfo;
  reduced: boolean;
  onEnded: () => boolean;
}) {
  const [failed, setFailed] = useState(false);
  const theme = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(box);
  const advance = useRef(onEnded);
  advance.current = onEnded;
  /** Bumped when a dwell ends but the section stays on this tab, which starts the next dwell. */
  const [round, setRound] = useState(0);
  // Only a video's end moves the tabs on, so a tab without one needs its own clock: it runs only while the section
  // is on screen and is cleared on tab change or unmount. Under reduced motion nothing moves on its own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` restarts the clock
  useEffect(() => {
    if (reduced || !visible) return;
    const t = setTimeout(() => {
      if (!advance.current()) setRound((r) => r + 1);
    }, SNAPSHOT_DWELL_MS);
    return () => clearTimeout(t);
  }, [reduced, visible, round]);
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
