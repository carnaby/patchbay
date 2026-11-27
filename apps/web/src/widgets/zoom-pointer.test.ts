import { describe, expect, it } from 'vitest';
import { eventPoint, zoomedLocalPoint } from './zoom-pointer.ts';

const rect = { left: 100, top: 40 };

describe('pointer position inside a zoomed chart', () => {
  it('turns a visual position into the chart’s own unzoomed pixels', () => {
    // Bar 1 of four across 1280 px, at zoom 1.5: visual 720 is local 480.
    expect(zoomedLocalPoint(720, 300, { left: 0, top: 0 }, 1.5)).toEqual({ x: 480, y: 200 });
    expect(zoomedLocalPoint(400, 190, rect, 1.5)).toEqual({ x: 200, y: 100 });
    expect(zoomedLocalPoint(400, 190, rect, 1)).toEqual({ x: 300, y: 150 });
    expect(zoomedLocalPoint(70, 40, rect, 0.5)).toEqual({ x: -60, y: 0 });
  });

  it('reads the touch zrender reads: the target touch, or the lifted one at touchend', () => {
    const move = { type: 'touchmove', clientX: 0, clientY: 0, targetTouches: [{ clientX: 5, clientY: 6 }] };
    expect(eventPoint(move)).toEqual({ clientX: 5, clientY: 6 });
    const end = {
      type: 'touchend',
      targetTouches: [],
      changedTouches: [{ clientX: 7, clientY: 8 }],
    };
    expect(eventPoint(end)).toEqual({ clientX: 7, clientY: 8 });
    expect(eventPoint({ type: 'touchstart', targetTouches: [], changedTouches: [] })).toBeNull();
    expect(eventPoint({ type: 'pointermove', clientX: 1, clientY: 2 })).toEqual({ clientX: 1, clientY: 2 });
  });
});
