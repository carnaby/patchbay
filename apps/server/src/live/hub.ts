/**
 * Real-time fan-out.
 *
 * While at least one browser watches a dashboard, the hub refreshes each live
 * dataset on its own interval and pushes the result over SSE - but only when
 * the content hash changed. N viewers share one refresh loop, and an idle
 * dashboard costs nothing.
 */
import type { DashboardDoc, LiveEvent } from '@patchbay/core';
import type { DataService } from '../services/data.ts';

type Send = (event: LiveEvent) => void;

interface Room {
  subscribers: Set<Send>;
  timers: NodeJS.Timeout[];
  lastHash: Map<string, string>;
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

  subscribe(dashboardId: string, send: Send): () => void {
    let room = this.rooms.get(dashboardId);
    if (!room) {
      room = { subscribers: new Set(), timers: [], lastHash: new Map() };
      this.rooms.set(dashboardId, room);
      void this.schedule(dashboardId);
    }
    room.subscribers.add(send);
    return () => {
      const r = this.rooms.get(dashboardId);
      if (!r) return;
      r.subscribers.delete(send);
      if (r.subscribers.size === 0) {
        for (const t of r.timers) clearInterval(t);
        this.rooms.delete(dashboardId);
      }
    };
  }

  watchers(dashboardId: string): number {
    return this.rooms.get(dashboardId)?.subscribers.size ?? 0;
  }

  publish(dashboardId: string, event: LiveEvent) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    for (const send of room.subscribers) {
      try {
        send(event);
      } catch {
        room.subscribers.delete(send);
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
    if (room) for (const t of room.timers) clearInterval(t);
    this.rooms.delete(dashboardId);
    this.data.forget(dashboardId);
  }

  private async schedule(dashboardId: string) {
    const room = this.rooms.get(dashboardId);
    if (!room) return;
    for (const t of room.timers) clearInterval(t);
    room.timers = [];
    const doc = await this.loadDoc(dashboardId).catch(() => null);
    if (!doc || !this.rooms.has(dashboardId)) return;
    for (const dataset of doc.datasets) {
      if (dataset.refreshSec <= 0) continue;
      const interval = Math.max(dataset.refreshSec, MIN_INTERVAL_SEC) * 1000;
      let running = false;
      const tick = async () => {
        if (running) return; // never overlap slow upstream calls
        running = true;
        try {
          const result = await this.data.resolve(dashboardId, dataset);
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
    for (const room of this.rooms.values()) for (const t of room.timers) clearInterval(t);
    this.rooms.clear();
  }
}
