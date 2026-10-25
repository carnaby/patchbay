/**
 * Dashboard use-cases with their permission rules. Both the REST API and the
 * MCP server call into this class, so there is exactly one place that decides
 * who may see or change what.
 */
import {
  type Actor,
  applyOps,
  type DashboardDoc,
  type DashboardEnvelope,
  type DashboardMeta,
  inferTable,
  parseDashboard,
  type UploadedFile,
  type VersionInfo,
  type Visibility,
} from '@patchbay/core';
import Papa from 'papaparse';
import type { UserRow } from '../auth/users.ts';
import { now } from '../db.ts';
import type { LiveHub } from '../live/hub.ts';
import type { DashboardIndex } from '../store/dashboard-index.ts';
import type { FolderStore, StoredMeta } from '../store/folder-store.ts';
import { newDashboardId, newId, randomToken, safeEqual, sha256 } from '../util/crypto.ts';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../util/errors.ts';
import { buildTemplate } from './templates.ts';

export interface Principal {
  user: UserRow | null;
  isAdmin: boolean;
  /** Edit key presented for an anonymous dashboard (header X-Edit-Key). */
  editKey?: string | undefined;
  /** Set when the request comes through MCP, e.g. "Claude". */
  mcpClient?: string | undefined;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TOUCH_INTERVAL_MS = 10 * 60_000;

export class ConflictError extends HttpError {
  readonly current: DashboardEnvelope;
  constructor(current: DashboardEnvelope) {
    super(409, 'The dashboard changed since you loaded it', { current });
    this.current = current;
  }
}

export function actorOf(p: Principal): Actor {
  if (p.mcpClient)
    return { kind: 'mcp', ...(p.user ? { userId: p.user.id } : {}), label: `${p.mcpClient} (MCP)` };
  if (p.user) return { kind: 'user', userId: p.user.id, label: p.user.name };
  return { kind: 'anonymous', label: 'Anonymous' };
}

export class DashboardService {
  private readonly store: FolderStore;
  private readonly index: DashboardIndex;
  private readonly hub: LiveHub;

  constructor(store: FolderStore, index: DashboardIndex, hub: LiveHub) {
    this.store = store;
    this.index = index;
    this.hub = hub;
  }

  private publicMeta(m: StoredMeta, title: string): DashboardMeta {
    return {
      id: m.id,
      title,
      ownerId: m.ownerId,
      visibility: m.visibility,
      version: m.version,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      lastViewedAt: m.lastViewedAt,
      ...(m.lastActor ? { lastActor: m.lastActor } : {}),
    };
  }

  canView(meta: StoredMeta, p: Principal): boolean {
    return meta.visibility === 'public' || p.isAdmin || (p.user !== null && meta.ownerId === p.user.id);
  }

  canEdit(meta: StoredMeta, p: Principal): boolean {
    if (meta.ownerId) return p.user?.id === meta.ownerId;
    return Boolean(meta.editKeyHash && p.editKey && safeEqual(sha256(p.editKey), meta.editKeyHash));
  }

  private envelope(meta: StoredMeta, doc: DashboardDoc, p: Principal): DashboardEnvelope {
    return {
      meta: this.publicMeta(meta, doc.title),
      doc,
      access: {
        canEdit: this.canEdit(meta, p),
        isOwner: p.user !== null && meta.ownerId === p.user.id,
        anonymous: meta.ownerId === null,
      },
    };
  }

  private async load(id: string) {
    const meta = await this.store.readMeta(id);
    if (!meta) {
      // The folder vanished (deleted by hand): heal the index.
      this.index.remove(id);
      throw notFound('Dashboard not found');
    }
    const doc = await this.store.readDoc(id);
    if (!doc) throw notFound('Dashboard not found');
    return { meta, doc };
  }

  /** Loads for viewing. Private dashboards look like 404 to strangers (no existence leak). */
  async loadViewable(id: string, p: Principal) {
    const loaded = await this.load(id).catch((e) => {
      if (e instanceof HttpError) throw e;
      throw notFound('Dashboard not found');
    });
    if (!this.canView(loaded.meta, p)) {
      if (!p.user) throw unauthorized('This dashboard is private. Sign in to view it.');
      throw notFound('Dashboard not found');
    }
    return loaded;
  }

  async get(id: string, p: Principal, options: { touch?: boolean } = {}): Promise<DashboardEnvelope> {
    const { meta, doc } = await this.loadViewable(id, p);
    if (options.touch && Date.now() - Date.parse(meta.lastViewedAt) > TOUCH_INTERVAL_MS) {
      await this.store.withLock(id, async () => {
        const fresh = await this.store.readMeta(id);
        if (!fresh) return;
        fresh.lastViewedAt = now();
        await this.store.writeMeta(fresh);
        this.index.touch(id, fresh.lastViewedAt);
      });
    }
    return this.envelope(meta, doc, p);
  }

