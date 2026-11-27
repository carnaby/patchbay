import type { LayoutItem } from '@patchbay/core';

// The grid and the scale share these numbers, so they live in one place.
export const REFERENCE_WIDTH = 1280;
export const ROW_HEIGHT = 80;
export const GRID_MARGIN = 12;
export const MOBILE_BREAKPOINT = 720;
/** The `py-3` of the presentation's <main>. */
export const PRESENTATION_PAD_Y = 12;
/** The filter summary line: `text-xs` 16 px + `mb-2` 8 px. */
export const SUMMARY_HEIGHT = 24;

// Side padding of the presentation page (px-4); the grid stacks by its container width, not the screen's.
const PAD_X = 16;

/** Rows have a fixed height, so the grid's height does not depend on its width. */
export function gridHeight(layout: readonly Pick<LayoutItem, 'y' | 'h'>[]): number {
  let rows = 0;
  for (const item of layout) rows = Math.max(rows, item.y + item.h);
  return rows === 0 ? 0 : rows * ROW_HEIGHT + (rows - 1) * GRID_MARGIN;
}

export function presentationContentHeight(
  layout: readonly Pick<LayoutItem, 'y' | 'h'>[],
  summary: boolean,
): number {
  return 2 * PRESENTATION_PAD_Y + (summary ? SUMMARY_HEIGHT : 0) + gridHeight(layout);
}

export interface PresentationFit {
  layoutWidth: number;
  scale: number;
}

/** Null when the grid would stack (a phone): that layout scrolls, as it always did. */
export function presentationFit(
  screen: { width: number; height: number },
  contentHeight: number,
): PresentationFit | null {
  const layoutWidth = Math.min(screen.width, REFERENCE_WIDTH);
  if (layoutWidth - 2 * PAD_X < MOBILE_BREAKPOINT) return null;
  const byWidth = Math.max(screen.width / REFERENCE_WIDTH, 1);
  const scale = contentHeight > 0 ? Math.min(byWidth, screen.height / contentHeight) : byWidth;
  // Floor, so content x scale never exceeds the screen by a rounding error (a 1 px overflow brings a scrollbar).
  return { layoutWidth, scale: Math.floor(scale * 1000) / 1000 };
}

export function presentationWarning(
  layout: readonly Pick<LayoutItem, 'y' | 'h'>[],
  summary: boolean,
): string | null {
  const fit = presentationFit({ width: 1920, height: 1080 }, presentationContentHeight(layout, summary));
  if (!fit || fit.scale >= 1) return null;
  return `On a 1080p TV this dashboard is shown at ${Math.floor(fit.scale * 100)}%: it is taller than one screen.`;
}

/**
 * `currentCSSZoom` shipped together with the standardized `zoom` model (Chrome/Edge 128, Firefox 126), so its
 * presence tells the new model (unzoomed sizes, visual getBoundingClientRect) from the legacy one, without measuring.
 */
export function hasStandardZoom(proto: object | undefined = globalThis.Element?.prototype): boolean {
  return proto !== undefined && 'currentCSSZoom' in proto;
}
