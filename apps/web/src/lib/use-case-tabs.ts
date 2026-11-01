export interface TabsState {
  active: number;
  count: number;
  /** Where the active tab came from: 1 = next (slides in from the right), -1 = previous, 0 = no change yet. */
  dir: -1 | 0 | 1;
}
export type TabsAction =
  /** `dir` when the gesture says it (arrow keys, swipes wrap around); otherwise it follows the tab order. */
  | { type: 'select'; index: number; dir?: -1 | 1 }
  /** The tab's video or its snapshot's dwell ended and `afterEnd` said to move on. */
  | { type: 'ended' }
  | { type: 'reset'; count: number };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'select':
      if (action.index < 0 || action.index >= state.count || action.index === state.active) return state;
      return { ...state, active: action.index, dir: action.dir ?? (action.index > state.active ? 1 : -1) };
    case 'ended':
      if (state.count < 2) return state;
      return { ...state, active: stepIndex(state.active, 1, state.count), dir: 1 };
    case 'reset':
      return {
        active: Math.min(state.active, Math.max(action.count - 1, 0)),
        count: action.count,
        dir: state.dir,
      };
  }
}

export interface EndContext {
  count: number;
  reduced: boolean;
  /** Ours or the iPhone's native player. */
  fullscreen: boolean;
  dialogOpen: boolean;
  /** Keyboard focus on the tabs or in the panel; a mouse click or a tap that left focus there does not count. */
  keyboardFocus: boolean;
}

/**
 * What follows the end of a tab's video (or of a snapshot's dwell): the next tab, so the section keeps cycling even
 * after a click, or the same tab again. It stays where moving on would take something away from the visitor: full
 * screen (a new tab remounts the video), the open dialog, or keyboard focus. Under reduced motion nothing moves on
 * its own.
 */
export function afterEnd(c: EndContext): 'next' | 'again' {
  if (c.count < 2 || c.reduced || c.fullscreen || c.dialogOpen || c.keyboardFocus) return 'again';
  return 'next';
}

/** True when `active` (document.activeElement) is inside one of `roots` and got there by keyboard. */
export function keyboardFocusWithin<T extends { matches(selector: string): boolean }>(
  active: T | null,
  roots: readonly ({ contains(node: NoInfer<T>): boolean } | null)[],
): boolean {
  if (!active || !roots.some((r) => r?.contains(active))) return false;
  try {
    return active.matches(':focus-visible');
  } catch {
    // Safari before 15.4 does not know the selector: the cycle goes on rather than stopping on every click.
    return false;
  }
}

/** The tab `step` places away, wrapping around like the arrow keys. */
export function stepIndex(index: number, step: -1 | 1, count: number): number {
  return (index + step + count) % count;
}

/**
 * Classifies a finished touch gesture: 1 for the next tab (finger moved left), -1 for the previous one, 0 for
 * anything else. It must be long and clearly horizontal, so a page scroll that drifts sideways is never a swipe.
 */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) <= 50 || Math.abs(dx) <= 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export interface SwipePointer {
  id: number;
  x: number;
  y: number;
  /** False for a second finger on the screen. */
  primary: boolean;
}
export type SwipeStartPoint = Omit<SwipePointer, 'primary'>;

/**
 * Where a swipe starts, or null when this touch cannot start one: a second finger means a pinch-zoom (and drops the
 * gesture in progress), and `blocked` covers places with their own sideways drag, such as native video controls.
 */
export function swipeStart(p: SwipePointer, blocked: boolean): SwipeStartPoint | null {
  if (!p.primary || blocked) return null;
  return { id: p.id, x: p.x, y: p.y };
}

/** The tab step for a finger lifted at `p`: 1 next, -1 previous, 0 not a swipe. */
export function swipeEnd(start: SwipeStartPoint | null, p: SwipePointer): -1 | 0 | 1 {
  if (!start || start.id !== p.id) return 0;
  return swipeStep(p.x - start.x, p.y - start.y);
}

/**
 * The scrollLeft that brings an item fully into a horizontally scrolling row, `margin` clear of its edges; positions
 * are in the row's scroll coordinates. Done by hand rather than with scrollIntoView, which may scroll the page too.
 */
export function revealScrollLeft(
  view: { scrollLeft: number; width: number },
  item: { start: number; width: number },
  margin: number,
): number {
  if (item.start - margin < view.scrollLeft) return Math.max(0, item.start - margin);
  if (item.start + item.width + margin > view.scrollLeft + view.width)
    return item.start + item.width + margin - view.width;
  return view.scrollLeft;
}
