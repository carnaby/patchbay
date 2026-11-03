import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardDoc, DatasetSchema, type LiveEvent } from '@patchbay/core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../connectors/registry.ts';
import { DataService } from '../services/data.ts';
import { FolderStore } from '../store/folder-store.ts';
import { BusyError } from '../util/gate.ts';
import { LiveHub } from './hub.ts';

const dir = mkdtempSync(join(tmpdir(), 'patchbay-hub-test-'));
const data = new DataService(new ConnectorService({ offline: true }), new FolderStore(dir));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

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
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('LiveHub', () => {
  it('schedules no refresh for uploads and inline rows, and HTTP no faster than its cache', async () => {
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

  it('closes the room and its timers when the last subscriber fails to receive', async () => {
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
    vi.advanceTimersByTime(5_000);
    await settle();
    const pushed = () => events.flatMap((e) => (e.type === 'data' ? [e.result.datasetId] : []));
    expect(pushed()).toEqual(['live', 'kid', 'both']);
    expect(hub.seedSize('d-chain')).toBeGreaterThan(0);
    vi.advanceTimersByTime(5_000);
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
    vi.advanceTimersByTime(5_000);
    await settle();
    // Each loop reads the other's table; neither re-runs its own from the room.
    expect(hub.seedSize('d-keep')).toBe(2);
    const broken = vi.spyOn(data, 'loadSource').mockRejectedValue(new Error('upstream down'));
    vi.advanceTimersByTime(5_000);
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
    vi.advanceTimersByTime(5_000);
    await settle();
    const targets = load.mock.calls.map((c) => c[0]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => JSON.stringify(t) === JSON.stringify({ id: 'd-keep', ownerId: 'u2' }))).toBe(
      true,
    );
    load.mockRestore();
    hub.close();
  });

  it('skips a refresh when the server is busy instead of failing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(busy).toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(hub.watchers('d3')).toBe(1);
    busy.mockRestore();
    hub.close();
  });
});
