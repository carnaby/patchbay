import { describe, expect, it } from 'vitest';
import { tabsReducer } from './use-case-tabs.ts';

describe('use case tabs', () => {
  const start = { active: 0, count: 3, interacted: false };
  it('advances on video end and wraps around until the visitor interacts', () => {
    const a = tabsReducer(start, { type: 'ended' });
    expect(a.active).toBe(1);
    expect(tabsReducer({ ...start, active: 2 }, { type: 'ended' }).active).toBe(0);
  });
  it('stops auto-advancing after a manual selection', () => {
    const s = tabsReducer(start, { type: 'select', index: 2 });
    expect(s).toEqual({ active: 2, count: 3, interacted: true });
    expect(tabsReducer(s, { type: 'ended' }).active).toBe(2);
  });
  it('ignores out-of-range selections and clamps on reset', () => {
    expect(tabsReducer(start, { type: 'select', index: 7 })).toEqual(start);
    expect(tabsReducer({ ...start, active: 2 }, { type: 'reset', count: 1 }).active).toBe(0);
  });
});
