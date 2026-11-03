/**
 * Real-time fan-out.
 *
 * While at least one browser watches a dashboard, the hub refreshes each live
 * dataset on its own interval and pushes the result over SSE - but only when
 * the content hash changed. N viewers share one refresh loop, and an idle
 * dashboard costs nothing.
 *
 * A dataset that others read refreshes them on its tick: the hub re-resolves
 * its dependents, parents first, from one loop per live dataset. Derived
 * datasets never get a loop of their own, so refreshes flow only downstream
 * and cannot loop.
 */
import {
  type DashboardDoc,
  type DatasetResult,
  dependentsOf,
  hasLineage,
  type LiveEvent,
  upstreamClosure,
} from '@patchbay/core';
import type { Principal } from '../services/dashboards.ts';
import type { DashboardTarget, DataService } from '../services/data.ts';
import type { FullResult } from '../services/scope.ts';
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

/**
 * Latest full tables of one schedule, so a tick re-runs only what depends on the dataset that ticked. They belong to
 * the target that produced them: a scope with any other owner or network rights must load its own.
 */
interface Seeds {
  target: DashboardTarget;
  tables: Map<string, FullResult>;
  /**
   * The datasets some tick reads without re-running them: everything upstream of a live chain. Each is cut to
   * PIPELINE_LIMITS.maxRows, and one chain member reads at most LIMITS.datasetInputs of them.
   */
  reused: ReadonlySet<string>;
}

interface Room {
  subscribers: Set<Subscriber>;
  timers: NodeJS.Timeout[];
  lastHash: Map<string, string>;
  /** Bumped on every (re)schedule; stale async schedules notice and bail out. */
  generation: number;
  /** Dropped on every (re)schedule: a new document may have a new graph. */
  seeds: Seeds | null;
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
      room = { subscribers: new Set(), timers: [], lastHash: new Map(), generation: 0, seeds: null };
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
    room.seeds = null;
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

  /** Full tables a room keeps between ticks (tests and diagnostics). */
  seedSize(dashboardId: string): number {
    return this.rooms.get(dashboardId)?.seeds?.tables.size ?? 0;
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
    room.seeds = null;
    const loaded = await this.loadDashboard(dashboardId).catch(() => null);
    // While we awaited, the room may have closed, been replaced, or been rescheduled.
    if (!loaded || this.rooms.get(dashboardId) !== room || room.generation !== generation) return;
    const doc = loaded.doc;
    // Results never leave this room: any future sharing of refreshes across dashboards (by URL, say) would have to
    // include the credentials in its key, as DataService's caches do. Never a preview or a read-only token's rights:
    // this is the dashboard's own reading, the one its accumulate buffers record.
    const target: DashboardTarget = { id: dashboardId, ownerId: loaded.ownerId };
    // A derived dataset refreshes when its parent does (lineageIssues refuses refreshSec on it): a second loop on the
    // chain would fetch the same thing twice, even for a document that reached the store some other way.
    const live = doc.datasets.filter((d) => d.source.kind !== 'dataset');
    const chains = new Map<string, string[]>();
    for (const d of live)
      if (this.data.refreshIntervalSec(d) !== null && hasLineage(doc, d.id))
        chains.set(d.id, [d.id, ...dependentsOf(doc, d.id)]);
    const reused = new Set<string>();
    for (const chain of chains.values())
      for (const x of chain)
        for (const up of upstreamClosure(doc, x)) if (!chain.includes(up)) reused.add(up);
    room.seeds = { target, tables: new Map(), reused };
    for (const dataset of live) {
      // The same floors as on save, applied again here so a document saved before a floor existed (or written by
      // any other path) cannot schedule faster; uploads and inline rows are never refreshed on a timer.
      const seconds = this.data.refreshIntervalSec(dataset);
      if (seconds === null) continue;
      const chain = chains.get(dataset.id);
      const interval = seconds * 1000;
      let running = false;
      const tick = async () => {
        if (running) return; // never overlap slow upstream calls
        running = true;
        try {
          // One client per dashboard for the fair queues: many viewers share one loop, and so one share.
          await runAsClient(`live:${dashboardId}`, async () => {
            if (chain) await this.refreshChain(dashboardId, room, generation, doc, chain);
            else this.push(dashboardId, room, generation, await this.data.resolve(target, dataset));
          });
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

  private push(dashboardId: string, room: Room, generation: number, result: DatasetResult) {
    if (room.generation !== generation) return;
    if (room.lastHash.get(result.datasetId) === result.hash) return;
    room.lastHash.set(result.datasetId, result.hash);
    this.publish(dashboardId, { type: 'data', result });
  }

  /**
   * Re-resolves a live dataset and everything that reads it, parents first (`chain`). Everything else comes from the
   * room's latest tables, read when needed, so a dataset that ticked a moment ago is seen with its newest reading.
   */
  private async refreshChain(
    dashboardId: string,
    room: Room,
    generation: number,
    doc: DashboardDoc,
    chain: readonly string[],
  ) {
    const seeds = room.seeds;
    if (!seeds || room.generation !== generation) return;
    const rerun = new Set(chain);
    // The scope runs for the seeds' own target, so a table is only ever reused by the target that produced it.
    const scope = this.data.scope(seeds.target, doc, {
      seed: (x) => (rerun.has(x) ? undefined : seeds.tables.get(x)),
    });
    for (const x of chain) {
      const dataset = doc.datasets.find((d) => d.id === x);
      if (!dataset) continue;
      const result = await scope.resolve(dataset);
      if (room.generation !== generation) return;
      this.push(dashboardId, room, generation, result);
      if (!seeds.reused.has(x)) continue;
      const full = scope.settled().get(x);
      // A dataset that just failed is loaded again by the next tick that reads it, never shown from its last table
      // next to the error this one pushed.
      if (full) seeds.tables.set(x, full);
      else seeds.tables.delete(x);
    }
    // Inputs this tick had to load are kept too, so the next tick does not load them again. Only where no table is
    // kept: another live dataset's loop may have stored a newer reading than the one this tick started from.
    for (const [x, full] of scope.settled())
      if (!rerun.has(x) && seeds.reused.has(x) && !seeds.tables.has(x)) seeds.tables.set(x, full);
  }

  close() {
    for (const [id, room] of this.rooms) this.closeRoom(id, room);
  }
}