  async create(
    p: Principal,
    input: {
      title?: string | undefined;
      template?: string | undefined;
      doc?: DashboardDoc;
      visibility?: Visibility | undefined;
    },
  ): Promise<{ envelope: DashboardEnvelope; editKey?: string }> {
    const doc = input.doc ? parseDashboard(input.doc) : buildTemplate(input.template ?? 'blank', input.title);
    if (input.visibility === 'private' && !p.user)
      throw badRequest('Anonymous dashboards are always public. Sign in to create private ones.');
    const id = newDashboardId();
    const at = now();
    const editKey = p.user ? undefined : randomToken('pbk_', 24);
    const meta: StoredMeta = {
      id,
      ownerId: p.user?.id ?? null,
      ownerEmail: p.user?.email ?? null,
      visibility: p.user ? (input.visibility ?? 'private') : 'public',
      editKeyHash: editKey ? sha256(editKey) : null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      lastViewedAt: at,
      lastActor: actorOf(p),
    };
    await this.store.create(meta, doc, actorOf(p), [
      input.template ? `Created from template "${input.template}"` : 'Created',
    ]);
    this.index.upsert(meta, { title: doc.title, widgets: doc.widgets.length });
    const principal = editKey ? { ...p, editKey } : p;
    return { envelope: this.envelope(meta, doc, principal), ...(editKey ? { editKey } : {}) };
  }

