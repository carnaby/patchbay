import { describe, expect, it, vi } from 'vitest';
import { closesUnattended, unattendedTimer, withPresent } from './presentation-state.ts';

describe('unattendedTimer', () => {
  it('closes 30 s after it was armed, and 30 s after the last input', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const t = unattendedTimer(close);
    vi.advanceTimersByTime(29_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    t.stop();
    const again = unattendedTimer(close);
    vi.advanceTimersByTime(20_000);
    again.poke();
    vi.advanceTimersByTime(29_999);
    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(2); // 50 s after opening
    const stopped = unattendedTimer(close);
    stopped.stop();
    vi.advanceTimersByTime(60_000);
    expect(close).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('closesUnattended', () => {
  it('closes only an overlay opened during a presentation, while it runs', () => {
    expect(closesUnattended(true, true)).toBe(true);
    expect(closesUnattended(false, true)).toBe(false); // maximised on purpose before Present: stays the view
    expect(closesUnattended(true, false)).toBe(false); // presentation ended: an ordinary page again
  });
});

describe('withPresent', () => {
  it('puts present=1 in the URL while presenting and removes it after, keeping the view', () => {
    const s = (q: string) => new URLSearchParams(q);
    expect(withPresent(s('p.region=eu'), true).toString()).toBe('p.region=eu&present=1');
    expect(withPresent(s('present=1&p.region=eu'), true).toString()).toBe('present=1&p.region=eu');
    expect(withPresent(s('present=1&p.region=eu'), false).toString()).toBe('p.region=eu');
    expect(withPresent(s('present=0'), false).toString()).toBe('');
  });
});
