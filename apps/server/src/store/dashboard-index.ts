import type { AdminDashboardRow, DashboardMeta, Visibility } from '@patchbay/core';
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

  idsViewedBefore(cutoff: string, onlyAnonymous: boolean): string[] {
    const sql = `SELECT id FROM dashboards WHERE last_viewed_at < ?${onlyAnonymous ? ' AND owner_id IS NULL' : ''}`;
    return (this.db.prepare(sql).all(cutoff) as { id: string }[]).map((r) => r.id);
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
    const indexed = new Set(this.allIds());
    for (const id of onDisk) {
      const meta = await store.readMeta(id).catch(() => null);
      if (!meta) continue;
      const doc = await store.readDoc(id).catch(() => null);
      if (!indexed.has(id)) added++;
      this.upsert(meta, {
        title: doc?.title ?? '(unreadable)',
        widgets: doc?.widgets.length ?? 0,
        sizeBytes: await store.sizeOf(id),
      });
    }
    return { added, removed };
  }
}
