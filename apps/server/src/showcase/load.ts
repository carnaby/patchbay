import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DashboardDoc,
  parseDashboard,
  type UseCaseMeta,
  UseCaseMetaSchema,
  useCaseDashboardId,
} from '@patchbay/core';

/** The landing page loads these over the visitor's connection; the limits keep the repo and the image small too. */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const MAX_POSTER_BYTES = 150 * 1024;
export const MAX_PROMPT_CHARS = 4000;

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
  poster: MediaFile | null;
}

function media(path: string, max: number, warn: (m: string) => void): MediaFile | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size > max) {
    warn(`[patchbay] showcase: ${path} is ${size} bytes, more than ${max}; not served`);
    return null;
  }
  const etag = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  return { path, size, etag };
}

/**
 * Reads every use case folder. A broken folder is skipped with a warning instead of stopping the server: the showcase
 * is decoration, the dashboards people rely on must still come up.
 */
export function loadUseCases(dir: string, warn: (message: string) => void = console.warn): UseCase[] {
  if (!existsSync(dir)) return [];
  const out: UseCase[] = [];
  const ids = new Map<string, string>();
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const folder of folders.sort()) {
    const base = join(dir, folder);
    try {
      const meta = UseCaseMetaSchema.parse(JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')));
      if (meta.id !== folder) throw new Error(`meta.json id "${meta.id}" does not match the folder name`);
      const prompt = readFileSync(join(base, 'prompt.md'), 'utf8').trim();
      if (!prompt || prompt.length > MAX_PROMPT_CHARS)
        throw new Error(`prompt.md must have 1–${MAX_PROMPT_CHARS} characters`);
      const doc = parseDashboard(JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8')));
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
        poster: media(join(base, 'poster.jpg'), MAX_POSTER_BYTES, warn),
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
