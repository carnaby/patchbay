export interface TabsState {
  active: number;
  count: number;
  /** Once the visitor picks a tab, the section stops moving on its own. */
  interacted: boolean;
}
export type TabsAction =
  | { type: 'select'; index: number }
  /** Any other deliberate act (sound, play, copy): the visitor is reading this tab, so it must stay. */
  | { type: 'interact' }
  | { type: 'ended' }
  | { type: 'reset'; count: number };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'select':
      if (action.index < 0 || action.index >= state.count) return state;
      return { ...state, active: action.index, interacted: true };
    case 'interact':
      return state.interacted ? state : { ...state, interacted: true };
    case 'ended':
      if (state.interacted || state.count < 2) return state;
      return { ...state, active: (state.active + 1) % state.count };
    case 'reset':
      return {
        active: Math.min(state.active, Math.max(action.count - 1, 0)),
        count: action.count,
        interacted: state.interacted,
      };
  }
}
