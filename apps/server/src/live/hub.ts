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

const MIN_INTERVAL_SEC = 1;

export class LiveHub {
  private readonly rooms = new Map<string, Room>();
  private readonly data: DataService;
  private readonly loadDoc: (id: string) => Promise<DashboardDoc | null>;

  constructor(data: DataService, loadDoc: (id: string) => Promise<DashboardDoc | null>) {
    this.data = data;
    this.loadDoc = loadDoc;
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
    for (const sub of room.subscribers) {
      try {
        sub.send(event);
      } catch {
        room.subscribers.delete(sub);
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
    const doc = await this.loadDoc(dashboardId).catch(() => null);
    // While we awaited, the room may have closed, been replaced, or been rescheduled.
    if (!doc || this.rooms.get(dashboardId) !== room || room.generation !== generation) return;
    for (const dataset of doc.datasets) {
      if (dataset.refreshSec <= 0) continue;
      const interval = Math.max(dataset.refreshSec, MIN_INTERVAL_SEC) * 1000;
      let running = false;
      const tick = async () => {
        if (running) return; // never overlap slow upstream calls
        running = true;
        try {
          const result = await this.data.resolve(dashboardId, dataset);
          if (room.generation !== generation) return;
          if (room.lastHash.get(dataset.id) !== result.hash) {
            room.lastHash.set(dataset.id, result.hash);
            this.publish(dashboardId, { type: 'data', result });
          }
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
