import { describe, expect, it } from 'vitest';
import {
  revealScrollLeft,
  stepIndex,
  swipeEnd,
  swipeStart,
  swipeStep,
  tabsReducer,
} from './use-case-tabs.ts';

describe('use case tabs', () => {
  const start = { active: 0, count: 3, interacted: false, dir: 0 as const };
  it('advances on video end and wraps around until the visitor interacts', () => {
    const a = tabsReducer(start, { type: 'ended' });
    expect(a.active).toBe(1);
    expect(a.dir).toBe(1);
    const wrapped = tabsReducer({ ...start, active: 2 }, { type: 'ended' });
    expect(wrapped.active).toBe(0);
    // Wrapping to the first tab is still "next", so it slides in from the same side.
    expect(wrapped.dir).toBe(1);
  });
  it('stops auto-advancing after a manual selection', () => {
    const s = tabsReducer(start, { type: 'select', index: 2 });
    expect(s).toEqual({ active: 2, count: 3, interacted: true, dir: 1 });
    expect(tabsReducer(s, { type: 'ended' }).active).toBe(2);
  });
  it('takes the direction from the selection, or from the order of the tabs', () => {
    expect(tabsReducer({ ...start, active: 2 }, { type: 'select', index: 0 }).dir).toBe(-1);
    expect(tabsReducer({ ...start, active: 2 }, { type: 'select', index: 0, dir: 1 }).dir).toBe(1);
    expect(tabsReducer(start, { type: 'select', index: 2, dir: -1 }).dir).toBe(-1);
  });
  it('keeps the state when the active tab is selected again', () => {
    const s = tabsReducer(start, { type: 'select', index: 1 });
    expect(tabsReducer(s, { type: 'select', index: 1 })).toBe(s);
  });
  it('stops auto-advancing after any other interaction', () => {
    const s = tabsReducer(start, { type: 'interact' });
    expect(s).toEqual({ active: 0, count: 3, interacted: true, dir: 0 });
    expect(tabsReducer(s, { type: 'ended' }).active).toBe(0);
    expect(tabsReducer(s, { type: 'interact' })).toBe(s);
  });
  it('ignores out-of-range selections and clamps on reset', () => {
    expect(tabsReducer(start, { type: 'select', index: 7 })).toEqual(start);
    expect(tabsReducer({ ...start, active: 2 }, { type: 'reset', count: 1 }).active).toBe(0);
  });
});

describe('stepIndex', () => {
  it('wraps around in both directions', () => {
    expect(stepIndex(0, 1, 4)).toBe(1);
    expect(stepIndex(3, 1, 4)).toBe(0);
    expect(stepIndex(0, -1, 4)).toBe(3);
  });
});

describe('swipeStep', () => {
  it('moves to the next tab on a swipe to the left and the previous on a swipe to the right', () => {
    expect(swipeStep(-80, 10)).toBe(1);
    expect(swipeStep(80, -10)).toBe(-1);
  });
  it('ignores short moves', () => {
    expect(swipeStep(-50, 0)).toBe(0);
    expect(swipeStep(30, 0)).toBe(0);
  });
  it('ignores moves that are not clearly horizontal, so scrolling the page never switches tabs', () => {
    expect(swipeStep(-90, 60)).toBe(0);
    expect(swipeStep(-90, -61)).toBe(0);
    expect(swipeStep(-91, 60)).toBe(1);
  });
});

describe('swipe tracking', () => {
  const finger = (id: number, x: number, y: number, primary = true) => ({ id, x, y, primary });
  it('turns one finger moving sideways into a step', () => {
    const start = swipeStart(finger(1, 200, 300), false);
    expect(swipeEnd(start, finger(1, 100, 305))).toBe(1);
  });
  it('drops the gesture when a second finger lands, so a pinch-zoom is never a swipe', () => {
    const start = swipeStart(finger(1, 200, 300), false);
    const pinch = swipeStart(finger(2, 260, 300, false), false);
    expect(pinch).toBeNull();
    expect(swipeEnd(pinch, finger(1, 60, 300))).toBe(0);
    expect(start).not.toBeNull();
  });
  it('ignores a gesture that starts on a blocked element, such as native video controls', () => {
    expect(swipeStart(finger(1, 200, 300), true)).toBeNull();
  });
  it('ignores the end of another pointer', () => {
    const start = swipeStart(finger(1, 200, 300), false);
    expect(swipeEnd(start, finger(3, 60, 300))).toBe(0);
  });
});

describe('revealScrollLeft', () => {
  // A 300 px wide row scrolled to 100; the margin keeps the tab clear of the row's edge.
  const view = { scrollLeft: 100, width: 300 };
  it('leaves a tab that is already visible alone', () => {
    expect(revealScrollLeft(view, { start: 150, width: 80 }, 16)).toBe(100);
  });
  it('scrolls left to a tab cut off at the start', () => {
    expect(revealScrollLeft(view, { start: 90, width: 80 }, 16)).toBe(74);
    expect(revealScrollLeft(view, { start: 10, width: 80 }, 16)).toBe(0);
  });
  it('scrolls right to a tab cut off at the end', () => {
    expect(revealScrollLeft(view, { start: 350, width: 80 }, 16)).toBe(146);
  });
});
