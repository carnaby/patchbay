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