  /** Writes a new version under the lock; `mutate` receives the latest document. */
  private async commit(
    id: string,
    p: Principal,
    mutate: (doc: DashboardDoc, meta: StoredMeta) => { doc: DashboardDoc; changes: string[] },
  ): Promise<{ envelope: DashboardEnvelope; changes: string[] }> {
    const result = await this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
      const next = mutate(doc, meta);
      const actor = actorOf(p);
      const updated: StoredMeta = {
        ...meta,
        version: meta.version + 1,
        updatedAt: now(),
        lastViewedAt: now(),
        lastActor: actor,
      };
      await this.store.writeDoc(updated, next.doc, actor, next.changes);
      this.index.upsert(updated, { title: next.doc.title, widgets: next.doc.widgets.length });
      return { meta: updated, doc: next.doc, changes: next.changes, actor };
    });
    await this.hub.docChanged(id, {
      type: 'doc',
      version: result.meta.version,
      actor: result.actor,
      changes: result.changes,
    });
    return { envelope: this.envelope(result.meta, result.doc, p), changes: result.changes };
  }

  /** Full-document save from the editor, with optimistic concurrency. */
  async save(
    id: string,
    p: Principal,
    rawDoc: unknown,
    baseVersion: number,
    changes: string[] = ['Edited in the editor'],
  ) {
    const doc = parseDashboard(rawDoc);
    return this.commit(id, p, (_current, meta) => {
      if (meta.version !== baseVersion) {
        throw new ConflictError(this.envelope(meta, _current, p));
      }
      return { doc, changes };
    });
  }

  /** Semantic ops (agents, or editor batches). Ops address ids, so they apply to the latest version. */
  async applyOps(
    id: string,
    p: Principal,
    ops: unknown[],
    options: { dryRun?: boolean; baseVersion?: number } = {},
  ) {
    if (!Array.isArray(ops) || ops.length === 0) throw badRequest('Provide at least one operation');
    if (ops.length > 100) throw badRequest('At most 100 operations per batch');
    if (options.dryRun) {
      const { meta, doc } = await this.load(id);
      if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
      const result = applyOps(doc, ops);
      return { envelope: this.envelope(meta, result.doc, p), changes: result.changes, dryRun: true };
    }
    return this.commit(id, p, (doc, meta) => {
      if (options.baseVersion !== undefined && options.baseVersion !== meta.version) {
        throw new ConflictError(this.envelope(meta, doc, p));
      }
      return applyOps(doc, ops);
    });
  }

  async setVisibility(id: string, p: Principal, visibility: Visibility) {
    const result = await this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (!p.user || meta.ownerId !== p.user.id) throw forbidden('Only the owner can change visibility');
      const updated = { ...meta, visibility, updatedAt: now() };
      await this.store.writeMeta(updated);
      this.index.upsert(updated, { title: doc.title, widgets: doc.widgets.length });
      return this.envelope(updated, doc, p);
    });
    if (visibility === 'private')
      this.hub.publish(id, {
        type: 'doc',
        version: result.meta.version,
        actor: actorOf(p),
        changes: ['Made private'],
      });
    return result;
  }

  /** Turns an anonymous dashboard into one owned by the signed-in user. */
  async claim(id: string, p: Principal) {
    if (!p.user) throw unauthorized();
    return this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (meta.ownerId) {
        if (meta.ownerId === p.user!.id) return this.envelope(meta, doc, p);
        throw forbidden('This dashboard already has an owner');
      }
      if (!this.canEdit(meta, p)) throw forbidden('A valid edit key is required to claim this dashboard');
      const updated: StoredMeta = {
        ...meta,
        ownerId: p.user!.id,
        ownerEmail: p.user!.email,
        editKeyHash: null,
        updatedAt: now(),
      };
      await this.store.writeMeta(updated);
      this.index.upsert(updated, { title: doc.title, widgets: doc.widgets.length });
      return this.envelope(updated, doc, { ...p, editKey: undefined });
    });
  }

  async duplicate(id: string, p: Principal) {
    const { doc } = await this.loadViewable(id, p);
    const created = await this.create(p, { doc: { ...doc, title: `${doc.title} (copy)` } });
    for (const file of await this.store.listFiles(id)) {
      const table = await this.store.readFileTable(id, file.id);
      if (table) await this.store.saveFile(created.envelope.meta.id, { ...file, table });
    }
    return created;
  }

  async delete(id: string, p: Principal) {
    const meta = await this.store.readMeta(id);
    if (!meta) throw notFound('Dashboard not found');
    const isOwner = p.user !== null && meta.ownerId === p.user.id;
    if (!isOwner && !p.isAdmin) throw forbidden('Only the owner or an admin can delete a dashboard');
    await this.store.withLock(id, () => this.store.remove(id));
    this.index.remove(id);
    this.hub.deleted(id);
  }

  async versions(id: string, p: Principal): Promise<VersionInfo[]> {
    await this.loadViewable(id, p);
    return this.store.listVersions(id);
  }

  async restore(id: string, p: Principal, version: number) {
    const stored = await this.store.readVersion(id, version);
    if (!stored) throw notFound(`Version ${version} not found`);
    return this.commit(id, p, () => ({
      doc: parseDashboard(stored.doc),
      changes: [`Restored version ${version}`],
    }));
  }

  listMine(p: Principal): DashboardMeta[] {
    if (!p.user) throw unauthorized();
    return this.index.listByOwner(p.user.id);
  }

  async uploadFile(
    id: string,
    p: Principal,
    input: { name: string; content: string; format?: 'csv' | 'json' | undefined },
  ): Promise<UploadedFile> {
    const { meta } = await this.load(id);
    if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
    if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw badRequest('Files are limited to 5 MB');
    const format =
      input.format ?? (/\.json$/i.test(input.name) || /^\s*[[{]/.test(input.content) ? 'json' : 'csv');
    let records: unknown[];
    if (format === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(input.content);
      } catch {
        throw badRequest('The file is not valid JSON');
      }
      records = Array.isArray(json) ? json : (Object.values(json as object).find(Array.isArray) ?? [json]);
    } else {
      const parsed = Papa.parse<Record<string, string>>(input.content.replace(/^﻿/, ''), {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (h) => h.trim(),
      });
      if (parsed.errors.length && parsed.data.length === 0)
        throw badRequest(`Could not parse CSV: ${parsed.errors[0]!.message}`);
      records = parsed.data;
    }
    const table = inferTable(records, { maxRows: 100_000 });
    if (table.columns.length === 0) throw badRequest('The file contains no columns');
    const file = {
      id: `f_${newId()}`.slice(0, 20),
      name: input.name.slice(0, 120),
      rows: table.rows.length,
      columns: table.columns.length,
      size: Buffer.byteLength(input.content),
      uploadedAt: now(),
    };
    await this.store.saveFile(id, { ...file, table });
    return file;
  }

  async listFiles(id: string, p: Principal) {
    await this.loadViewable(id, p);
    return this.store.listFiles(id);
  }

  async deleteFile(id: string, p: Principal, fileId: string) {
    const { meta, doc } = await this.load(id);
    if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
    const users = doc.datasets.filter((d) => d.source.kind === 'upload' && d.source.fileId === fileId);
    if (users.length) throw badRequest(`File is used by dataset(s): ${users.map((d) => d.name).join(', ')}`);
    await this.store.deleteFile(id, fileId);
  }

  async prune(options: { olderThanDays: number; onlyAnonymous: boolean }): Promise<string[]> {
    const cutoff = new Date(Date.now() - options.olderThanDays * 86_400_000).toISOString();
    const ids = this.index.idsViewedBefore(cutoff, options.onlyAnonymous);
    for (const id of ids) {
      await this.store.withLock(id, () => this.store.remove(id));
      this.index.remove(id);
      this.hub.deleted(id);
    }
    return ids;
  }
}
