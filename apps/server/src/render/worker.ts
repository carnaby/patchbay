/**
 * The render worker: draws snapshots off the main thread (render/worker-host.ts starts and stops it). Receives
 * { id, task } and answers { id, ok: true, png } or { id, ok: false, message }.
 */
import { parentPort } from 'node:worker_threads';
import { releaseNativeMemory } from './gc.ts';
import { renderDashboardPng, renderWidgetPng } from './snapshot.ts';
import type { RenderTask } from './worker-host.ts';

/** The image as a copy in JavaScript memory: resvg's own buffer is native memory and cannot be transferred. */
function draw(task: RenderTask): Uint8Array {
  const png =
    task.kind === 'widget'
      ? renderWidgetPng(task.widget, task.result, task.options)
      : renderDashboardPng(task.doc, task.results, task.options);
  return new Uint8Array(png);
}

parentPort!.on('message', async ({ id, task }: { id: number; task: RenderTask }) => {
  let reply: { id: number; ok: boolean; png?: Uint8Array; message?: string };
  try {
    reply = { id, ok: true, png: draw(task) };
  } catch (e) {
    reply = { id, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  // resvg frees its pixmaps only when V8 collects their wrappers, and V8 does not see that memory. Releasing it before
  // answering keeps the next render from starting on top of this one's leftovers.
  await releaseNativeMemory();
  parentPort!.postMessage(reply, reply.png ? [reply.png.buffer as ArrayBuffer] : []);
});

// Readiness only after the imports above (ECharts, the world map, resvg) loaded, so render time limits never include
// start-up.
parentPort!.postMessage({ ready: true });
