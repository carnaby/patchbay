/**
 * Real-time fan-out.
 *
 * While at least one browser watches a dashboard, the hub refreshes each live
 * dataset on its own interval and pushes the result over SSE - but only when
 * the content hash changed. N viewers share one refresh loop, and an idle
 * dashboard costs nothing.
 */
import type { DashboardDoc, LiveEvent } from '@patchbay/core';
import type { Principal } from '../services/dashboards.ts';
import type { DataService } from '../services/data.ts';
import { BusyError } from '../util/gate.ts';
import { runAsClient } from '../util/request-context.ts';

/** A dashboard as the hub needs it: the document, and the owner its secrets are resolved against. */
export type LoadDashboard = (id: string) => Promise<{ doc: DashboardDoc; ownerId: string | null } | null>;

export interface Subscriber {
  send: (event: LiveEvent) => void;
  /** Who is watching; re-checked when access rules change (e.g. made private). */
  principal: Principal;
  /** Ends the subscriber's stream. */
  close: () => void;
}

interface Room {
  subscribers: Set<Subscriber>;
  timers: NodeJS.Timeout[];
  lastHash: Map<string, string>;
  /** Bumped on every (re)schedule; stale async schedules notice and bail out. */
  generation: number;
}

export class LiveHub {
  private readonly rooms = new Map<string, Room>();
  private readonly data: DataService;
  private readonly loadDashboard: LoadDashboard;

  constructor(data: DataService, loadDashboard: LoadDashboard) {
    this.data = data;
    this.loadDashboard = loadDashboard;
  }

  subscribe(dashboardId: string, subscriber: Subscriber): () => void {
    let room = this.rooms.get(dashboardId);
    if (!room) {
      room = { subscribers: new Set(), timers: [], lastHash: new Map(), generation: 0 };
      this.rooms.set(dashboardId, room);
      void this.schedule(dashboardId);
    }
    room.subscribers.add(subscriber);
    return () => this.unsubscribe(dashboardId, subscriber);
  }

  private unsubscribe(dashboardId: string, subscriber: Subscriber) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    room.subscribers.delete(subscriber);
    if (room.subscribers.size === 0) this.closeRoom(dashboardId, room);
  }

  private closeRoom(dashboardId: string, room: Room) {
    room.generation++;
    for (const t of room.timers) clearInterval(t);
    room.timers = [];
    if (this.rooms.get(dashboardId) === room) this.rooms.delete(dashboardId);
  }

  watchers(dashboardId: string): number {
    return this.rooms.get(dashboardId)?.subscribers.size ?? 0;
  }

  /** Number of running refresh loops (for tests and diagnostics). */
  activeTimers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.timers.length;
    return n;
  }

  publish(dashboardId: string, event: LiveEvent) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    for (const sub of [...room.subscribers]) {
      try {
        sub.send(event);
      } catch {
        // Through unsubscribe, so the room and its refresh loops close with the last subscriber.
        this.unsubscribe(dashboardId, sub);
      }
    }
  }

  /** Disconnects every subscriber who may no longer view the dashboard. */
  revalidate(dashboardId: string, canView: (p: Principal) => boolean) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    for (const sub of [...room.subscribers]) {
      if (!canView(sub.principal)) {
        sub.close();
        this.unsubscribe(dashboardId, sub);
      }
    }
  }

  /** Called after every saved change: tell viewers and re-plan the refresh loops. */
  async docChanged(dashboardId: string, event: Extract<LiveEvent, { type: 'doc' }>) {
    this.publish(dashboardId, event);
    if (this.rooms.has(dashboardId)) await this.schedule(dashboardId);
  }

  deleted(dashboardId: string) {
    this.publish(dashboardId, { type: 'deleted' });
    const room = this.rooms.get(dashboardId);
    if (room) this.closeRoom(dashboardId, room);
    this.data.forget(dashboardId);
  }

  private async schedule(dashboardId: string) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    const generation = ++room.generation;
    for (const t of room.timers) clearInterval(t);
    room.timers = [];
    const loaded = await this.loadDashboard(dashboardId).catch(() => null);
    // While we awaited, the room may have closed, been replaced, or been rescheduled.
    if (!loaded || this.rooms.get(dashboardId) !== room || room.generation !== generation) return;
    // Results never leave this room: any future sharing of refreshes across dashboards (by URL, say) would have to
    // include the credentials in its key, as DataService's caches do.
    const target = { id: dashboardId, ownerId: loaded.ownerId };
    for (const dataset of loaded.doc.datasets) {
      // The same floors as on save, applied again here so a document saved before a floor existed (or written by
      // any other path) cannot schedule faster; uploads and inline rows are never refreshed on a timer.
      const seconds = this.data.refreshIntervalSec(dataset);
      if (seconds === null) continue;
      const interval = seconds * 1000;
      let running = false;
      const tick = async () => {
        if (running) return; // never overlap slow upstream calls
        running = true;
        try {
          // One client per dashboard for the fair queues: many viewers share one loop, and so one share.
          const result = await runAsClient(`live:${dashboardId}`, () => this.data.resolve(target, dataset));
          if (room.generation !== generation) return;
          if (room.lastHash.get(dataset.id) !== result.hash) {
            room.lastHash.set(dataset.id, result.hash);
            this.publish(dashboardId, { type: 'data', result });
          }
        } catch (e) {
          // A saturated server skips this refresh; viewers keep the data they have. Anything else is a bug, and a
          // timer callback must not take the process down with it.
          if (!(e instanceof BusyError)) console.error('[patchbay] live refresh failed', e);
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), interval);
      timer.unref();
      room.timers.push(timer);
    }
  }

  close() {
    for (const [id, room] of this.rooms) this.closeRoom(id, room);
  }
}
