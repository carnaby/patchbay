import type { UseCaseInfo } from '@patchbay/core';

export interface VideoChoice {
  src: string;
  square: boolean;
}

/**
 * The recording to play: the square cut on narrow screens when there is one, else 16:9. A source that failed to load
 * is skipped, so a broken square file falls back to 16:9; with nothing left the caller shows the snapshot. A broken
 * 16:9 file on a wide screen does not fall back to the square cut, which a 16:9 box would crop too hard.
 */
export function chooseVideo(
  item: Pick<UseCaseInfo, 'video' | 'videoSquare'>,
  narrow: boolean,
  failed: ReadonlySet<string>,
): VideoChoice | null {
  if (narrow && item.videoSquare && !failed.has(item.videoSquare))
    return { src: item.videoSquare, square: true };
  if (item.video && !failed.has(item.video)) return { src: item.video, square: false };
  return null;
}

/**
 * Where to continue after swapping to the other cut (both have the same length). Resuming at the very end would
 * fire `ended` at once and move the tabs on, so it stays a little short of it.
 */
export function resumeAt(time: number, duration: number): number {
  if (!Number.isFinite(duration)) return time;
  return Math.max(0, Math.min(time, duration - 0.25));
}

type WebkitDocument = Document & { webkitFullscreenElement?: Element | null };

/** The element in full screen, prefixed in older Safari. */
export function fullscreenElement(): Element | null {
  const doc = document as WebkitDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export type PlayResult = 'playing' | 'blocked' | 'interrupted';

const refusedByPolicy = (e: unknown) => (e as { name?: unknown } | null)?.name === 'NotAllowedError';

/**
 * Starts the video. With sound on, a browser may refuse to play without a fresh tap (autoplay policy): the video then
 * plays muted and `onMuted` runs, so the shared sound button stays truthful. That retry happens only while
 * `stillWanted` says the video should still play: scrolled away in the meantime, it stays paused. 'blocked' means it
 * will not play on its own even muted (iOS Low Power Mode); 'interrupted' is a pause or a new source that cut the
 * start short.
 */
export async function playVideo(
  video: Pick<HTMLMediaElement, 'muted' | 'play'>,
  onMuted: () => void,
  stillWanted: () => boolean,
): Promise<PlayResult> {
  try {
    await video.play();
    return 'playing';
  } catch (e) {
    if (!refusedByPolicy(e)) return 'interrupted';
    if (video.muted) return 'blocked';
    if (!stillWanted()) return 'interrupted';
  }
  video.muted = true;
  onMuted();
  try {
    await video.play();
    return 'playing';
  } catch (e) {
    return refusedByPolicy(e) ? 'blocked' : 'interrupted';
  }
}

/**
 * The poster stays where the visitor would otherwise see nothing move: the section's first view, reduced motion and
 * a browser that will not autoplay. After a tab change it would flash the finished dashboard, while every recording
 * opens on an empty page, so there the video is hidden until its first frame instead.
 */
export function videoLook(s: {
  intro: boolean;
  reduced: boolean;
  blocked: boolean;
  /** The first frame has decoded. */
  ready: boolean;
  poster: string | null;
}): { poster: string | null; hidden: boolean } {
  const poster = (s.intro || s.reduced || s.blocked) && s.poster ? s.poster : null;
  return { poster, hidden: !poster && !s.ready };
}

/**
 * Whether an event of the persistent <video> belongs to the recording on show. On a tab that shows its snapshot the
 * element still holds the previous recording (paused, not unloaded), whose `ended`, `playing` or `loadeddata` must
 * neither move the tabs on nor start it again.
 */
export function isCurrentMediaEvent(shownSrc: string | undefined, elementSrc: string | null): boolean {
  return shownSrc !== undefined && elementSrc === shownSrc;
}
