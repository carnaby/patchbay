/**
 * One folder per dashboard - the source of truth.
 *
 *   data/dashboards/<id>/
 *     meta.json           ownership, visibility, version, timestamps
 *     dashboard.json      the document
 *     versions/<n>.json   recent versions (for undo of agent edits and restore)
 *     versions/index.json what each version is (actor, changes, bytes), so listing never reads a document
 *     files/<fileId>.json uploaded datasets, already parsed into tables
 *
 * Delete the folder and the dashboard is gone; the SQLite index notices on the
 * next reconcile. Writes are atomic (temp file + rename) and serialised per
 * dashboard, so a crash never leaves a half-written document behind.
 *
 * Everything is written as compact JSON. Folders written by earlier releases are pretty-printed and have no
 * versions/index.json; both are read as they are, and the index is rebuilt from the version files' headers.
 */
import { existsSync } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  Actor,
  Column,
  DashboardDoc,
  DataTable,
  Row,
  Scalar,
  UploadedFile,
  VersionInfo,
  Visibility,
} from '@patchbay/core';
import { parseDashboard } from '@patchbay/core';

/**
 * How a file being replaced (temp file + rename) can look for a moment where rename over an existing file is not
 * atomic: missing to a reader, or locked to the writer while a reader has it open. Windows does this, and so do the
 * Windows folders Docker Desktop mounts into Linux containers: there, readers of a dashboard whose owner saved it
 * quickly found dashboard.json missing hundreds of times a minute and answered 404. On Linux file systems (ext4,
 * btrfs, a Docker volume) rename is atomic and none of this happens.
 */
const REPLACING_READ = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES']);
const REPLACING_WRITE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** A reader waits out one replace; a writer waits for the readers that hold the file open, which can take longer. */
const READ_RETRY_MS = [5, 15, 40, 100];
const WRITE_RETRY_MS = [5, 15, 40, 100, 250, 500];

/** Repeats `attempt` briefly while it fails the way a replace in progress does and `exists` says it should not. */
async function duringReplace<T>(
  attempt: () => Promise<T>,
  codes: ReadonlySet<string>,
  exists: () => boolean,
  delays = READ_RETRY_MS,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= delays.length || !code || !codes.has(code) || !exists()) throw e;
      await sleep(delays[i]);
    }
  }
}

let tmpSeq = 0;

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

interface VersionEntry extends VersionInfo {
  /** Size of the version file on disk. */
  bytes: number;
}

export interface FileStamp {
  key: string;
  mtimeMs: number;
  /** Size on disk. */
  bytes: number;
}

interface StoredFile extends UploadedFile {
  table: DataTable;
}

/**
 * How a table is written: rows as arrays in column order. Repeating every column name on every row made a stored
 * upload several times larger than the CSV it came from.
 */
interface PackedTable {
  columns: Column[];
  data: Scalar[][];
}

const ID_RE = /^[a-z0-9]{6,32}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** An upload's data file; `<fileId>.info.json` (a pre-release description file) does not match. */
const UPLOAD_FILE_RE = /^[a-zA-Z0-9_-]{1,64}\.json$/;
const VERSION_FILE_RE = /^\d+\.json$/;
const VERSION_INDEX = 'index.json';
export const MAX_VERSIONS = 50;
/** Versions are full documents: without a byte budget, 50 copies of a large one were most of a disk. */
export const MAX_VERSION_BYTES = 10 * 1024 * 1024;
/** File bytes of parsed documents kept in memory; parsed, a document takes a few times its file size. */
const DOC_CACHE_BYTES = 8 * 1024 * 1024;
/** Enough for the metadata in front of a version's document or a file's table. */
const HEAD_BYTES = 64 * 1024;

let linkFallbackLogged = false;

/**
 * Reads only the leading properties of a JSON object written with `bulky` as its last property, without parsing
 * the bulky part. Returns null when the head cannot be read that way.
 */
