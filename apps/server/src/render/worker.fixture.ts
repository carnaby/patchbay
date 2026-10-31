/**
 * A stand-in render worker for tests of the host (worker-host.test.ts): it speaks the real worker's protocol, but a
 * widget's id says what to do. "hang" never answers, "hog" allocates until the heap limit stops it, "throw" fails,
 * anything else answers at once with the id as the "image".
 */
import { parentPort } from 'node:worker_threads';
import type { RenderTask } from './worker-host.ts';

parentPort!.on('message', ({ id, task }: { id: number; task: RenderTask }) => {
  const what = task.kind === 'widget' ? task.widget.id : 'dashboard';
  if (what === 'hang') for (;;);
  if (what === 'hog') {
    const kept: number[][] = [];
    for (;;) kept.push(Array.from({ length: 100_000 }, (_, i) => i));
  }
  if (what === 'throw') {
    parentPort!.postMessage({ id, ok: false, message: 'cannot draw this' });
    return;
  }
  parentPort!.postMessage({ id, ok: true, png: new TextEncoder().encode(what) });
});

parentPort!.postMessage({ ready: true });
