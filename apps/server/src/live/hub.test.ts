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
