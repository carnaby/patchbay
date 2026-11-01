import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUseCases, MAX_ATTACHMENT_BYTES, MAX_POSTER_BYTES, MAX_VIDEO_BYTES } from './load.ts';

const DIR = join(import.meta.dirname, '../../../../showcase');

describe('the repository showcase', () => {
  it('loads every folder without warnings', () => {
    const warnings: string[] = [];
    const loaded = loadUseCases(DIR, (m) => warnings.push(m));
    const folders = existsSync(DIR)
      ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
      : [];
    expect(warnings).toEqual([]);
    expect(loaded).toHaveLength(folders.length);
  });

  it('keeps media within the size budget', () => {
    if (!existsSync(DIR)) return;
    const limits: Record<string, number> = {
      'video.mp4': MAX_VIDEO_BYTES,
      'video-square.mp4': MAX_VIDEO_BYTES,
      'poster.jpg': MAX_POSTER_BYTES,
    };
    for (const d of readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()))
      for (const name of readdirSync(join(DIR, d.name))) {
        const path = join(DIR, d.name, name);
        const max = limits[name] ?? (name.endsWith('.csv') ? MAX_ATTACHMENT_BYTES : undefined);
        if (max !== undefined) expect(statSync(path).size, path).toBeLessThanOrEqual(max);
      }
  });
});
