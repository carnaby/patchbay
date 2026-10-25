/**
 * One folder per dashboard - the source of truth.
 *
 *   data/dashboards/<id>/
 *     meta.json          ownership, visibility, version, timestamps
 *     dashboard.json     the document
 *     versions/<n>.json  recent versions (for undo of agent edits and restore)
 *     files/<fileId>.json uploaded datasets, already parsed into tables
 *
 * Delete the folder and the dashboard is gone; the SQLite index notices on the
 * next reconcile. Writes are atomic (temp file + rename) and serialised per
 * dashboard, so a crash never leaves a half-written document behind.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, DashboardDoc, DataTable, UploadedFile, VersionInfo, Visibility } from '@patchbay/core';
import { parseDashboard } from '@patchbay/core';

export interface StoredMeta {
  id: string;
  ownerId: string | null;
  /** Kept next to the id so ownership survives even if the SQLite file is lost. */
  ownerEmail: string | null;
  visibility: Visibility;
  /** SHA-256 of the edit key for anonymous dashboards. */
  editKeyHash: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string;
  lastActor?: Actor;
}

export interface StoredVersion extends VersionInfo {
  doc: DashboardDoc;
}

interface StoredFile extends UploadedFile {
  table: DataTable;
}

const ID_RE = /^[a-z0-9]{6,32}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_VERSIONS = 50;

export class FolderStore {
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = join(dataDir, 'dashboards');
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  /** Never builds a path from an unvalidated id (path traversal guard). */
  dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid dashboard id "${id}"`);
    return join(this.root, id);
  }

  exists(id: string): boolean {
    return ID_RE.test(id) && existsSync(join(this.dir(id), 'meta.json'));
  }

  /** Serialises async work per dashboard. */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(id, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    }
  }

  private async writeJson(path: string, value: unknown) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async create(meta: StoredMeta, doc: DashboardDoc, actor: Actor, changes: string[]) {
    const dir = this.dir(meta.id);
    await mkdir(join(dir, 'versions'), { recursive: true });
    await mkdir(join(dir, 'files'), { recursive: true });
    await this.writeJson(join(dir, 'dashboard.json'), doc);
    await this.writeVersion(meta.id, { version: meta.version, savedAt: meta.updatedAt, actor, changes, doc });
    await this.writeJson(join(dir, 'meta.json'), meta);
  }

  async readMeta(id: string): Promise<StoredMeta | null> {
    if (!ID_RE.test(id)) return null;
    return this.readJson<StoredMeta>(join(this.dir(id), 'meta.json'));
  }

  async writeMeta(meta: StoredMeta) {
    await this.writeJson(join(this.dir(meta.id), 'meta.json'), meta);
  }

  async readDoc(id: string): Promise<DashboardDoc | null> {
    const raw = await this.readJson<unknown>(join(this.dir(id), 'dashboard.json'));
    // Parse on read too: a hand-edited file must fail loudly, not load as empty.
    return raw === null ? null : parseDashboard(raw);
  }

  /** Writes a new document version. Caller holds the lock and has bumped meta.version. */
  async writeDoc(meta: StoredMeta, doc: DashboardDoc, actor: Actor, changes: string[]) {
    await this.writeJson(join(this.dir(meta.id), 'dashboard.json'), doc);
    await this.writeVersion(meta.id, { version: meta.version, savedAt: meta.updatedAt, actor, changes, doc });
    await this.writeMeta(meta);
  }

  private async writeVersion(id: string, version: StoredVersion) {
    const dir = join(this.dir(id), 'versions');
    await mkdir(dir, { recursive: true });
    await this.writeJson(join(dir, `${version.version}.json`), version);
    const files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f));
    if (files.length > MAX_VERSIONS) {
      const old = files
        .map((f) => Number.parseInt(f, 10))
        .sort((a, b) => a - b)
        .slice(0, files.length - MAX_VERSIONS);
      await Promise.all(old.map((v) => rm(join(dir, `${v}.json`), { force: true })));
    }
  }

  async listVersions(id: string): Promise<VersionInfo[]> {
    const dir = join(this.dir(id), 'versions');
    const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)) : [];
    const versions = await Promise.all(files.map((f) => this.readJson<StoredVersion>(join(dir, f))));
    return versions
      .filter((v): v is StoredVersion => v !== null)
      .map(({ doc: _doc, ...info }) => info)
      .sort((a, b) => b.version - a.version);
  }

  async readVersion(id: string, version: number): Promise<StoredVersion | null> {
    if (!Number.isInteger(version) || version < 1) return null;
    return this.readJson<StoredVersion>(join(this.dir(id), 'versions', `${version}.json`));
  }

  async saveFile(id: string, file: StoredFile) {
    if (!FILE_ID_RE.test(file.id)) throw new Error('Invalid file id');
    await mkdir(join(this.dir(id), 'files'), { recursive: true });
    await this.writeJson(join(this.dir(id), 'files', `${file.id}.json`), file);
  }

  async readFileTable(id: string, fileId: string): Promise<DataTable | null> {
    if (!FILE_ID_RE.test(fileId)) return null;
    const file = await this.readJson<StoredFile>(join(this.dir(id), 'files', `${fileId}.json`));
    return file?.table ?? null;
  }

  async listFiles(id: string): Promise<UploadedFile[]> {
    const dir = join(this.dir(id), 'files');
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const files = await Promise.all(names.map((n) => this.readJson<StoredFile>(join(dir, n))));
    return files
      .filter((f): f is StoredFile => f !== null)
      .map(({ table: _t, ...info }) => info)
      .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  }

  async deleteFile(id: string, fileId: string) {
    if (!FILE_ID_RE.test(fileId)) return;
    await rm(join(this.dir(id), 'files', `${fileId}.json`), { force: true });
  }

  async remove(id: string) {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  async listIds(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
  }

  async sizeOf(id: string): Promise<number> {
    let total = 0;
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else total += (await stat(path)).size;
      }
    };
    await walk(this.dir(id)).catch(() => undefined);
    return total;
  }
}
