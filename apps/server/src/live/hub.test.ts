import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardDoc, DatasetSchema, LIMITS, type LiveEvent } from '@patchbay/core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { DataService } from '../services/data.ts';
import { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';
import { BusyError } from '../util/gate.ts';
import { LiveHub } from './hub.ts';

const dir = mkdtempSync(join(tmpdir(), 'patchbay-hub-test-'));
const data = new DataService(new ConnectorService({ offline: true }), new FolderStore(dir));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const doc = (datasets: unknown[]) =>
  ({
    title: 't',
    datasets: datasets.map((d) => DatasetSchema.parse(d)),
    widgets: [],
  }) as unknown as DashboardDoc;
const viewer = (send: (e: LiveEvent) => void = () => {}) => ({
  send,
  close: () => {},
  principal: { user: null, isAdmin: false, viaToken: false },
});
// Every timer the hub and the mocks wait on is fake, so a test moves time only by awaiting `advance`: no real clock,
// so a loaded machine cannot reorder anything. Date stays real (connector cache times, reading stamps).
const useFakeTimers = () =>
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'],
  });
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = () => advance(10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reading = (v: number) => ({
  table: { columns: [{ name: 'v', type: 'number' as const }], rows: [{ v }] },
  fetchedAt: Date.now(),
  credentialKey: '',
});
/** What was pushed for a dataset: its values joined, or "error". */
const pushedFor = (events: LiveEvent[], id: string) =>
  events.flatMap((e) =>
    e.type === 'data' && e.result.datasetId === id
      ? [e.result.error ? 'error' : e.result.table.rows.map((r) => r.v).join(',')]
      : [],
  );
/** Two live readings and a union of them, the shape where two loops meet. */
const twoLive = () =>
  doc([
    { id: 'a', name: 'A', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
    { id: 'b', name: 'B', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
    {
      id: 'c',
      name: 'C',
      source: { kind: 'dataset', id: 'a' },
      transforms: [{ type: 'union', with: ['b'] }],
    },
  ]);
/** Two live readings, each with a child of its own: two chains with nothing in common. */
const separate = () =>
  doc([
    { id: 'a', name: 'A', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
    { id: 'ka', name: 'KA', source: { kind: 'dataset', id: 'a' } },
    { id: 'x', name: 'X', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
    { id: 'kx', name: 'KX', source: { kind: 'dataset', id: 'x' } },
  ]);
/** Union runs take `delay(call)` ms; returns the most union runs seen at once. */
const slowUnions = (delay: (call: number) => number) => {
  const run = data.processShared.bind(data);
  let calls = 0;
  let inFlight = 0;
  const seen = { max: 0, reset: () => (calls = 0) };
  vi.spyOn(data, 'processShared').mockImplementation(async (...args: Parameters<typeof run>) => {
    if (!args[1].some((t) => t.type === 'union')) return run(...args);
    seen.max = Math.max(seen.max, ++inFlight);
    try {
      await sleep(delay(calls++));
      return await run(...args);
    } finally {
      inFlight--;
    }
  });
  return seen;
};

describe('LiveHub', () => {
  it('schedules no refresh for uploads and inline rows, and HTTP no faster than its cache', async () => {
    useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: doc([
        { id: 'u', name: 'u', source: { kind: 'upload', fileId: 'f_x' }, refreshSec: 1 },
        { id: 'i', name: 'i', source: { kind: 'inline', rows: [{ a: 1 }] }, refreshSec: 1 },
        { id: 'h', name: 'h', source: { kind: 'http', url: 'https://a.example/' }, refreshSec: 1 },
        { id: 'c', name: 'c', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 1 },
      ]),
    }));
    const stop = hub.subscribe('d1', viewer());
    await settle();
    expect(hub.activeTimers()).toBe(2);
    const intervals = spy.mock.calls.map((c) => c[1]);
    expect(intervals).toContain(30_000);
    expect(intervals.every((ms) => (ms ?? 0) >= 1000)).toBe(true);
    stop();
    expect(hub.activeTimers()).toBe(0);
    spy.mockRestore();
    hub.close();
  });

  it('leaves datasets that use filters to polling, also inside a chain, and keeps pushing the others', async () => {
    useFakeTimers();
    const events: LiveEvent[] = [];
    const parameters = [
      {
        id: 'region',
        label: 'Region',
        type: 'select',
        options: [{ value: 'eu' }, { value: 'us' }],
        all: 'All',
        default: null,
      },
    ];
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: {
        ...doc([
          { id: 'a', name: 'A', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
          {
            id: 'mine',
            name: 'Mine',
            source: { kind: 'dataset', id: 'a' },
            transforms: [{ type: 'filter', expr: '$param.region == null' }],
          },
          { id: 'kid', name: 'Kid', source: { kind: 'dataset', id: 'a' } },
          {
            id: 'own',
            name: 'Own',
            source: { kind: 'connector', connector: 'demo.signal', params: { shape: '$param.region' } },
            refreshSec: 5,
          },
        ]),
        parameters,
      } as DashboardDoc,
    }));
    const stop = hub.subscribe(
      'dp',
      viewer((e) => events.push(e)),
    );
    await settle();
    // Only "a": "own" uses a filter in its own source.
    expect(hub.activeTimers()).toBe(1);
    await advance(10_000);
    await settle();
    const pushed = new Set(events.flatMap((e) => (e.type === 'data' ? [e.result.datasetId] : [])));
    expect([...pushed].sort()).toEqual(['a', 'kid']);
    stop();
    hub.close();
  });

  it('closes the room and its timers when the last subscriber fails to receive', async () => {
    useFakeTimers();
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: doc([
        { id: 'c', name: 'c', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
      ]),
    }));
    hub.subscribe(
      'd2',
      viewer(() => {
        throw new Error('socket gone');
      }),
    );
    await settle();
    expect(hub.activeTimers()).toBe(1);
    hub.publish('d2', { type: 'deleted' });
    expect(hub.watchers('d2')).toBe(0);
    expect(hub.activeTimers()).toBe(0);
    hub.close();
  });

  it('refreshes what reads a live dataset on its tick, from one loop, without fetching static siblings again', async () => {
    useFakeTimers();
    const load = vi.spyOn(data, 'loadSource');
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: doc([
        { id: 'live', name: 'Live', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
        { id: 'kid', name: 'Kid', source: { kind: 'dataset', id: 'live' } },
        { id: 'static', name: 'Static', source: { kind: 'inline', rows: [{ value: -1 }] } },
        {
          id: 'both',
          name: 'Both',
          source: { kind: 'dataset', id: 'kid' },
          transforms: [{ type: 'union', with: ['static'] }],
        },
      ]),
    }));
    hub.subscribe(
      'd-chain',
      viewer((e) => events.push(e)),
    );
    await settle();
    expect(hub.activeTimers()).toBe(1);
    await advance(5_000);
    await settle();
    const pushed = () => events.flatMap((e) => (e.type === 'data' ? [e.result.datasetId] : []));
    expect(pushed()).toEqual(['live', 'kid', 'both']);
    expect(hub.seedSize('d-chain')).toBeGreaterThan(0);
    await advance(5_000);
    await settle();
    // The connector serves the same reading within its cache time: same hashes, nothing pushed again.
    expect(pushed()).toEqual(['live', 'kid', 'both']);
    const staticLoads = load.mock.calls.filter((c) => (c[1] as { id: string }).id === 'static');
    expect(staticLoads).toHaveLength(1);
    await hub.docChanged('d-chain', {
      type: 'doc',
      version: 2,
      actor: { kind: 'system', label: 't' },
      changes: [],
    });
    expect(hub.seedSize('d-chain')).toBe(0);
    load.mockRestore();
    hub.close();
  });

  it('keeps only tables a tick can reuse, drops a failed one, and gives a derived dataset no loop of its own', async () => {
    useFakeTimers();
    const events: LiveEvent[] = [];
    let ownerId = 'u1';
    const hub = new LiveHub(data, async () => ({
      ownerId,
      doc: doc([
        { id: 'a', name: 'A', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
        { id: 'b', name: 'B', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
        // Refused on save; a document written by another path must still not get a second loop on the chain.
        {
          id: 'ab',
          name: 'AB',
          source: { kind: 'dataset', id: 'a' },
          transforms: [{ type: 'union', with: ['b'] }],
          refreshSec: 5,
        },
        // A chain no live dataset feeds: no tick ever reads these, so the room keeps none of them.
        { id: 'base', name: 'Base', source: { kind: 'inline', rows: [{ value: 1 }] } },
        { id: 'copy', name: 'Copy', source: { kind: 'dataset', id: 'base' } },
      ]),
    }));
    hub.subscribe(
      'd-keep',
      viewer((e) => events.push(e)),
    );
    await settle();
    expect(hub.activeTimers()).toBe(2);
    await advance(5_000);
    await settle();
    // Each loop reads the other's table; neither re-runs its own from the room.
    expect(hub.seedSize('d-keep')).toBe(2);
    const broken = vi.spyOn(data, 'loadSource').mockRejectedValue(new Error('upstream down'));
    await advance(5_000);
    await settle();
    const errors = events.flatMap((e) => (e.type === 'data' && e.result.error ? [e.result.datasetId] : []));
    expect(new Set(errors)).toEqual(new Set(['a', 'b', 'ab']));
    // Another loop must not show a failed dataset's last good table next to the error the room just pushed.
    expect(hub.seedSize('d-keep')).toBe(0);
    broken.mockRestore();

    // A new owner means a new schedule: the next tick loads with the dashboard's own target, never the old tables.
    const load = vi.spyOn(data, 'loadSource');
    ownerId = 'u2';
    await hub.docChanged('d-keep', {
      type: 'doc',
      version: 2,
      actor: { kind: 'system', label: 't' },
      changes: [],
    });
    await advance(5_000);
    await settle();
    const targets = load.mock.calls.map((c) => c[0]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => JSON.stringify(t) === JSON.stringify({ id: 'd-keep', ownerId: 'u2' }))).toBe(
      true,
    );
    load.mockRestore();
    hub.close();
  });

  it('keeps a failed input failed in what reads it, tick after tick, without flickering back to old data', async () => {
    useFakeTimers();
    let n = 0;
    let bFails = false;
    vi.spyOn(data, 'loadSource').mockImplementation(async (_target, dataset) => {
      if (dataset.id === 'a') return reading(100 + n);
      await sleep(5);
      if (bFails) throw new HttpError(502, 'b is down');
      return reading(200 + n);
    });
    slowUnions(() => 30);
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({ ownerId: null, doc: twoLive() }));
    hub.subscribe(
      'd-fail',
      viewer((e) => events.push(e)),
    );
    await settle();
    n = 1;
    await advance(5_000);
    await advance(100);
    expect(pushedFor(events, 'c')).toEqual(['101,201']);
    bFails = true;
    for (n = 2; n <= 4; n++) {
      await advance(5_000);
      await advance(100);
    }
    // One error, then the same error (same hash, nothing pushed): never b's last good reading next to a new a.
    expect(pushedFor(events, 'c')).toEqual(['101,201', 'error']);
    expect(pushedFor(events, 'a')).toEqual(['101', '102', '103', '104']);
    expect(hub.seedSize('d-fail')).toBe(1);
    hub.close();
  });

  it('runs one refresh of chains at a time, so a dependent is never pushed from an older reading after a newer', async () => {
    useFakeTimers();
    let n = 0;
    vi.spyOn(data, 'loadSource').mockImplementation(async (_target, dataset) => {
      if (dataset.id === 'a') return reading(100 + n);
      await sleep(5);
      return reading(200 + n);
    });
    // The first union run of a round is the slow one: run concurrently, it would finish last with the older b.
    const unions = slowUnions((call) => (call % 2 === 0 ? 40 : 5));
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({ ownerId: null, doc: twoLive() }));
    hub.subscribe(
      'd-order',
      viewer((e) => events.push(e)),
    );
    await settle();
    for (n = 1; n <= 3; n++) {
      unions.reset();
      await advance(5_000);
      await advance(150);
    }
    expect(pushedFor(events, 'c')).toEqual(['101,201', '102,202', '103,203']);
    // A tick during a refresh waits for it and runs right after, with the newest readings.
    unions.reset();
    n = 4;
    await advance(5_000);
    await advance(15);
    n = 5;
    // Synchronous on purpose: the next tick must land while the slow union of the round above is still in flight.
    vi.advanceTimersByTime(5_000);
    await advance(200);
    expect(pushedFor(events, 'c')).toEqual(['101,201', '102,202', '103,203', '104,204', '105,205']);
    expect(unions.max).toBe(1);
    hub.close();
  });

  it('lets chains with nothing in common keep their cadence while one of them is slow', async () => {
    useFakeTimers();
    let n = 0;
    vi.spyOn(data, 'loadSource').mockImplementation(async (_target, dataset) => {
      if (dataset.id !== 'x') return reading(100 + n);
      await sleep(300);
      return reading(900);
    });
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({ ownerId: null, doc: separate() }));
    hub.subscribe(
      'd-apart',
      viewer((e) => events.push(e)),
    );
    await settle();
    n = 1;
    await advance(5_000);
    await advance(50);
    expect(pushedFor(events, 'ka')).toEqual(['101']);
    expect(pushedFor(events, 'x')).toEqual([]);
    n = 2;
    await advance(5_000);
    await advance(50);
    expect(pushedFor(events, 'ka')).toEqual(['101', '102']);
    await advance(700);
    expect(pushedFor(events, 'kx')).toEqual(['900']);
    hub.close();
  });

  it('gives each component its own scope and deadline', async () => {
    useFakeTimers();
    vi.spyOn(data, 'loadSource').mockImplementation(async () => {
      await sleep(300);
      return reading(1);
    });
    // A scaled stand-in for SCOPE_DEADLINE_MS: one root load fits in it, two in a row would not.
    const open = data.scope.bind(data);
    const scopes = vi
      .spyOn(data, 'scope')
      .mockImplementation((target, d, options) => open(target, d, { ...options, deadlineMs: 500 }));
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({ ownerId: null, doc: separate() }));
    hub.subscribe(
      'd-deadline',
      viewer((e) => events.push(e)),
    );
    await settle();
    await advance(5_000);
    await advance(800);
    expect(scopes).toHaveBeenCalledTimes(2);
    for (const id of ['a', 'ka', 'x', 'kx']) expect(pushedFor(events, id)).toEqual(['1']);
    hub.close();
  });

  it('keeps only the direct inputs of live chains, at most LIMITS.datasetInputs per room, until memory relief', async () => {
    useFakeTimers();
    const inline = (id: string) => ({ id, name: id, source: { kind: 'inline', rows: [{ value: 1 }] } });
    const live = (id: string, inputs: string[]) => ({
      id,
      name: id,
      source: { kind: 'connector', connector: 'demo.signal' },
      refreshSec: 5,
      transforms: [{ type: 'union', with: inputs }],
    });
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: doc([
        ...['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'z'].map(inline),
        { id: 'y', name: 'y', source: { kind: 'dataset', id: 'z' } },
        { id: 'x', name: 'x', source: { kind: 'dataset', id: 'y' } },
        live('l1', ['s1', 's2', 's3', 's4']),
        live('l2', ['s5', 's6', 's7', 's8']),
        // x reads y, which reads z: only x is read by a chain member, so y and z are never kept.
        live('l3', ['x']),
      ]),
    }));
    hub.subscribe('d-bound', viewer());
    await settle();
    await advance(5_000);
    await advance(100);
    // Nine direct inputs, capped at eight.
    expect(LIMITS.datasetInputs).toBe(8);
    expect(hub.seedSize('d-bound')).toBe(8);
    hub.dropSeeds();
    expect(hub.seedSize('d-bound')).toBe(0);
    await advance(5_000);
    await advance(100);
    expect(hub.seedSize('d-bound')).toBe(8);
    hub.close();
  });

  it('skips a refresh when the server is busy instead of failing', async () => {
    useFakeTimers();
    const busy = vi.spyOn(data, 'resolve').mockRejectedValue(new BusyError());
    const events: LiveEvent[] = [];
    const hub = new LiveHub(data, async () => ({
      ownerId: null,
      doc: doc([
        { id: 'c', name: 'c', source: { kind: 'connector', connector: 'demo.signal' }, refreshSec: 5 },
      ]),
    }));
    hub.subscribe(
      'd3',
      viewer((e) => events.push(e)),
    );
    await settle();
    await advance(5_000);
    await settle();
    expect(busy).toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(hub.watchers('d3')).toBe(1);
    busy.mockRestore();
    hub.close();
  });
});
