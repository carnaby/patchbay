import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DashboardDoc,
  docSecretIds,
  parseCsv,
  parseDashboard,
  type UseCaseMeta,
  UseCaseMetaSchema,
  useCaseDashboardId,
} from '@patchbay/core';
import { documentBytes, MAX_DOCUMENT_BYTES } from '../services/dashboards.ts';

/** The landing page loads these over the visitor's connection; the limits keep the repo and the image small too. */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const MAX_POSTER_BYTES = 150 * 1024;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_ATTACHMENT_BYTES = 200 * 1024;

export interface MediaFile {
  path: string;
  size: number;
  /** First 16 hex chars of the content's SHA-256: a stable ETag and cache key across restarts and deploys. */
  etag: string;
}

export interface UseCase {
  meta: UseCaseMeta;
  prompt: string;
  doc: DashboardDoc;
  dashboardId: string;
  video: MediaFile | null;
  /** The 1:1 cut for narrow screens. */
  videoSquare: MediaFile | null;
  poster: MediaFile | null;
  attachment: Attachment | null;
}

export interface Attachment extends MediaFile {
  name: string;
  /** Data rows, without the header. */
  rows: number;
}

function media(path: string, max: number, warn: (m: string) => void): MediaFile | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size > max) {
    warn(`[patchbay] showcase: ${path} is ${size} bytes, more than ${max}; not served`);
    return null;
  }
  return { path, size, etag: hashFile(path) };
}

/**
 * The file the prompt came with. A broken one is dropped with a warning and the use case stays: the prompt and the
 * dashboard still make sense without it. It must be a rectangular CSV with a header and at least one row, because
 * the landing page shows it as a table.
 */
function attachment(base: string, name: string, warn: (m: string) => void): Attachment | null {
  const path = join(base, name);
  const drop = (why: string) => {
    warn(`[patchbay] showcase: ${path} ${why}; not served`);
    return null;
  };
  if (!existsSync(path)) return drop('is declared in meta.json but missing');
  const file = media(path, MAX_ATTACHMENT_BYTES, warn);
  if (!file) return null;
  let records: string[][];
  try {
    records = parseCsv(readFileSync(path, 'utf8'));
  } catch (e) {
    return drop(`is not valid CSV (${e instanceof Error ? e.message : String(e)})`);
  }
  const width = records[0]?.length ?? 0;
  if (records.length < 2) return drop('needs a header and at least one row');
  const ragged = records.findIndex((r) => r.length !== width);
  if (ragged > 0)
    return drop(`has ${records[ragged]!.length} fields on record ${ragged + 1}, the header has ${width}`);
  return { ...file, name, rows: records.length - 1 };
}

/** Hashes in chunks so a video at the size limit is never held in memory whole. */
function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null))
      hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * A use case's data must work for the owner "system" and in anonymous copies: uploads are stored per dashboard and
 * secrets belong to a user, so neither can be shared.
 */
function assertPortable(doc: DashboardDoc) {
  if (doc.datasets.some((d) => d.source.kind === 'upload'))
    throw new Error(
      'dashboard.json uses an upload source; use inline rows, a built-in connector or a public URL',
    );
  if (docSecretIds(doc).length)
    throw new Error('dashboard.json references a stored secret; a showcase cannot hold credentials');
}

/**
 * Reads every use case folder. A broken folder is skipped with a warning instead of stopping the server: the showcase
 * is decoration, the dashboards people rely on must still come up.
 */
export function loadUseCases(dir: string, warn: (message: string) => void = console.warn): UseCase[] {
  if (!existsSync(dir)) return [];
  const out: UseCase[] = [];
  const ids = new Map<string, string>();
  let folders: string[];
  try {
    folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    warn(`[patchbay] showcase: cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  for (const folder of folders.sort()) {
    const base = join(dir, folder);
    try {
      const meta = UseCaseMetaSchema.parse(JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')));
      if (meta.id !== folder) throw new Error(`meta.json id "${meta.id}" does not match the folder name`);
      const prompt = readFileSync(join(base, 'prompt.md'), 'utf8').trim();
      if (!prompt || prompt.length > MAX_PROMPT_CHARS)
        throw new Error(`prompt.md must have 1–${MAX_PROMPT_CHARS} characters`);
      const doc = parseDashboard(JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8')));
      assertPortable(doc);
      // Checked here because the sync writes the showcase directly: an oversized document would be served, and
      // every visitor's copy of it refused.
      const bytes = documentBytes(doc);
      if (bytes > MAX_DOCUMENT_BYTES)
        throw new Error(
          `dashboard.json takes ${bytes} bytes, more than the ${MAX_DOCUMENT_BYTES} a dashboard may`,
        );
      const dashboardId = useCaseDashboardId(meta.id);
      const clash = ids.get(dashboardId);
      if (clash) throw new Error(`maps to the same dashboard id as "${clash}"`);
      ids.set(dashboardId, meta.id);
      out.push({
        meta,
        prompt,
        doc,
        dashboardId,
        video: media(join(base, 'video.mp4'), MAX_VIDEO_BYTES, warn),
        videoSquare: media(join(base, 'video-square.mp4'), MAX_VIDEO_BYTES, warn),
        poster: media(join(base, 'poster.jpg'), MAX_POSTER_BYTES, warn),
        attachment: meta.attachment ? attachment(base, meta.attachment, warn) : null,
      });
    } catch (e) {
      warn(`[patchbay] showcase: skipped "${folder}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out.sort((a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id));
}

/**
 * The URLs of the showcase's own sources. They come from files in the repository, so URL_SOURCES=signed-in may let
 * anonymous copies of a use case keep loading them; matching is exact, never by prefix.
 */
export function trustedSourceUrls(useCases: readonly UseCase[]): Set<string> {
  const urls = new Set<string>();
  for (const u of useCases)
    for (const d of u.doc.datasets)
      if (d.source.kind === 'http' || d.source.kind === 'feed') urls.add(d.source.url);
  return urls;
}
