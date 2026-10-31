import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUseCases, MAX_POSTER_BYTES, MAX_VIDEO_BYTES } from './load.ts';

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
    for (const d of readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const video = join(DIR, d.name, 'video.mp4');
      const poster = join(DIR, d.name, 'poster.jpg');
      if (existsSync(video)) expect(statSync(video).size, video).toBeLessThanOrEqual(MAX_VIDEO_BYTES);
      if (existsSync(poster)) expect(statSync(poster).size, poster).toBeLessThanOrEqual(MAX_POSTER_BYTES);
    }
  });
});