async function readHead(path: string, bulky: string): Promise<Record<string, unknown> | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Inside a JSON string every quote is escaped, so an unescaped `,"doc":` can only be the property itself. The
    // metadata objects in front of it (actor) never have such a property.
    const match = new RegExp(`,\\s*"${bulky}"\\s*:`).exec(text);
    if (!match) return null;
    const head = JSON.parse(`${text.slice(0, match.index)}}`) as unknown;
    return head && typeof head === 'object' ? (head as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function isActor(value: unknown): value is Actor {
  const a = value as Actor | null;
  return Boolean(a && typeof a === 'object' && typeof a.kind === 'string' && typeof a.label === 'string');
}

function packTable(table: DataTable): PackedTable {
  return {
    columns: table.columns,
    data: table.rows.map((row) => table.columns.map((c) => row[c.name] ?? null)),
  };
}

function unpackTable(stored: DataTable | PackedTable): DataTable {
  if (!('data' in stored)) return stored;
  const names = stored.columns.map((c) => c.name);
  return {
    columns: stored.columns,
    rows: stored.data.map((values) => {
      const row: Row = {};
      for (let i = 0; i < names.length; i++) row[names[i]!] = values[i] ?? null;
      return row;
    }),
  };
}

export class FolderStore {
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Parsed documents shared by everyone reading them: a crowd of viewers holds one copy of a document (and one
   * serialised response body, see `serializedDoc`) instead of one each, which is what ran a small server out of
   * memory. Documents are never mutated in place (applyOps returns a new one), so sharing them is safe. Every write
   * through this class drops the entry; the file's mtime and size catch edits made by hand.
   */
  private readonly docCache = new Map<string, { mtimeMs: number; size: number; doc: DashboardDoc }>();
  private docCacheBytes = 0;
  /** Reads in flight, so concurrent first readers share one parse too. */
  private readonly docReads = new Map<string, Promise<DashboardDoc | null>>();
  private readonly serialized = new WeakMap<DashboardDoc, Buffer>();

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

  private async writeText(path: string, text: string) {
    const tmp = `${path}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;
    await writeFile(tmp, text);
    try {
      await duringReplace(
        () => rename(tmp, path),
        REPLACING_WRITE,
        () => true,
        WRITE_RETRY_MS,
      );
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  private async writeJson(path: string, value: unknown) {
    await this.writeText(path, JSON.stringify(value));
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
    this.forgetDoc(meta.id);
    await this.writeVersion(meta.id, { version: meta.version, savedAt: meta.updatedAt, actor, changes, doc });
    await this.writeJson(join(dir, 'meta.json'), meta);
  }

  async readMeta(id: string): Promise<StoredMeta | null> {
    if (!ID_RE.test(id)) return null;
    const dir = this.dir(id);
    // A deleted dashboard has no folder: it answers at once, without waiting for a replace that is not happening.
    return this.readReplaced<StoredMeta>(join(dir, 'meta.json'), () => existsSync(dir));
  }

  /** A file that is replaced in place (meta.json, dashboard.json), read through a replace in progress. */
  private async readReplaced<T>(path: string, exists: () => boolean): Promise<T | null> {
    try {
      return JSON.parse(await duringReplace(() => readFile(path, 'utf8'), REPLACING_READ, exists)) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async writeMeta(meta: StoredMeta) {
    await this.writeJson(join(this.dir(meta.id), 'meta.json'), meta);
  }

  async readDoc(id: string): Promise<DashboardDoc | null> {
    const path = join(this.dir(id), 'dashboard.json');
    const exists = () => existsSync(join(this.dir(id), 'meta.json'));
    const info = await duringReplace(() => stat(path), REPLACING_READ, exists).catch(() => null);
    if (!info) return null;
    const cached = this.docCache.get(id);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      // Map order is the eviction order: most recently used last.
      this.docCache.delete(id);
      this.docCache.set(id, cached);
      return cached.doc;
    }
    const pending = this.docReads.get(id);
    if (pending) return pending;
    const read: Promise<DashboardDoc | null> = this.readReplaced<unknown>(path, exists).then((raw) => {
      if (raw === null) return null;
      // Parse on read too: a hand-edited file must fail loudly, not load as empty.
      const doc = parseDashboard(raw);
      // A write while this read was running dropped the entry; its result must not be cached as current.
      if (this.docReads.get(id) === read) this.cacheDoc(id, info.mtimeMs, info.size, doc);
      return doc;
    });
    this.docReads.set(id, read);
    try {
      return await read;
    } finally {
      if (this.docReads.get(id) === read) this.docReads.delete(id);
    }
  }

  private cacheDoc(id: string, mtimeMs: number, size: number, doc: DashboardDoc) {
    this.forgetDoc(id);
    // Documents from before the size limit can be far larger; they are read each time rather than crowd out the rest.
    if (size > DOC_CACHE_BYTES / 4) return;
    this.docCache.set(id, { mtimeMs, size, doc });
    this.docCacheBytes += size;
    for (const [oldest, entry] of this.docCache) {
      if (this.docCacheBytes <= DOC_CACHE_BYTES) break;
      this.docCache.delete(oldest);
      this.docCacheBytes -= entry.size;
    }
  }

  private forgetDoc(id: string) {
    this.docReads.delete(id);
    const entry = this.docCache.get(id);
    if (!entry) return;
    this.docCache.delete(id);
    this.docCacheBytes -= entry.size;
  }

  /**
   * The document as JSON bytes, made once per parsed document. Responses send this buffer as it is, so concurrent
   * viewers do not each build a copy of a large document.
   */
  serializedDoc(doc: DashboardDoc): Buffer {
    let bytes = this.serialized.get(doc);
    if (!bytes) {
      bytes = Buffer.from(JSON.stringify(doc));
      this.serialized.set(doc, bytes);
    }
    return bytes;
  }

  /** Writes a new document version. Caller holds the lock and has bumped meta.version. */
  async writeDoc(meta: StoredMeta, doc: DashboardDoc, actor: Actor, changes: string[]) {
    await this.writeJson(join(this.dir(meta.id), 'dashboard.json'), doc);
    this.forgetDoc(meta.id);
    await this.writeVersion(meta.id, { version: meta.version, savedAt: meta.updatedAt, actor, changes, doc });
    await this.writeMeta(meta);
  }

  /** What a version file holds, from its header only. Files from before the index are read this way once. */
  private async describeVersion(dir: string, version: number): Promise<VersionEntry> {
    const path = join(dir, `${version}.json`);
    const info = await stat(path);
    const head = await readHead(path, 'doc');
    const changes = Array.isArray(head?.changes) ? head.changes.filter((c) => typeof c === 'string') : [];
    return {
      version,
      savedAt: typeof head?.savedAt === 'string' ? head.savedAt : info.mtime.toISOString(),
      actor: isActor(head?.actor) ? head.actor : { kind: 'system', label: 'Unknown' },
      changes,
      bytes: info.size,
    };
  }

  /**
   * The version index brought in line with the version files: entries without a file are dropped, files without
   * an entry (an older folder, or a crash between the two writes) are described from their header. Caller holds
   * the lock. Oldest first.
   */
  private async versionEntries(id: string): Promise<{ entries: VersionEntry[]; changed: boolean }> {
    const dir = join(this.dir(id), 'versions');
    if (!existsSync(dir)) return { entries: [], changed: false };
    const onDisk = new Set(
      (await readdir(dir)).filter((f) => VERSION_FILE_RE.test(f)).map((f) => Number.parseInt(f, 10)),
    );
    const stored = await this.readJson<unknown>(join(dir, VERSION_INDEX)).catch(() => null);
    const indexed = Array.isArray(stored) ? (stored as VersionEntry[]) : [];
    const entries = indexed.filter((e) => Number.isInteger(e?.version) && onDisk.has(e.version));
    let changed = !Array.isArray(stored) || entries.length !== indexed.length;
    const known = new Set(entries.map((e) => e.version));
    for (const version of onDisk) {
      if (known.has(version)) continue;
      entries.push(await this.describeVersion(dir, version));
      changed = true;
    }
    entries.sort((a, b) => a.version - b.version);
    return { entries, changed };
  }

  private async writeVersion(id: string, version: StoredVersion) {
    const dir = join(this.dir(id), 'versions');
    await mkdir(dir, { recursive: true });
    const { entries } = await this.versionEntries(id);
    // `doc` goes last, so the header can be read without parsing the document (see readHead).
    const { doc, ...info } = version;
    const text = JSON.stringify({ ...info, doc });
    await this.writeText(join(dir, `${version.version}.json`), text);
    const all = [
      ...entries.filter((e) => e.version !== version.version),
      { ...info, bytes: Buffer.byteLength(text) },
    ];
    // Newest first, within both budgets, without gaps; the newest version always stays, however large.
    const keep: VersionEntry[] = [];
    let bytes = 0;
    for (const entry of all.sort((a, b) => b.version - a.version)) {
      if (keep.length > 0 && (keep.length >= MAX_VERSIONS || bytes + entry.bytes > MAX_VERSION_BYTES)) break;
      keep.push(entry);
      bytes += entry.bytes;
    }
    const dropped = all.slice(keep.length);
    await this.writeJson(join(dir, VERSION_INDEX), keep);
    await Promise.all(dropped.map((e) => rm(join(dir, `${e.version}.json`), { force: true })));
  }

  /** Newest first. Reads the small index, never a document. */
  async listVersions(id: string): Promise<VersionInfo[]> {
    return this.withLock(id, async () => {
      const { entries, changed } = await this.versionEntries(id);
      if (changed)
        await this.writeJson(join(this.dir(id), 'versions', VERSION_INDEX), [...entries].reverse());
      return entries.map(({ bytes: _bytes, ...info }) => info).reverse();
    });
  }

  async readVersion(id: string, version: number): Promise<StoredVersion | null> {
    if (!Number.isInteger(version) || version < 1) return null;
    return this.readJson<StoredVersion>(join(this.dir(id), 'versions', `${version}.json`));
  }

  /**
   * Writes an uploaded file and returns its size on disk. `check` sees that size before anything is written and
   * throws to refuse the file. The description goes first and the table last, so listing reads only the header.
   */
  async saveFile(id: string, file: StoredFile, check?: (bytes: number) => void): Promise<number> {
    if (!FILE_ID_RE.test(file.id)) throw new Error('Invalid file id');
    // The size on disk is read from the file system, never stored next to the data it describes.
    const { table, storedBytes: _stored, ...info } = file;
    // `table` goes last, so listing files reads only the header (see readHead).
    const text = JSON.stringify({ ...info, table: packTable(table) });
    const bytes = Buffer.byteLength(text);
    check?.(bytes);
    await mkdir(join(this.dir(id), 'files'), { recursive: true });
    await this.writeText(join(this.dir(id), 'files', `${file.id}.json`), text);
    return bytes;
  }

  async readFileTable(id: string, fileId: string): Promise<DataTable | null> {
    if (!FILE_ID_RE.test(fileId)) return null;
    const file = await this.readJson<{ table: DataTable | PackedTable }>(
      join(this.dir(id), 'files', `${fileId}.json`),
    );
    return file?.table ? unpackTable(file.table) : null;
  }

  /**
   * Metadata of the uploaded files, read from their headers: listing must not parse every table. All stored shapes
   * put the table last (pretty-printed object rows from early releases, compact object rows, packed rows), so the
   * header read works for each; `<fileId>.info.json` descriptions written by a pre-release build are used only when
   * it does not. Nothing is written here: rewriting a file would break the hard links copies share it through.
   */
  async listFiles(id: string): Promise<UploadedFile[]> {
    const dir = join(this.dir(id), 'files');
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((f) => UPLOAD_FILE_RE.test(f));
    const files: UploadedFile[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      let head = (await readHead(path, 'table')) as Partial<UploadedFile> | null;
      if (!head || typeof head.id !== 'string') {
        head = await this.readJson<UploadedFile>(path.replace(/\.json$/, '.info.json')).catch(() => null);
      }
      if (!head || typeof head.id !== 'string') {
        const full = await this.readJson<StoredFile>(path).catch(() => null);
        if (!full) continue;
        const { table: _t, ...rest } = full;
        head = rest;
      }
      files.push({
        id: String(head.id),
        name: String(head.name ?? head.id),
        rows: Number(head.rows ?? 0),
        columns: Number(head.columns ?? 0),
        size: Number(head.size ?? 0),
        storedBytes: info.size,
        uploadedAt: String(head.uploadedAt ?? info.mtime.toISOString()),
      });
    }
    return files.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  }

  /**
   * Identifies the stored bytes of an upload; null when there is no such file. `key` changes whenever the file is
   * replaced and is the same for every dashboard that shares the file through a hard link, so a cache of parsed
   * tables holds a shared file once. `mtimeMs` is when the file was written: an upload's reading time, stable
   * however often it is read.
   */
  async fileStamp(id: string, fileId: string): Promise<FileStamp | null> {
    if (!FILE_ID_RE.test(fileId)) return null;
    try {
      const s = await stat(join(this.dir(id), 'files', `${fileId}.json`), { bigint: true });
      // Some file systems report no inode numbers; there the path is the identity (and copies are never shared).
      const identity = s.ino === 0n ? `${id}/${fileId}` : `${s.dev}:${s.ino}`;
      return { key: `${identity}@${s.mtimeNs}:${s.size}`, mtimeMs: Number(s.mtimeMs), bytes: Number(s.size) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Gives dashboard `toId` the uploaded file of `fromId` without copying its bytes: a hard link, so the file
   * system counts the references and either dashboard can be deleted on its own. Files are never rewritten in
   * place (new uploads get new ids), so sharing one is safe. Copies only where links are not supported.
   */
  async linkFile(fromId: string, toId: string, fileId: string) {
    if (!FILE_ID_RE.test(fileId)) throw new Error('Invalid file id');
    const source = join(this.dir(fromId), 'files', `${fileId}.json`);
    const target = join(this.dir(toId), 'files', `${fileId}.json`);
    if (!existsSync(source)) return;
    await mkdir(join(this.dir(toId), 'files'), { recursive: true });
    try {
      await link(source, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
      if (!linkFallbackLogged) {
        linkFallbackLogged = true;
        console.warn(
          `[patchbay] hard links are not supported in DATA_DIR (${(e as NodeJS.ErrnoException).code}); copies of dashboards copy their uploads`,
        );
      }
      // Preserves the mtime, which is the upload's reading time (see fileStamp).
      await copyFile(source, target);
      const { atime, mtime } = await stat(source);
      await utimes(target, atime, mtime);
    }
  }

  async deleteFile(id: string, fileId: string) {
    if (!FILE_ID_RE.test(fileId)) return;
    await rm(join(this.dir(id), 'files', `${fileId}.json`), { force: true });
    // Left behind by a pre-release build that described files separately.
    await rm(join(this.dir(id), 'files', `${fileId}.info.json`), { force: true });
  }

  async remove(id: string) {
    await rm(this.dir(id), { recursive: true, force: true });
    this.forgetDoc(id);
  }

  async listIds(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
  }

  /**
   * Bytes the dashboard takes on disk. A file shared with other dashboards (hard links) counts in equal parts, so
   * the sizes of all dashboards add up to what the disk actually holds.
   */
  async sizeOf(id: string): Promise<number> {
    let total = 0;
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else {
          const info = await stat(path).catch(() => null);
          if (info) total += Math.ceil(info.size / Math.max(info.nlink, 1));
        }
      }
    };
    await walk(this.dir(id)).catch(() => undefined);
    return total;
  }
}
