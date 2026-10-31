import {
  type AdminDashboardRow,
  type DashboardMeta,
  SHOWCASE_OWNER_ID,
  type Visibility,
} from '@patchbay/core';
import type { DB } from '../db.ts';
import type { FolderStore, StoredMeta } from './folder-store.ts';

interface Row {
  id: string;
  owner_id: string | null;
  title: string;
  visibility: Visibility;
  version: number;
  widgets: number;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  last_viewed_at: string;
  owner_email?: string | null;
}

const toMeta = (r: Row): DashboardMeta => ({
  id: r.id,
  title: r.title,
  ownerId: r.owner_id,
  visibility: r.visibility,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastViewedAt: r.last_viewed_at,
});

/** A rebuildable SQLite index over the dashboard folders, for listings and admin. */
export class DashboardIndex {
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  upsert(meta: StoredMeta, extra: { title: string; widgets: number; sizeBytes?: number }) {
    this.db
      .prepare(
        `INSERT INTO dashboards (id, owner_id, title, visibility, version, widgets, size_bytes, created_at, updated_at, last_viewed_at)
         VALUES (@id, @owner, @title, @visibility, @version, @widgets, COALESCE(@size, 0), @created, @updated, @viewed)
         ON CONFLICT(id) DO UPDATE SET owner_id = @owner, title = @title, visibility = @visibility, version = @version,
           widgets = @widgets, size_bytes = COALESCE(@size, size_bytes), updated_at = @updated, last_viewed_at = @viewed`,
      )
      .run({
        id: meta.id,
        owner: meta.ownerId,
        title: extra.title,
        visibility: meta.visibility,
        version: meta.version,
        widgets: extra.widgets,
        size: extra.sizeBytes ?? null,
        created: meta.createdAt,
        updated: meta.updatedAt,
        viewed: meta.lastViewedAt,
      });
  }

  touch(id: string, at: string) {
    this.db.prepare('UPDATE dashboards SET last_viewed_at = ? WHERE id = ?').run(at, id);
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  }

  listByOwner(ownerId: string): DashboardMeta[] {
    return (
      this.db
        .prepare('SELECT * FROM dashboards WHERE owner_id = ? ORDER BY last_viewed_at DESC')
        .all(ownerId) as unknown as Row[]
    ).map(toMeta);
  }

  listAll(): AdminDashboardRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, u.email AS owner_email FROM dashboards d
         LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.last_viewed_at DESC`,
      )
      .all() as unknown as Row[];
    return rows.map((r) => ({
      ...toMeta(r),
      ownerEmail: r.owner_email ?? null,
      sizeBytes: r.size_bytes,
      widgets: r.widgets,
    }));
  }

  /** What anonymous dashboards take on disk, as of their last write or reconcile. */
  anonymousBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM dashboards WHERE owner_id IS NULL')
      .get() as { total: number };
    return Number(row.total);
  }

  setSize(id: string, sizeBytes: number) {
    this.db.prepare('UPDATE dashboards SET size_bytes = ? WHERE id = ?').run(sizeBytes, id);
  }

  /** Anonymous dashboards still at their first version with no widgets, created before `cutoff`. */
  untouchedAnonymousBefore(cutoff: string): string[] {
    const sql = `SELECT id FROM dashboards WHERE owner_id IS NULL AND version = 1 AND widgets = 0 AND created_at < ?`;
    return (this.db.prepare(sql).all(cutoff) as { id: string }[]).map((r) => r.id);
  }

  idsViewedBefore(cutoff: string, onlyAnonymous: boolean): string[] {
    // The showcase belongs to the repository, not to a user: pruning must never take it.
    const sql = `SELECT id FROM dashboards WHERE last_viewed_at < ? AND owner_id IS NOT ?${onlyAnonymous ? ' AND owner_id IS NULL' : ''}`;
    return (this.db.prepare(sql).all(cutoff, SHOWCASE_OWNER_ID) as { id: string }[]).map((r) => r.id);
  }

  allIds(): string[] {
    return (this.db.prepare('SELECT id FROM dashboards').all() as { id: string }[]).map((r) => r.id);
  }

  /**
   * Brings the index in line with the folders: folders that disappeared are
   * dropped, folders that appeared (restored backup, manual copy) are added.
   */
  async reconcile(store: FolderStore): Promise<{ added: number; removed: number }> {
    const onDisk = new Set(await store.listIds());
    let removed = 0;
    let added = 0;
    for (const id of this.allIds()) {
      if (!onDisk.has(id) || !store.exists(id)) {
        this.remove(id);
        removed++;
      }
    }
    const indexed = new Map(
      (this.db.prepare('SELECT id, version, title, widgets FROM dashboards').all() as unknown as Row[]).map(
        (r) => [r.id, r],
      ),
    );
    for (const id of onDisk) {
      const meta = await store.readMeta(id).catch(() => null);
      if (!meta) continue;
      const known = indexed.get(id);
      if (!known) added++;
      // Title and widget count only change with the version: reading every document on every pass would parse
      // each dashboard on the disk every few minutes.
      const doc = known?.version === meta.version ? null : await store.readDoc(id).catch(() => null);
      this.upsert(meta, {
        title: doc?.title ?? known?.title ?? '(unreadable)',
        widgets: doc?.widgets.length ?? known?.widgets ?? 0,
        sizeBytes: await store.sizeOf(id),
      });
    }
    return { added, removed };
  }
}
