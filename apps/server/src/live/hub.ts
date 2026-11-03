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
  LIMITS,
  type LiveEvent,
  lineageDepth,
  upstreamOf,
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
 * The refreshes of live datasets that others read, for one schedule. The kept tables belong to the target that
 * produced them: a scope with any other owner or network rights must load its own.
 */
interface Chains {
  target: DashboardTarget;
  doc: DashboardDoc;
  /** Per live dataset with lineage: it and everything that reads it, parents first. */
  chains: Map<string, readonly string[]>;
  /** Every dataset comes after the ones it reads; pushes wait only for strictly shallower ones, so never in a ring. */
  depth: Map<string, number>;
  /**
   * The datasets a refresh reads directly without re-running them: inputs of chain members outside the chain. A
   * kept table is cut to PIPELINE_LIMITS.maxRows, and a room keeps at most LIMITS.datasetInputs of them.
   */
  inputs: ReadonlySet<string>;
  /** Latest tables of `inputs`, so a tick re-runs only what depends on the dataset that ticked. */
  tables: Map<string, FullResult>;
  /** The component of each live dataset with lineage. */
  components: Map<string, Component>;
}

/**
 * Live chains that share a dataset (a member or a direct input). Their refreshes run one round at a time: two at
 * once would each start from the other's older table and could push a dependent built from a stale reading after a
 * fresh one. Chains with nothing in common are separate components and never wait for each other; a slow member
 * still paces every chain of its own component.
 */
interface Component {
  /** Live datasets that ticked while a round ran: they run together right after it. */
  queued: Set<string>;
  draining: boolean;
}

/** Groups live datasets whose chains touch a common dataset, transitively (union-find over the touched ids). */
function componentsOf(touches: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Component> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const [live, touched] of touches)
    for (const x of touched) {
      const a = find(live);
      const b = find(x);
      if (a !== b) parent.set(b, a);
    }
  const byRoot = new Map<string, Component>();
  const out = new Map<string, Component>();
  for (const live of touches.keys()) {
    const root = find(live);
    const component = byRoot.get(root) ?? { queued: new Set<string>(), draining: false };
    byRoot.set(root, component);
    out.set(live, component);
  }
  return out;
}

