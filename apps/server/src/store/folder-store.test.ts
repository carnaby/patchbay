import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor, type DashboardDoc, emptyDashboard, inferTable } from '@patchbay/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderStore, MAX_VERSION_BYTES, MAX_VERSIONS, type StoredMeta } from './folder-store.ts';

const actor: Actor = { kind: 'anonymous', label: 'Anonymous' };
let dir: string;
let store: FolderStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-store-'));
  store = new FolderStore(dir);
  await store.init();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function meta(id: string, version = 1): StoredMeta {
  const at = new Date(Date.UTC(2026, 0, 1, 0, version)).toISOString();
  return {
    id,
    ownerId: null,
    ownerEmail: null,
    visibility: 'public',
    editKeyHash: null,
    version,
    createdAt: at,
    updatedAt: at,
    lastViewedAt: at,
  };
}

/** A document of roughly `bytes` bytes; the store does not validate sizes, the service does. */
const docOf = (title: string, bytes = 0): DashboardDoc => ({
  ...emptyDashboard(title),
  description: 'x'.repeat(bytes),
});

async function writeVersions(id: string, count: number, bytes = 0) {
  await store.create(meta(id), docOf('v1', bytes), actor, ['Created']);
  for (let v = 2; v <= count; v++)
    await store.writeDoc(meta(id, v), docOf(`v${v}`, bytes), actor, [`Edit ${v}`]);
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

describe('FolderStore', () => {
  it('writes compact JSON', async () => {
    await writeVersions('compact1', 2);
    const folder = join(dir, 'dashboards', 'compact1');
    for (const file of ['dashboard.json', 'meta.json', 'versions/2.json', 'versions/index.json']) {
      expect(readFileSync(join(folder, file), 'utf8')).not.toContain('\n');
    }
  });

  it('lists versions from the index without reading any document', async () => {
    await writeVersions('listing1', 3);
    const versionsDir = join(dir, 'dashboards', 'listing1', 'versions');
    // Unparseable version files prove the listing never opens them.
    for (const v of [1, 2, 3]) writeFileSync(join(versionsDir, `${v}.json`), 'not json at all');
    const list = await store.listVersions('listing1');
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(list[0]).toEqual({ version: 3, savedAt: meta('x', 3).updatedAt, actor, changes: ['Edit 3'] });
    expect(list[0]).not.toHaveProperty('bytes');
  });

  it('rebuilds a missing index from the version headers only', async () => {
    await writeVersions('rebuild1', 2);
    const versionsDir = join(dir, 'dashboards', 'rebuild1', 'versions');
    rmSync(join(versionsDir, 'index.json'));
    // Everything after the "doc" key is garbage: only the header may be parsed.
    const header = JSON.stringify({ version: 2, savedAt: 'then', actor, changes: ['Edit 2'] }).slice(0, -1);
    writeFileSync(join(versionsDir, '2.json'), `${header},"doc":{{{ broken`);
    const list = await store.listVersions('rebuild1');
    expect(list).toEqual([
      { version: 2, savedAt: 'then', actor, changes: ['Edit 2'] },
      { version: 1, savedAt: meta('x', 1).updatedAt, actor, changes: ['Created'] },
    ]);
    expect(readdirSync(versionsDir)).toContain('index.json');
  });

  it('keeps at most MAX_VERSIONS versions', async () => {
    await writeVersions('count01', MAX_VERSIONS + 5);
    const list = await store.listVersions('count01');
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(list.at(-1)!.version).toBe(6);
    expect(readdirSync(join(dir, 'dashboards', 'count01', 'versions'))).toHaveLength(MAX_VERSIONS + 1);
  });

  it('keeps versions within a byte budget, and always the newest one', async () => {
    const big = Math.floor(MAX_VERSION_BYTES / 3) - 1000;
    await writeVersions('bytes01', 6, big);
    const list = await store.listVersions('bytes01');
    expect(list.map((v) => v.version)).toEqual([6, 5, 4]);
    const versionsDir = join(dir, 'dashboards', 'bytes01', 'versions');
    expect(readdirSync(versionsDir).sort()).toEqual(['4.json', '5.json', '6.json', 'index.json']);

    await store.writeDoc(meta('bytes01', 7), docOf('huge', MAX_VERSION_BYTES + 10), actor, ['Huge']);
    expect((await store.listVersions('bytes01')).map((v) => v.version)).toEqual([7]);
    expect((await store.readVersion('bytes01', 7))!.doc.title).toBe('huge');
  });

  it('reads folders written pretty-printed by earlier releases', async () => {
    const folder = join(dir, 'dashboards', 'legacy01');
    mkdirSync(join(folder, 'versions'), { recursive: true });
    mkdirSync(join(folder, 'files'), { recursive: true });
    const doc = emptyDashboard('Legacy');
    writeFileSync(join(folder, 'meta.json'), pretty(meta('legacy01', 2)));
    writeFileSync(join(folder, 'dashboard.json'), pretty(doc));
    for (const v of [1, 2]) {
      const version = { version: v, savedAt: `t${v}`, actor, changes: [`c${v}`], doc };
      writeFileSync(join(folder, 'versions', `${v}.json`), pretty(version));
    }
    // Earlier uploads: pretty-printed, one object per row.
    const table = inferTable([
      { day: 1, city: 'Oslo' },
      { day: 2, city: 'Rome' },
    ]);
    const file = { id: 'f_old', name: 'old.csv', rows: 2, columns: 2, size: 20, uploadedAt: 'u', table };
    writeFileSync(join(folder, 'files', 'f_old.json'), pretty(file));

    expect((await store.readMeta('legacy01'))!.version).toBe(2);
    expect((await store.readDoc('legacy01'))!.title).toBe('Legacy');
    expect(await store.listVersions('legacy01')).toEqual([
      { version: 2, savedAt: 't2', actor, changes: ['c2'] },
      { version: 1, savedAt: 't1', actor, changes: ['c1'] },
    ]);
    expect((await store.readVersion('legacy01', 1))!.doc.title).toBe('Legacy');
    expect(await store.readFileTable('legacy01', 'f_old')).toEqual(table);
    const [listed] = await store.listFiles('legacy01');
    expect(listed).toEqual({
      id: 'f_old',
      name: 'old.csv',
      rows: 2,
      columns: 2,
      size: 20,
      storedBytes: statSync(join(folder, 'files', 'f_old.json')).size,
      uploadedAt: 'u',
    });

    // The next write stores compact JSON and keeps the old history.
    await store.writeDoc(meta('legacy01', 3), emptyDashboard('Now'), actor, ['c3']);
    expect(readFileSync(join(folder, 'dashboard.json'), 'utf8')).not.toContain('\n');
    expect((await store.listVersions('legacy01')).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('stores uploads with rows as arrays and reads them back as objects', async () => {
    await store.create(meta('files01'), emptyDashboard(), actor, ['Created']);
    const table = inferTable(
      Array.from({ length: 50 }, (_, i) => ({ when: '2026-01-01', city: 'Oslo', n: i })),
    );
    const file = { id: 'f_new', name: 'n.csv', rows: 50, columns: 3, size: 1000, uploadedAt: 'u', table };
    let checked = 0;
    const bytes = await store.saveFile('files01', file, (b) => {
      checked = b;
    });
    const path = join(dir, 'dashboards', 'files01', 'files', 'f_new.json');
    expect(bytes).toBe(statSync(path).size);
    expect(checked).toBe(bytes);
    // Column names once, not once per row.
    expect(readFileSync(path, 'utf8').split('"city"')).toHaveLength(2);
    expect(await store.readFileTable('files01', 'f_new')).toEqual(table);
    expect((await store.listFiles('files01'))[0]!.storedBytes).toBe(bytes);

    await expect(
      store.saveFile('files01', { ...file, id: 'f_refused' }, () => {
        throw new Error('no room');
      }),
    ).rejects.toThrow('no room');
    expect(readdirSync(join(dir, 'dashboards', 'files01', 'files'))).toEqual(['f_new.json']);
  });

  it('shares uploads between dashboards without copying bytes', async () => {
    await store.create(meta('share01'), emptyDashboard(), actor, ['Created']);
    await store.create(meta('share02'), emptyDashboard(), actor, ['Created']);
    const table = inferTable(Array.from({ length: 2000 }, (_, i) => ({ n: i, label: `row ${i}` })));
    const file = { id: 'f_shared', name: 's.csv', rows: 2000, columns: 2, size: 1, uploadedAt: 'u', table };
    const bytes = await store.saveFile('share01', file);
    const before = await store.sizeOf('share01');

    await store.linkFile('share01', 'share02', 'f_shared');
    const original = statSync(join(dir, 'dashboards', 'share01', 'files', 'f_shared.json'));
    const copy = statSync(join(dir, 'dashboards', 'share02', 'files', 'f_shared.json'));
    expect(copy.ino).toBe(original.ino);
    expect(copy.nlink).toBe(2);
    // Each dashboard carries half of the shared file, so the sum matches the disk.
    expect(await store.sizeOf('share01')).toBeLessThan(before - bytes / 2 + 10);

    await store.remove('share01');
    expect(await store.readFileTable('share02', 'f_shared')).toEqual(table);
    await store.deleteFile('share02', 'f_shared');
    expect(await store.readFileTable('share02', 'f_shared')).toBeNull();
  });

  it('loads every stored upload shape and lists each from its header, without rewriting anything', async () => {
    await store.create(meta('shapes01'), emptyDashboard(), actor, ['Created']);
    const files = join(dir, 'dashboards', 'shapes01', 'files');
    const table = inferTable([
      { day: 1, city: 'Oslo' },
      { day: 2, city: 'Rome' },
    ]);
    const describe = (id: string) => ({
      id,
      name: `${id}.csv`,
      rows: 2,
      columns: 2,
      size: 20,
      uploadedAt: id,
    });
    // Early releases: pretty-printed, rows as objects.
    writeFileSync(join(files, 'f_pretty.json'), pretty({ ...describe('f_pretty'), table }));
    // A pre-release build: compact rows as objects, plus a separate description file.
    writeFileSync(join(files, 'f_info.json'), JSON.stringify({ ...describe('f_info'), table }));
    writeFileSync(join(files, 'f_info.info.json'), JSON.stringify(describe('f_info')));
    // Current: compact, rows as arrays (written by saveFile).
    await store.saveFile('shapes01', { ...describe('f_packed'), table });
    // Not written by any release, but readable: the table first, so only a full parse finds the description.
    writeFileSync(join(files, 'f_odd.json'), JSON.stringify({ table, ...describe('f_odd') }));
    const before = Object.fromEntries(readdirSync(files).map((f) => [f, statSync(join(files, f)).mtimeMs]));

    for (const id of ['f_pretty', 'f_info', 'f_packed', 'f_odd'])
      expect(await store.readFileTable('shapes01', id)).toEqual(table);
    const listed = await store.listFiles('shapes01');
    expect(listed.map((f) => f.id)).toEqual(['f_info', 'f_odd', 'f_packed', 'f_pretty']);
    for (const f of listed) {
      expect(f).toEqual({ ...describe(f.id), storedBytes: statSync(join(files, `${f.id}.json`)).size });
    }
    const after = Object.fromEntries(readdirSync(files).map((f) => [f, statSync(join(files, f)).mtimeMs]));
    expect(after).toEqual(before);

    await store.deleteFile('shapes01', 'f_info');
    expect(readdirSync(files)).not.toContain('f_info.info.json');
  });

  it('stamps a shared upload the same in every dashboard, with the time it was written', async () => {
    await store.create(meta('stamp01'), emptyDashboard(), actor, ['Created']);
    await store.create(meta('stamp02'), emptyDashboard(), actor, ['Created']);
    const table = inferTable([{ n: 1 }]);
    const file = { id: 'f_s', name: 's.csv', rows: 1, columns: 1, size: 1, uploadedAt: 'u', table };
    await store.saveFile('stamp01', file);
    await store.linkFile('stamp01', 'stamp02', 'f_s');
    const a = (await store.fileStamp('stamp01', 'f_s'))!;
    const b = (await store.fileStamp('stamp02', 'f_s'))!;
    expect(b).toEqual(a);
    expect(a.mtimeMs).toBe(
      Math.floor(statSync(join(dir, 'dashboards', 'stamp01', 'files', 'f_s.json')).mtimeMs),
    );
    await store.listFiles('stamp02');
    await store.readFileTable('stamp02', 'f_s');
    expect(await store.fileStamp('stamp02', 'f_s')).toEqual(a);

    await store.remove('stamp01');
    expect(await store.fileStamp('stamp01', 'f_s')).toBeNull();
    expect(await store.fileStamp('stamp02', 'f_s')).toEqual(a);
    expect(await store.listFiles('stamp02')).toEqual([
      {
        id: 'f_s',
        name: 's.csv',
        rows: 1,
        columns: 1,
        size: 1,
        uploadedAt: 'u',
        storedBytes: statSync(join(dir, 'dashboards', 'stamp02', 'files', 'f_s.json')).size,
      },
    ]);
    // Alone again, the copy carries the whole file.
    const bytes = statSync(join(dir, 'dashboards', 'stamp02', 'files', 'f_s.json')).size;
    expect(statSync(join(dir, 'dashboards', 'stamp02', 'files', 'f_s.json')).nlink).toBe(1);
    expect(await store.sizeOf('stamp02')).toBeGreaterThanOrEqual(bytes);
  });

  it('shares one parse between concurrent readers and never serves a read from before a write', async () => {
    await store.create(meta('reads01'), emptyDashboard('one'), actor, ['Created']);
    const [a, b] = await Promise.all([store.readDoc('reads01'), store.readDoc('reads01')]);
    expect(a).toBe(b);
    const pending = store.readDoc('reads01');
    await store.writeDoc(meta('reads01', 2), emptyDashboard('two'), actor, ['Renamed']);
    await pending;
    expect((await store.readDoc('reads01'))!.title).toBe('two');
  });

  it('keeps one parsed copy and one serialised copy for sequential readers, and notices edits by hand', async () => {
    await store.create(meta('cache01'), emptyDashboard('one'), actor, ['Created']);
    const first = (await store.readDoc('cache01'))!;
    const second = (await store.readDoc('cache01'))!;
    expect(second).toBe(first);
    expect(store.serializedDoc(second)).toBe(store.serializedDoc(first));
    expect(JSON.parse(store.serializedDoc(first).toString())).toEqual(first);

    writeFileSync(
      join(dir, 'dashboards', 'cache01', 'dashboard.json'),
      pretty(emptyDashboard('edited by hand')),
    );
    expect((await store.readDoc('cache01'))!.title).toBe('edited by hand');
  });
});
