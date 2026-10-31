import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaResponse } from './media.ts';

const path = join(mkdtempSync(join(tmpdir(), 'pb-media-')), 'v.mp4');
writeFileSync(path, Buffer.from('0123456789'));
const file = { path, size: 10, etag: 'abcdef0123456789' };

describe('mediaResponse', () => {
  it('sends the whole file with caching headers', async () => {
    const r = mediaResponse(file, 'video/mp4', undefined, undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(r.headers.get('etag')).toBe('"abcdef0123456789"');
    expect(await r.text()).toBe('0123456789');
  });

  it('answers ranges with 206', async () => {
    const r = mediaResponse(file, 'video/mp4', 'bytes=2-5', undefined);
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(r.headers.get('content-length')).toBe('4');
    expect(await r.text()).toBe('2345');
    expect(await mediaResponse(file, 'video/mp4', 'bytes=7-', undefined).text()).toBe('789');
    expect(await mediaResponse(file, 'video/mp4', 'bytes=-3', undefined).text()).toBe('789');
  });

  it('answers unsatisfiable or malformed ranges with 416', () => {
    for (const range of ['bytes=999999999-', 'bytes=5-2', 'bytes=abc', 'bytes=0-1,4-5']) {
      const r = mediaResponse(file, 'video/mp4', range, undefined);
      expect(r.status).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('answers 304 when the etag matches', () => {
    expect(mediaResponse(file, 'video/mp4', undefined, '"abcdef0123456789"').status).toBe(304);
  });
});
