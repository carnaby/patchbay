import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { interTextWidth, truncateToWidth } from './measure.ts';

const fontFiles = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map((f) =>
  fileURLToPath(new URL(`./fonts/${f}`, import.meta.url)),
);
/** What resvg actually draws: the right edge of the text's bounding box. */
function drawn(text: string, size: number, weight = 400): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="60"><text x="0" y="40" font-family="Inter" font-weight="${weight}" font-size="${size}">${text}</text></svg>`;
  const box = new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Inter' },
  }).getBBox();
  return box ? box.x + box.width : 0;
}

describe('text measure for snapshots', () => {
  it('measures labels as wide as resvg draws them in Inter, never narrower by more than a pixel', () => {
    for (const label of ['@modelcontextprotocol/sdk', '@anthropic-ai/sdk', 'Downloads per day', '1.9B']) {
      const real = drawn(label, 12);
      const measured = interTextWidth(label, '12px Inter, sans-serif');
      expect(measured, label).toBeGreaterThanOrEqual(real - 1);
      expect(measured, label).toBeLessThan(real * 1.05);
    }
  });

  it('reads the size and the weight from the font string', () => {
    expect(interTextWidth('Revenue', 'bold 14px Inter')).toBeGreaterThan(
      interTextWidth('Revenue', '14px Inter'),
    );
    expect(interTextWidth('Revenue', '24px Inter')).toBeCloseTo(
      interTextWidth('Revenue', '12px Inter') * 2,
      0,
    );
  });

  it('measures characters outside ASCII on first use', () => {
    expect(interTextWidth('Žluťoučký', '12px Inter')).toBeGreaterThan(
      interTextWidth('Zlutoucky', '12px Inter') * 0.9,
    );
    expect(interTextWidth('\u0001', '12px Inter')).toBe(0);
  });

  describe('truncateToWidth', () => {
    const font = '400 13px Inter';
    // The longest prefix whose width with the ellipsis fits, but at least one character: the definition to match.
    const reference = (value: string, max: number) => {
      if (interTextWidth(value, font) <= max) return value;
      const chars = [...value];
      let keep = chars.length - 1;
      while (keep > 1 && interTextWidth(`${chars.slice(0, keep).join('')}…`, font) > max) keep--;
      return `${chars.slice(0, Math.max(1, keep)).join('')}…`;
    };

    it('gives the same cut as measuring every prefix, for short strings', () => {
      for (const value of [
        '',
        'abc',
        'WWWWWWWWWWWWWWWW',
        '0123456789 0123456789',
        'Žluťoučký kůň',
        '😀😀😀😀😀😀😀😀',
      ])
        for (const max of [0, 5, 20, 60, 110, 400])
          expect(truncateToWidth(value, max, font), `${value}@${max}`).toBe(reference(value, max));
    });

    it('measures only the characters up to the cut, so a huge cell is cheap', () => {
      const started = performance.now();
      const cut = truncateToWidth('W'.repeat(50_000), 120, font);
      expect(performance.now() - started).toBeLessThan(200);
      expect(cut.endsWith('…')).toBe(true);
      expect(cut.length).toBeLessThan(20);
    });
  });
});
