import { type DatasetResult, emptyDashboard, inferTable, parseDashboard, WidgetSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { renderDashboardPng, renderWidgetPng } from './snapshot.ts';
import { RenderFailedError, type RenderTask, RenderWorker } from './worker-host.ts';

const FIXTURE = new URL('./worker.fixture.ts', import.meta.url);

/** A task for the fixture worker, which acts on the widget id. */
const task = (id: string): RenderTask => ({
  kind: 'widget',
  widget: WidgetSchema.parse({ id, type: 'text', config: { markdown: 'x' } }),
  result: undefined,
  options: {},
});

const rows = Array.from({ length: 10_000 }, (_, i) => ({
  x: i,
  y: Math.sin(i / 50) * 100 + (i % 37),
  z: (i * 7919) % 1000,
  s: `s${i % 12}`,
}));
const results = new Map<string, DatasetResult>([
  [
    'u',
    {
      datasetId: 'u',
      table: inferTable(rows),
      fetchedAt: new Date(0).toISOString(),
      hash: 'u',
      truncated: false,
    },
  ],
]);
const KINDS = ['scatter', 'line', 'bar', 'heatmap', 'area', 'scatter'];

/** The shape of the dashboard that stalled production: one upload, many charts asking for every row. */
function heavyDashboard(count: number) {
  const widgets = Array.from({ length: count }, (_, i) => ({
    id: `w${i}`,
    type: 'chart' as const,
    title: `Chart ${i}`,
    datasetId: 'u',
    config: {
      kind: KINDS[i % KINDS.length],
      x: 'x',
      y: ['y', 'z'],
      ...(i % 3 === 0 ? { series: 's' } : {}),
      maxPoints: 20_000,
    },
  }));
  return parseDashboard({
    ...emptyDashboard('Heavy'),
    datasets: [{ id: 'u', name: 'u', source: { kind: 'inline', rows: [] } }],
    widgets,
    layout: widgets.map((w, i) => ({ i: w.id, x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 })),
  });
}

/** The longest stretch the main thread's event loop could not run a timer while `work` was going on. */
async function longestStall(work: Promise<unknown>) {
  let last = Date.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await work;
  } finally {
    clearInterval(timer);
  }
  return Math.max(longest, Date.now() - last);
}

describe('render worker', () => {
  it('draws exactly what the renderer draws on this thread', async () => {
    const host = new RenderWorker();
    try {
      const doc = heavyDashboard(6);
      const widget = doc.widgets[0]!;
      const result = results.get('u');
      const viaWorker = await host.render({ kind: 'widget', widget, result, options: { theme: 'dark' } });
      expect(viaWorker.equals(renderWidgetPng(widget, result, { theme: 'dark' }))).toBe(true);
      const page = await host.render({ kind: 'dashboard', doc, results, options: {} });
      expect(page.equals(renderDashboardPng(doc, results))).toBe(true);
    } finally {
      await host.close();
    }
  }, 30_000);

  it('keeps the main thread responsive while it draws a heavy dashboard', async () => {
    const host = new RenderWorker();
    try {
      // Start-up (loading ECharts) is not what this measures.
      await host.render(task('warm-up'));
      const doc = heavyDashboard(24);
      const started = Date.now();
      const stall = await longestStall(host.render({ kind: 'dashboard', doc, results, options: {} }));
      const took = Date.now() - started;
      // On this thread the render blocked for its whole duration, seconds; now only copying the table over remains.
      expect(took).toBeGreaterThan(stall * 4);
      expect(stall).toBeLessThan(250);
    } finally {
      await host.close();
    }
  }, 30_000);

  it('stops a render that takes too long and serves the next one from a fresh worker', async () => {
    const host = new RenderWorker({ url: FIXTURE, timeoutMs: 300 });
    try {
      const started = Date.now();
      let failure: unknown;
      const stall = await longestStall(
        host.render(task('hang')).catch((e: unknown) => {
          failure = e;
        }),
      );
      expect(failure).toBeInstanceOf(RenderFailedError);
      expect((failure as RenderFailedError).message).toMatch(/longer than 0.3 s/);
      // Remembered by the snapshot cache: the same render would only time out again.
      expect((failure as RenderFailedError).lasting).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(stall).toBeLessThan(250);
      // The 300 ms limit was only for the hanging render; the follow-up includes a worker start-up.
      Object.assign(host, { timeoutMs: 60_000 });
      expect((await host.render(task('next'))).toString()).toBe('next');
      expect(host.starts()).toBe(2);
    } finally {
      await host.close();
    }
  });

  it('replaces a worker that runs out of heap', async () => {
    const host = new RenderWorker({ url: FIXTURE, oldGenerationMb: 32 });
    try {
      const failure = await host.render(task('hog')).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(RenderFailedError);
      expect((failure as RenderFailedError).message).toMatch(/more memory/);
      expect((await host.render(task('after'))).toString()).toBe('after');
      expect(host.starts()).toBe(2);
    } finally {
      await host.close();
    }
  }, 30_000);

  it('passes a renderer error on and keeps the worker', async () => {
    const host = new RenderWorker({ url: FIXTURE });
    try {
      await expect(host.render(task('throw'))).rejects.toThrow('cannot draw this');
      expect((await host.render(task('fine'))).toString()).toBe('fine');
      expect(host.starts()).toBe(1);
    } finally {
      await host.close();
    }
  });

  it('renders one task after the other, in order', async () => {
    const host = new RenderWorker({ url: FIXTURE });
    try {
      const done = await Promise.all(['a', 'b', 'c'].map((id) => host.render(task(id))));
      expect(done.map(String)).toEqual(['a', 'b', 'c']);
    } finally {
      await host.close();
    }
  });

  it('stops when idle or worn, and starts again when asked', async () => {
    const idle = new RenderWorker({ url: FIXTURE, idleMs: 30 });
    try {
      await idle.render(task('one'));
      expect(idle.running()).toBe(true);
      for (let i = 0; i < 100 && idle.running(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(idle.running()).toBe(false);
      expect((await idle.render(task('two'))).toString()).toBe('two');
      expect(idle.starts()).toBe(2);
    } finally {
      await idle.close();
    }
    const worn = new RenderWorker({ url: FIXTURE, maxRenders: 2 });
    try {
      for (const id of ['1', '2', '3']) await worn.render(task(id));
      expect(worn.starts()).toBe(2);
    } finally {
      await worn.close();
    }
  });
});
