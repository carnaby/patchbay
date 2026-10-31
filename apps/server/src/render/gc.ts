/**
 * On-demand garbage collection for the renderer.
 *
 * Rendering produces memory V8 does not account for or does not collect in time: resvg's pixmaps live in native
 * memory behind tiny JavaScript wrappers, and ECharts leaves a large graph of short-lived objects per chart. Collecting
 * at known points keeps one snapshot's peak near the cost of its biggest part instead of the sum of all parts.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

function exposeGc(): (() => void) | null {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === 'function') return existing;
  try {
    // Only contexts created after the flag see `gc`; the main context and its globals stay as they were.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as unknown;
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

const gc = exposeGc();

/** A full, synchronous collection of the JavaScript heap; a no-op where the runtime refuses to expose it. */
export function collectGarbage() {
  gc?.();
}

/** Also lets native finalisers run: Node calls them from setImmediate, after the collection that found them. */
export async function releaseNativeMemory() {
  collectGarbage();
  await new Promise((resolve) => setImmediate(resolve));
}
