/**
 * Reordering on small screens. Phones show the one 12-column grid as a single stack in reading order, so the only
 * layout edit that makes sense there is moving a widget within that order. Each move is a `reorderWidget` op, so it
 * is undoable, autosaved and replayed by id when someone else saved in between.
 */
import { type LayoutItem, type OpInput, readingOrder } from '@patchbay/core';

export type MoveDirection = 'up' | 'down' | 'top' | 'bottom';

export const MOVE_LABELS: Record<MoveDirection, string> = {
  up: 'Move up',
  down: 'Move down',
  top: 'Move to top',
  bottom: 'Move to bottom',
};

/** The op for a move, or null when the widget is already there (first, last, unknown). */
export function reorderOp(layout: LayoutItem[], id: string, direction: MoveDirection): OpInput | null {
  const order = readingOrder(layout);
  const index = order.indexOf(id);
  if (index < 0) return null;
  const last = order.length - 1;
  if ((direction === 'up' || direction === 'top') && index === 0) return null;
  if ((direction === 'down' || direction === 'bottom') && index === last) return null;
  const before =
    direction === 'up'
      ? order[index - 1]!
      : direction === 'top'
        ? order[0]!
        : direction === 'down'
          ? (order[index + 2] ?? null)
          : null;
  return { op: 'reorderWidget', id, before };
}
