import { describe, expect, it } from 'vitest';
import { useCaseInfo } from './info.ts';
import type { UseCase } from './load.ts';

const file = (etag: string, size = 100) => ({ path: `/x/${etag}`, size, etag });

const base: UseCase = {
  meta: { id: 'own-data', order: 1, title: 'Own data', tab: 'Data', description: 'D', featured: true },
  prompt: 'Build it',
  doc: {} as UseCase['doc'],
  dashboardId: 'scowndata',
  video: null,
  videoSquare: null,
  poster: null,
  attachment: null,
};

describe('useCaseInfo', () => {
  it('maps a use case without media to nulls', () => {
    expect(useCaseInfo(base)).toEqual({
      id: 'own-data',
      title: 'Own data',
      tab: 'Data',
      description: 'D',
      prompt: 'Build it',
      dashboardId: 'scowndata',
      video: null,
      videoSquare: null,
      poster: null,
      attachment: null,
    });
  });

  it('gives every file a URL under the use case with its content hash as the cache key', () => {
    const info = useCaseInfo({
      ...base,
      video: file('aaaa'),
      videoSquare: file('bbbb'),
      poster: file('cccc'),
      attachment: { ...file('dddd', 2780), name: 'sales.csv', rows: 60 },
    });
    expect(info.video).toBe('/showcase/own-data/video.mp4?v=aaaa');
    expect(info.videoSquare).toBe('/showcase/own-data/video-square.mp4?v=bbbb');
    expect(info.poster).toBe('/showcase/own-data/poster.jpg?v=cccc');
    expect(info.attachment).toEqual({
      name: 'sales.csv',
      url: '/showcase/own-data/sales.csv?v=dddd',
      rows: 60,
      bytes: 2780,
    });
  });
});
