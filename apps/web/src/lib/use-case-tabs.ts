export interface TabsState {
  active: number;
  count: number;
  /** Once the visitor picks a tab, the section stops moving on its own. */
  interacted: boolean;
  /** Where the active tab came from: 1 = next (slides in from the right), -1 = previous, 0 = no change yet. */
  dir: -1 | 0 | 1;
}
export type TabsAction =
  /** `dir` when the gesture says it (arrow keys, swipes wrap around); otherwise it follows the tab order. */
  | { type: 'select'; index: number; dir?: -1 | 1 }
  /** Any other deliberate act (sound, play, copy): the visitor is reading this tab, so it must stay. */
  | { type: 'interact' }
  | { type: 'ended' }
  | { type: 'reset'; count: number };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'select':
      if (action.index < 0 || action.index >= state.count) return state;
      if (action.index === state.active) return state.interacted ? state : { ...state, interacted: true };
      return {
        ...state,
        active: action.index,
        interacted: true,
        dir: action.dir ?? (action.index > state.active ? 1 : -1),
      };
    case 'interact':
      return state.interacted ? state : { ...state, interacted: true };
    case 'ended':
      if (state.interacted || state.count < 2) return state;
      return { ...state, active: stepIndex(state.active, 1, state.count), dir: 1 };
    case 'reset':
      return {
        active: Math.min(state.active, Math.max(action.count - 1, 0)),
        count: action.count,
        interacted: state.interacted,
        dir: state.dir,
      };
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
