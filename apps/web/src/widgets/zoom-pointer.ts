/** Pointer positions for a chart inside the zoomed presentation page (see EChart.tsx for why zrender needs them). */

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

interface PointerLike {
  type: string;
  clientX?: number;
  clientY?: number;
  targetTouches?: ArrayLike<ClientPoint>;
  changedTouches?: ArrayLike<ClientPoint>;
}

/**
 * The chart's own (unzoomed) pixels for a visual position. From clientX and the visual rect rather than by dividing
 * offsetX, so it stays right should a browser ever report offsetX unzoomed.
 */
export function zoomedLocalPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

/** The position zrender itself would read from this event: for touch, the target touch, at touchend the lifted one. */
export function eventPoint(e: PointerLike): ClientPoint | null {
  if (!e.type.startsWith('touch')) {
    return e.clientX === undefined || e.clientY === undefined
      ? null
      : { clientX: e.clientX, clientY: e.clientY };
  }
  const touch = e.type === 'touchend' ? e.changedTouches?.[0] : e.targetTouches?.[0];
  return touch ? { clientX: touch.clientX, clientY: touch.clientY } : null;
}
