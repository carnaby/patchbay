import { describe, expect, it } from 'vitest';
import {
  gridHeight,
  hasStandardZoom,
  presentationContentHeight,
  presentationFit,
  presentationWarning,
} from './presentation-scale.ts';

const rows = (n: number) => [{ i: 'a', x: 0, y: 0, w: 6, h: n }];
// 7 rows: 7 × 80 + 6 × 12 = 632, + 24 padding = 656. 20 rows: 1828 + 24 = 1852.
const SHORT = presentationContentHeight(rows(7), false);
const TALL = presentationContentHeight(rows(20), false);

describe('presentation scale', () => {
  it('measures the grid from its rows', () => {
    expect(gridHeight([])).toBe(0);
    expect(
      gridHeight([
        { y: 0, h: 4 },
        { y: 2, h: 5 },
      ]),
    ).toBe(632);
    expect([SHORT, TALL, presentationContentHeight(rows(7), true)]).toEqual([656, 1852, 680]);
  });

  it('grows a short dashboard to the width of a 1080p TV, laid out at 1280', () => {
    expect(presentationFit({ width: 1920, height: 1080 }, SHORT)).toEqual({ layoutWidth: 1280, scale: 1.5 });
  });

  it('shrinks a tall one below 100 % so it fits the height, still 1280 wide with side bands', () => {
    const fit = presentationFit({ width: 1920, height: 1080 }, TALL)!;
    expect(fit.layoutWidth).toBe(1280);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale * TALL).toBeLessThanOrEqual(1080);
    expect(fit.scale).toBeCloseTo(1080 / 1852, 2);
    expect(fit.layoutWidth * fit.scale).toBeLessThan(1920);
  });

  it('triples a short dashboard on a 4K screen', () => {
    expect(presentationFit({ width: 3840, height: 2160 }, SHORT)).toEqual({ layoutWidth: 1280, scale: 3 });
  });

  it('keeps a portrait tablet at its own width and full size unless the dashboard is taller than the screen', () => {
    expect(presentationFit({ width: 800, height: 1280 }, SHORT)).toEqual({ layoutWidth: 800, scale: 1 });
    const tall = presentationFit({ width: 800, height: 1280 }, TALL)!;
    expect([tall.layoutWidth, tall.scale < 1, tall.scale * TALL <= 1280]).toEqual([800, true, true]);
  });

  it('leaves a phone to the stacked layout', () => {
    expect(presentationFit({ width: 390, height: 844 }, SHORT)).toBeNull();
  });

  it('leaves a screen whose grid would stack to the stacked layout', () => {
    expect(presentationFit({ width: 740, height: 1000 }, SHORT)).toBeNull();
  });

  it('uses only the width term for an empty dashboard', () => {
    expect(presentationFit({ width: 1920, height: 1080 }, 0)).toEqual({ layoutWidth: 1280, scale: 1.5 });
  });

  it('warns only when a 1080p TV would show the dashboard below 100 %', () => {
    expect(presentationWarning(rows(11), false)).toBeNull(); // 1024 tall
    expect(presentationWarning(rows(12), false)).toBe(
      'On a 1080p TV this dashboard is shown at 96%: it is taller than one screen.',
    ); // 1116 tall: 0.967
    expect(presentationWarning(rows(20), false)).toBe(
      'On a 1080p TV this dashboard is shown at 58%: it is taller than one screen.',
    );
  });

  it('scales only where the standardized zoom model exists', () => {
    expect(hasStandardZoom({})).toBe(false);
    expect(hasStandardZoom({ currentCSSZoom: 1 })).toBe(true);
    expect(hasStandardZoom(undefined)).toBe(false);
  });
});
