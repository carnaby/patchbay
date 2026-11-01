import { describe, expect, it } from 'vitest';
import { chooseVideo, playVideo, resumeAt, videoLook } from './use-case-video.ts';

const both = { video: '/v.mp4', videoSquare: '/sq.mp4' };
const none = new Set<string>();

describe('chooseVideo', () => {
  it('takes the square cut on narrow screens and the wide one otherwise', () => {
    expect(chooseVideo(both, true, none)).toEqual({ src: '/sq.mp4', square: true });
    expect(chooseVideo(both, false, none)).toEqual({ src: '/v.mp4', square: false });
  });

  it('falls back to 16:9 without a square cut', () => {
    expect(chooseVideo({ video: '/v.mp4', videoSquare: null }, true, none)).toEqual({
      src: '/v.mp4',
      square: false,
    });
  });

  it('falls back to 16:9 when the square cut failed, then to nothing', () => {
    expect(chooseVideo(both, true, new Set(['/sq.mp4']))).toEqual({ src: '/v.mp4', square: false });
    expect(chooseVideo(both, true, new Set(['/sq.mp4', '/v.mp4']))).toBeNull();
  });

  it('shows the snapshot when the wide video failed on a wide screen or there is none', () => {
    expect(chooseVideo(both, false, new Set(['/v.mp4']))).toBeNull();
    expect(chooseVideo({ video: null, videoSquare: null }, true, none)).toBeNull();
  });
});

describe('resumeAt', () => {
  it('keeps the position when the new cut is long enough', () => {
    expect(resumeAt(12.5, 30)).toBe(12.5);
  });
  it('stays short of the end, which would count as a finished video and advance the tabs', () => {
    expect(resumeAt(29.95, 30)).toBeLessThan(30);
    expect(resumeAt(40, 30)).toBeLessThan(30);
  });
  it('trusts the position while the duration is unknown', () => {
    expect(resumeAt(8, Number.NaN)).toBe(8);
    expect(resumeAt(8, Number.POSITIVE_INFINITY)).toBe(8);
  });
});

describe('playVideo', () => {
  const wanted = () => true;
  const refused = (name: string) => Object.assign(new Error(name), { name });
  /** A video whose play() answers from `results` in turn and records whether it was muted at each call. */
  const fakeVideo = (muted: boolean, results: (Error | null)[]) => {
    const calls: boolean[] = [];
    const video = {
      muted,
      play() {
        calls.push(this.muted);
        const r = results.shift() ?? null;
        return r ? Promise.reject(r) : Promise.resolve();
      },
    };
    return { video, calls };
  };

  it('plays as it is when the browser allows it', async () => {
    const { video, calls } = fakeVideo(false, [null]);
    let muted = 0;
    expect(await playVideo(video, () => muted++, wanted)).toBe('playing');
    expect(calls).toEqual([false]);
    expect(muted).toBe(0);
  });

  it('falls back to muted when sound is refused, and says so', async () => {
    const { video, calls } = fakeVideo(false, [refused('NotAllowedError'), null]);
    let muted = 0;
    expect(await playVideo(video, () => muted++, wanted)).toBe('playing');
    expect(calls).toEqual([false, true]);
    expect(video.muted).toBe(true);
    expect(muted).toBe(1);
  });

  it('reports a muted video the browser will not play on its own (iOS Low Power Mode)', async () => {
    const { video } = fakeVideo(true, [refused('NotAllowedError')]);
    expect(await playVideo(video, () => {}, wanted)).toBe('blocked');
    const unmuted = fakeVideo(false, [refused('NotAllowedError'), refused('NotAllowedError')]);
    expect(await playVideo(unmuted.video, () => {}, wanted)).toBe('blocked');
  });

  it('leaves the sound alone when the play was only interrupted', async () => {
    const { video, calls } = fakeVideo(false, [refused('AbortError')]);
    let muted = 0;
    expect(await playVideo(video, () => muted++, wanted)).toBe('interrupted');
    expect(calls).toEqual([false]);
    expect(video.muted).toBe(false);
    expect(muted).toBe(0);
  });

  it('does not retry muted once the video is no longer meant to play (scrolled away meanwhile)', async () => {
    const { video, calls } = fakeVideo(false, [refused('NotAllowedError'), null]);
    let muted = 0;
    expect(
      await playVideo(
        video,
        () => muted++,
        () => false,
      ),
    ).toBe('interrupted');
    expect(calls).toEqual([false]);
    expect(video.muted).toBe(false);
    expect(muted).toBe(0);
  });
});

describe('videoLook', () => {
  const calm = { intro: false, reduced: false, blocked: false, ready: false, poster: '/p.jpg' };
  it('hides an incoming video without a poster until its first frame, so the finished dashboard never flashes', () => {
    expect(videoLook(calm)).toEqual({ poster: null, hidden: true });
    expect(videoLook({ ...calm, ready: true })).toEqual({ poster: null, hidden: false });
  });
  it('keeps the poster on the first view, under reduced motion and when autoplay is blocked', () => {
    for (const k of ['intro', 'reduced', 'blocked'] as const)
      expect(videoLook({ ...calm, [k]: true })).toEqual({ poster: '/p.jpg', hidden: false });
  });
  it('waits for the first frame when there is no poster to show', () => {
    expect(videoLook({ ...calm, intro: true, poster: null })).toEqual({ poster: null, hidden: true });
  });
});