interface Room {
  subscribers: Set<Subscriber>;
  timers: NodeJS.Timeout[];
  lastHash: Map<string, string>;
  /** Bumped on every (re)schedule; stale async schedules notice and bail out. */
  generation: number;
  /** Replaced on every (re)schedule: a new document may have a new graph. */
  chains: Chains | null;
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
      room = { subscribers: new Set(), timers: [], lastHash: new Map(), generation: 0, chains: null };
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
    room.chains = null;
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
    return this.rooms.get(dashboardId)?.chains?.tables.size ?? 0;
  }

  /** Memory relief: the next tick loads what it needs again, through the data caches. */
  dropSeeds() {
    for (const room of this.rooms.values()) room.chains?.tables.clear();
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
    room.chains = null;
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
    const byChain = new Map<string, readonly string[]>();
    for (const d of live)
      if (this.data.refreshIntervalSec(d) !== null && hasLineage(doc, d.id))
        byChain.set(d.id, [d.id, ...dependentsOf(doc, d.id)]);
    const inputs = new Set<string>();
    const touches = new Map<string, Set<string>>();
    for (const [root, chain] of byChain) {
      const touched = new Set(chain);
      for (const x of chain) {
        const dataset = doc.datasets.find((d) => d.id === x);
        for (const up of dataset ? upstreamOf(dataset) : []) {
          touched.add(up);
          if (!chain.includes(up)) inputs.add(up);
        }
      }
      touches.set(root, touched);
    }
    const chains: Chains = {
      target,
      doc,
      chains: byChain,
      depth: new Map(doc.datasets.map((d) => [d.id, lineageDepth(doc, d.id)])),
      inputs,
      tables: new Map(),
      components: componentsOf(touches),
    };
    room.chains = chains;
    for (const dataset of live) {
      // The same floors as on save, applied again here so a document saved before a floor existed (or written by
      // any other path) cannot schedule faster; uploads and inline rows are never refreshed on a timer.
      const seconds = this.data.refreshIntervalSec(dataset);
      if (seconds === null) continue;
      const interval = seconds * 1000;
      let running = false;
      const tick = byChain.has(dataset.id)
        ? () => this.queueChain(dashboardId, room, generation, chains, dataset.id)
        : async () => {
            if (running) return; // never overlap slow upstream calls
            running = true;
            try {
              // One client per dashboard for the fair queues: many viewers share one loop, and so one share.
              const result = await runAsClient(`live:${dashboardId}`, () =>
                this.data.resolve(target, dataset),
              );
              this.push(dashboardId, room, generation, result);
            } catch (e) {
              // A saturated server skips this refresh; viewers keep the data they have. Anything else is a bug,
              // and a timer callback must not take the process down with it.
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
   * One round at a time per component (see `Component`): a tick that comes meanwhile waits for the next round, and
   * ticks of the same moment share one.
   */
  private async queueChain(dashboardId: string, room: Room, generation: number, chains: Chains, id: string) {
    const component = chains.components.get(id);
    if (!component) return;
    component.queued.add(id);
    if (component.draining) return;
    component.draining = true;
    try {
      // Loops with the same interval fire in one timers phase; this lets them all join the first round.
      await new Promise((resolve) => setImmediate(resolve));
      while (component.queued.size && room.generation === generation) {
        const roots = [...component.queued];
        component.queued.clear();
        try {
          // One client per dashboard for the fair queues: many viewers share one loop, and so one share.
          await runAsClient(`live:${dashboardId}`, () =>
            this.refreshChains(dashboardId, room, generation, chains, roots),
          );
        } catch (e) {
          // A saturated server skips this refresh; viewers keep the data they have. Anything else is a bug, and a
          // timer callback must not take the process down with it.
          if (!(e instanceof BusyError)) console.error('[patchbay] live refresh failed', e);
        }
      }
    } finally {
      component.draining = false;
    }
  }

  /**
   * Re-resolves live datasets of one component and everything that reads them, in one scope with its own deadline.
   * They resolve concurrently (the scope computes a shared member once) and each is pushed once it and its parents
   * in the round are, so a viewer never sees a child ahead of its parent. Their other inputs come from the room's
   * latest tables, so a dataset that ticked a moment ago is seen with its newest reading.
   */
  private async refreshChains(
    dashboardId: string,
    room: Room,
    generation: number,
    chains: Chains,
    roots: readonly string[],
  ) {
    const rerun = new Set(roots.flatMap((r) => chains.chains.get(r) ?? []));
    const order = [...rerun].sort((a, b) => (chains.depth.get(a) ?? 0) - (chains.depth.get(b) ?? 0));
    const served = new Set<string>();
    // The scope runs for the tables' own target, so a table is only ever reused by the target that produced it.
    const scope = this.data.scope(chains.target, chains.doc, {
      seed: (x) => {
        const kept = rerun.has(x) ? undefined : chains.tables.get(x);
        if (kept) served.add(x);
        return kept;
      },
    });
    const keep = (x: string, full: FullResult) => {
      if (!chains.inputs.has(x)) return;
      if (chains.tables.has(x) || chains.tables.size < LIMITS.datasetInputs) chains.tables.set(x, full);
    };
    const depth = (x: string) => chains.depth.get(x) ?? 0;
    const pushed = new Map<string, Promise<void>>();
    // In depth order, so the parents' promises exist when a child's is made.
    for (const x of order) {
      const dataset = chains.doc.datasets.find((d) => d.id === x);
      if (!dataset) continue;
      const parents = upstreamOf(dataset).flatMap((u) => {
        const p = rerun.has(u) && depth(u) < depth(x) ? pushed.get(u) : undefined;
        return p ? [p] : [];
      });
      const resolving = scope.resolve(dataset);
      pushed.set(
        x,
        (async () => {
          const result = await resolving;
          await Promise.all(parents);
          if (room.generation !== generation) return;
          this.push(dashboardId, room, generation, result);
          const full = scope.settled().get(x);
          // A dataset that just failed is loaded again by the next refresh that reads it, never shown from its last
          // table next to the error this one pushed.
          if (full) keep(x, full);
          else chains.tables.delete(x);
        })(),
      );
    }
    // The round ends only when every push did, so none lands after the next round's; the first failure (a BusyError
    // skips the round) is thrown once.
    const settled = await Promise.allSettled(pushed.values());
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
    if (room.generation !== generation) return;
    // Inputs this refresh loaded are kept too, so the next one does not load them again; tables it was served from
    // the room are already there.
    for (const [x, full] of scope.settled()) if (!rerun.has(x) && !served.has(x)) keep(x, full);
  }

  close() {
    for (const [id, room] of this.rooms) this.closeRoom(id, room);
  }
}
