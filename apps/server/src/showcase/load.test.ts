import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTemplate } from '../services/templates.ts';
import { loadUseCases, MAX_VIDEO_BYTES, trustedSourceUrls } from './load.ts';

function useCase(root: string, slug: string, files: Record<string, string | Buffer>) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const meta = (id: string, order = 1) =>
  JSON.stringify({ id, order, title: `Title ${id}`, tab: 'Tab', description: 'Description.' });
const doc = (extra: object = {}) => JSON.stringify({ ...buildTemplate('blank', 'Showcase'), ...extra });

describe('loadUseCases', () => {
  it('loads valid folders sorted by order and skips broken ones with one warning each', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-showcase-'));
    useCase(root, 'second', {
      'meta.json': meta('second', 2),
      'prompt.md': 'Build B',
      'dashboard.json': doc(),
    });
    useCase(root, 'first', {
      'meta.json': meta('first', 1),
      'prompt.md': 'Build A\n',
      'dashboard.json': doc(),
    });
    useCase(root, 'bad-json', { 'meta.json': '{', 'prompt.md': 'x', 'dashboard.json': doc() });
    useCase(root, 'no-prompt', { 'meta.json': meta('no-prompt'), 'dashboard.json': doc() });
    useCase(root, 'mismatch', { 'meta.json': meta('other'), 'prompt.md': 'x', 'dashboard.json': doc() });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['first', 'second']);
    expect(loaded[0]!.prompt).toBe('Build A');
    expect(loaded[0]!.dashboardId).toBe('scfirst');
    expect(warnings).toHaveLength(3);
  });

  it('skips the second of two slugs that map to the same dashboard id', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-showcase-'));
    useCase(root, 'abcd-ef', { 'meta.json': meta('abcd-ef', 1), 'prompt.md': 'x', 'dashboard.json': doc() });
    useCase(root, 'abcdef', { 'meta.json': meta('abcdef', 2), 'prompt.md': 'y', 'dashboard.json': doc() });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['abcd-ef']);
    expect(warnings.join()).toMatch(/same dashboard id/);
  });

  it('reads media with size and etag and ignores an oversized video', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-showcase-'));
    useCase(root, 'video', {
      'meta.json': meta('video', 1),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video.mp4': Buffer.alloc(1000, 1),
      'poster.jpg': Buffer.alloc(100, 2),
    });
    useCase(root, 'too-big', {
      'meta.json': meta('too-big', 2),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video.mp4': Buffer.alloc(MAX_VIDEO_BYTES + 1, 1),
    });
    const warnings: string[] = [];
    const [video, big] = loadUseCases(root, (m) => warnings.push(m));
    expect(video!.video).toMatchObject({ size: 1000 });
    expect(video!.video!.etag).toMatch(/^[a-f0-9]{16}$/);
    expect(video!.poster).toMatchObject({ size: 100 });
    expect(big!.video).toBeNull();
    expect(warnings.join()).toMatch(/video\.mp4/);
  });

  it('returns nothing for a missing folder', () => {
    expect(loadUseCases(join(tmpdir(), 'pb-does-not-exist-xyz'), () => {})).toEqual([]);
  });

  it('collects the exact http and feed URLs as trusted sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-showcase-'));
    const datasets = [
      {
        id: 'news',
        name: 'News',
        refreshSec: 900,
        transforms: [],
        source: { kind: 'feed', url: 'https://example.org/rss', limit: 30 },
      },
      {
        id: 'api',
        name: 'API',
        refreshSec: 60,
        transforms: [],
        source: { kind: 'http', url: 'https://api.example.org/v1?x=1' },
      },
    ];
    useCase(root, 'urls', {
      'meta.json': meta('urls'),
      'prompt.md': 'x',
      'dashboard.json': doc({ datasets }),
    });
    const urls = trustedSourceUrls(loadUseCases(root, () => {}));
    expect([...urls].sort()).toEqual(['https://api.example.org/v1?x=1', 'https://example.org/rss']);
  });
});
