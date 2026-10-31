import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventSourceLike, openLiveChannel, RECONNECT_MIN_MS, SILENCE_MS } from './live-channel.ts';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private pings: (() => void)[] = [];
  addEventListener(_type: 'ping', listener: () => void) {
    this.pings.push(listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  opened() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  message(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
  ping() {
    for (const listener of this.pings) listener();
  }
  /** The server answered with an error status: EventSource gives up for good. */
  refused() {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

let sources: FakeSource[];
const connected: boolean[] = [];
const messages: string[] = [];

function channel() {
  return openLiveChannel('/events', {
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    onConnected: (c) => connected.push(c),
    onMessage: (m) => messages.push(m.data),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  connected.length = 0;
  messages.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('openLiveChannel', () => {
  it('keeps a stream that pings, however quiet its data', () => {
    const close = channel();
    sources[0]!.opened();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(25_000);
      sources[0]!.ping();
    }
    expect(sources).toHaveLength(1);
    expect(sources[0]!.closed).toBe(false);
    close();
    expect(sources[0]!.closed).toBe(true);
  });

  it('closes a stream that went silent and opens a new one after the backoff', () => {
    const close = channel();
    sources[0]!.opened();
    sources[0]!.message('hello');
    // A proxy holds the connection open, but nothing comes through any more.
    vi.advanceTimersByTime(SILENCE_MS);
    expect(sources[0]!.closed).toBe(true);
    expect(connected.at(-1)).toBe(false);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(2);
    sources[1]!.opened();
    expect(connected.at(-1)).toBe(true);
    sources[1]!.message('again');
    expect(messages).toEqual(['hello', 'again']);
    close();
  });

  it('gives up on a connection attempt that hangs, and backs off further each time', () => {
    const close = channel();
    // Never opens: each attempt is closed after the silence, and the waits double.
    vi.advanceTimersByTime(SILENCE_MS);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(SILENCE_MS);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(3);
    // A stream that opens resets the backoff.
    sources[2]!.opened();
    vi.advanceTimersByTime(SILENCE_MS);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(4);
    close();
  });

  it('opens again after the server refused it, without the watchdog adding a second attempt', () => {
    const close = channel();
    sources[0]!.refused();
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(sources).toHaveLength(2);
    sources[1]!.refused();
    // The second wait is twice the first; the watchdog stays out of it.
    vi.advanceTimersByTime(2 * RECONNECT_MIN_MS - 1);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    close();
    vi.advanceTimersByTime(10 * SILENCE_MS);
    expect(sources).toHaveLength(3);
  });
});
