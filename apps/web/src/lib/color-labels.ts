import { type Color, contrastRatio, isHexColor, MARK_CONTRAST, THEMES } from '@patchbay/core';

/** "accent-3" → "Accent 3", "positive" → "Positive", hex as written (lowercase). */
export function colorName(color: Color | undefined): string {
  if (!color) return 'Automatic';
  if (isHexColor(color)) return color.toLowerCase();
  const accent = /^accent-(\d)$/.exec(color);
  return accent ? `Accent ${accent[1]}` : color[0]!.toUpperCase() + color.slice(1);
}

/**
 * A custom colour's contrast against the card in both themes, and where it is hard to see. Named colours need no
 * such note: they adapt per theme.
 */
export function contrastNote(hex: string): { text: string; poor: boolean } {
  const light = contrastRatio(hex, THEMES.light.surface);
  const dark = contrastRatio(hex, THEMES.dark.surface);
  const bad = [light < MARK_CONTRAST && 'light', dark < MARK_CONTRAST && 'dark'].filter(Boolean);
  // The two cards are far apart in lightness, so no colour fails on both: one mode is named.
  const where = `in ${bad[0]} mode`;
  return {
    text: `${light.toFixed(1)}:1 light · ${dark.toFixed(1)}:1 dark${bad.length ? ` — hard to see ${where}` : ''}`,
    poor: bad.length > 0,
  };
}
