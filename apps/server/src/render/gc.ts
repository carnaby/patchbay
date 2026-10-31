/**
 * On-demand garbage collection for the renderer.
 *
 * Rendering produces memory V8 does not account for or does not collect in time: resvg's pixmaps live in native
 * memory behind tiny JavaScript wrappers, and ECharts leaves a large graph of short-lived objects per chart. Collecting
 * at known points keeps one snapshot's peak near the cost of its biggest part instead of the sum of all parts.
 */
// The production start command passes --expose-gc (Dockerfile, `pnpm start`). Turning the flag on at run time
// instead is undocumented V8 behaviour; without the flag (dev, tests) collection is left to V8 as usual.
const gc = (globalThis as { gc?: unknown }).gc;

/** A full, synchronous collection of the JavaScript heap; a no-op when the process was started without the flag. */
export function collectGarbage() {
  if (typeof gc === 'function') (gc as () => void)();
}

/** Also lets native finalisers run: Node calls them from setImmediate, after the collection that found them. */
export async function releaseNativeMemory() {
  collectGarbage();
  await new Promise((resolve) => setImmediate(resolve));
}
