import { applyOps, type DashboardDoc, type DashboardEnvelope, emptyDashboard } from '@patchbay/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from './editor.ts';
import { performSave, sameDocument } from './save.ts';

const base = emptyDashboard('Shop');

function envelope(version: number, doc: DashboardDoc = base): DashboardEnvelope {
  return {
    meta: {
      id: 'dash',
      title: doc.title,
      ownerId: null,
      visibility: 'public',
      version,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      lastViewedAt: '2026-10-26T00:00:00.000Z',
    },
    doc,
    access: { canEdit: true, isOwner: false, anonymous: true },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The same document with its keys written in reverse order, as another serialiser might. */
const reordered = (doc: DashboardDoc): DashboardDoc =>
  JSON.parse(
    JSON.stringify(doc, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    ),
  );

/** Answers the PUTs in turn: a Response, or an Error for a connection that failed. */
function server(answers: ((body: { doc: DashboardDoc }) => Response | Error)[]) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const next = answers.shift();
    if (!next) throw new Error('unexpected request');
    const answer = next(JSON.parse(String(init.body)));
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function edit() {
  useEditor.getState().apply([{ op: 'setMeta', title: 'Shop, renamed' }], 'Renamed');
  return useEditor.getState().beginSave()!;
}

describe('performSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditor.getState().load(envelope(1));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('treats a conflict with its own write as saved: the first attempt landed and only its answer was lost', async () => {
    const job = edit();
    const notify = vi.fn();
    const fetch = server([
      () => new TypeError('Failed to fetch'),
      () => json(502, { error: 'Bad gateway' }),
      // The first attempt had been applied: the base version is gone, and the server holds exactly our document.
      (body) => json(409, { error: 'The dashboard changed', current: envelope(2, reordered(body.doc)) }),
    ]);
    const done = performSave('dash', job, notify);
    expect(useEditor.getState().saving).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    const s = useEditor.getState();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(s).toMatchObject({ saving: false, version: 2, conflict: null, saveError: null });
    expect(s.saved).toBe(job.doc);
    expect(s.doc).toBe(s.saved);
    expect(notify).not.toHaveBeenCalled();
  });

  it('rebases onto a conflict that is somebody else’s change', async () => {
    const job = edit();
    const notify = vi.fn();
    const theirs = applyOps(base, [{ op: 'setMeta', description: 'By an agent' }]).doc;
    server([() => json(409, { error: 'The dashboard changed', current: envelope(2, theirs) })]);
    await performSave('dash', job, notify);
    const s = useEditor.getState();
    expect(s.version).toBe(2);
    expect(s.doc).toMatchObject({ title: 'Shop, renamed', description: 'By an agent' });
    expect(s.doc).not.toBe(s.saved);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('merged'));
  });

  it('reports a server fault at once and waits for the next edit', async () => {
    const job = edit();
    const notify = vi.fn();
    const fetch = server([() => json(500, { error: 'Internal error' })]);
    await performSave('dash', job, notify);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Could not save: Internal error', 'bad');
    expect(useEditor.getState().beginSave()).toBeNull();
  });

  it('keeps trying for about 90 s while the server cannot be reached, then reports it and starts over', async () => {
    const job = edit();
    const notify = vi.fn();
    const fetch = server(Array.from({ length: 20 }, () => () => new TypeError('Failed to fetch')));
    const done = performSave('dash', job, notify);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).not.toHaveBeenCalled();
    expect(useEditor.getState().saving).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    // At 0, 2, 6, 14, 30, 60 and 90 s.
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(notify).toHaveBeenCalledWith('Could not save: The server could not be reached', 'bad');
    expect(useEditor.getState().beginSave()?.doc).toBe(job.doc);
  });

  it('stops retrying when the editor opens another dashboard meanwhile', async () => {
    const job = edit();
    const fetch = server([() => json(503, { error: 'Busy' }, { 'retry-after': '5' })]);
    const done = performSave('dash', job, vi.fn());
    useEditor.getState().load(envelope(7));
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useEditor.getState().version).toBe(7);
  });
});

describe('sameDocument', () => {
  it('ignores the order of keys, nothing else', () => {
    const doc = applyOps(base, [{ op: 'setMeta', description: 'x' }]).doc;
    expect(sameDocument(doc, reordered(doc))).toBe(true);
    expect(sameDocument(doc, { ...doc, description: 'y' })).toBe(false);
  });
});
