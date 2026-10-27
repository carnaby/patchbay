import { applyOps, type DashboardEnvelope, emptyDashboard, readingOrder } from '@patchbay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from './editor.ts';
import { reorderOp } from './reorder.ts';

const text = (id: string) => ({ id, type: 'text', config: { markdown: id } });
// Two rows of KPI-sized tiles under a full-width chart-sized block, the shape of a typical dashboard.
const base = applyOps(emptyDashboard('Stack'), [
  { op: 'addWidget', widget: text('a'), position: { w: 3, h: 2 } },
  { op: 'addWidget', widget: text('b'), position: { w: 3, h: 2 } },
  { op: 'addWidget', widget: text('c'), position: { w: 3, h: 2 } },
  { op: 'addWidget', widget: text('d'), position: { w: 12, h: 4 } },
]).doc;

function envelope(version: number, doc = base): DashboardEnvelope {
  return {
    meta: {
      id: 'dash',
      title: doc.title,
      ownerId: 'u1',
      visibility: 'private',
      version,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      lastViewedAt: '2026-10-26T00:00:00.000Z',
    },
    doc,
    access: { canEdit: true, isOwner: true, anonymous: false },
  };
}

const order = () => readingOrder(useEditor.getState().doc!.layout);
const move = (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => {
  const op = reorderOp(useEditor.getState().doc!.layout, id, direction);
  if (!op) throw new Error('expected a move');
  return useEditor.getState().apply([op], 'Moved widget');
};

describe('reorderOp', () => {
  it('maps each direction to a position in reading order', () => {
    expect(reorderOp(base.layout, 'c', 'up')).toEqual({ op: 'reorderWidget', id: 'c', before: 'b' });
    expect(reorderOp(base.layout, 'a', 'down')).toEqual({ op: 'reorderWidget', id: 'a', before: 'c' });
    expect(reorderOp(base.layout, 'c', 'down')).toEqual({ op: 'reorderWidget', id: 'c', before: null });
    expect(reorderOp(base.layout, 'd', 'top')).toEqual({ op: 'reorderWidget', id: 'd', before: 'a' });
    expect(reorderOp(base.layout, 'a', 'bottom')).toEqual({ op: 'reorderWidget', id: 'a', before: null });
  });

  it('offers nothing at the ends or for unknown widgets', () => {
    expect(reorderOp(base.layout, 'a', 'up')).toBeNull();
    expect(reorderOp(base.layout, 'a', 'top')).toBeNull();
    expect(reorderOp(base.layout, 'd', 'down')).toBeNull();
    expect(reorderOp(base.layout, 'd', 'bottom')).toBeNull();
    expect(reorderOp(base.layout, 'zzz', 'up')).toBeNull();
  });
});

describe('reordering in the editor', () => {
  beforeEach(() => useEditor.getState().load(envelope(1)));

  it('swaps neighbours on the desktop grid and undoes exactly', () => {
    expect(move('b', 'up')).toBeNull();
    expect(order()).toEqual(['b', 'a', 'c', 'd']);
    const layout = useEditor.getState().doc!.layout;
    expect(layout.find((l) => l.i === 'b')).toMatchObject({ x: 0, y: 0 });
    expect(layout.find((l) => l.i === 'a')).toMatchObject({ x: 3, y: 0 });
    useEditor.getState().undo();
    expect(useEditor.getState().doc).toBe(base);
    useEditor.getState().redo();
    expect(order()).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves the wide block above the tiles, keeping every size', () => {
    move('d', 'top');
    expect(order()).toEqual(['d', 'a', 'b', 'c']);
    const sizes = useEditor.getState().doc!.layout.map(({ i, w, h }) => ({ i, w, h }));
    expect(sizes).toEqual(base.layout.map(({ i, w, h }) => ({ i, w, h })));
  });

  it('replays a pending move on top of a version someone else saved meanwhile', () => {
    move('c', 'top');
    const theirs = applyOps(base, [{ op: 'addWidget', widget: text('e'), position: { w: 3, h: 2 } }]).doc;
    expect(useEditor.getState().rebaseOnto(envelope(2, theirs))).toBe('rebased');
    expect(order()).toEqual(['c', 'a', 'b', 'e', 'd']);
  });
});
