import { describe, expect, it } from 'vitest';
import { colorName, contrastNote } from './color-labels.ts';

describe('colour picker labels', () => {
  it('names tokens for screen readers and keeps hex as written', () => {
    expect(colorName('accent-3')).toBe('Accent 3');
    expect(colorName('positive')).toBe('Positive');
    expect(colorName('#FAB219')).toBe('#fab219');
    expect(colorName(undefined)).toBe('Automatic');
  });

  it('shows the contrast of a custom colour in both themes and where it is hard to see', () => {
    // A pale yellow: fine on the dark card, nearly invisible on the light one.
    const pale = contrastNote('#f5e050');
    expect(pale.text).toMatch(/^1\.\d:1 light · \d+\.\d:1 dark — hard to see in light mode$/);
    expect(pale.poor).toBe(true);
    // A very dark blue: the reverse.
    expect(contrastNote('#101830').text).toMatch(/hard to see in dark mode$/);
    // A mid grey reaches 3:1 on both cards.
    expect(contrastNote('#808080')).toMatchObject({ poor: false });
    expect(contrastNote('#808080').text).not.toMatch(/hard to see/);
  });
});
