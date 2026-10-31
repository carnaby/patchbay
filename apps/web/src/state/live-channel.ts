/**
 * A dashboard's live channel (server-sent events) that keeps itself open: the editor and presentation mode rely on
 * it, and presentation mode runs unattended on wall screens and TVs, where nobody reloads a page that went quiet.
 */

/** First wait before opening a channel again; doubled up to the maximum, back to the first once one opens. */
export const RECONNECT_MIN_MS = 5000;
export const RECONNECT_MAX_MS = 60_000;
/**
 * The server sends a ping every 25 s while it has nothing else to send (HEARTBEAT_MS in apps/server routes/api.ts).
 * Hearing nothing for more than twice that means the stream is dead even though the connection looks open: a proxy
 * can keep a connection open after the server behind it has gone, and EventSource then waits forever.
 */
export const SILENCE_MS = 60_000;
const WATCHDOG_MS = 5000;

/** The part of EventSource the channel uses, so tests can stand in a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: 'ping', listener: () => void): void;
  close(): void;
}

export interface LiveChannelOptions {
  onMessage: (event: MessageEvent<string>) => void;
  onConnected: (connected: boolean) => void;
  /** Tests only. */
  open?: (url: string) => EventSourceLike;
  now?: () => number;
}

/** EventSource.CLOSED, without needing EventSource (tests run in Node). */
const CLOSED = 2;

/** Opens the channel and keeps it open until the returned function is called. */
export function openLiveChannel(url: string, options: LiveChannelOptions): () => void {
  const open = options.open ?? ((u: string) => new EventSource(u, { withCredentials: true }));
  const now = options.now ?? Date.now;
  let source: EventSourceLike;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryMs = RECONNECT_MIN_MS;
  let lastHeard = now();
  /** A reconnect is scheduled: neither the error handler nor the watchdog schedules another meanwhile. */
  let waiting = false;
  const heard = () => {
    lastHeard = now();
  };

  const reconnectLater = () => {
    waiting = true;
    retry = setTimeout(() => {
      waiting = false;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
  };

  const connect = () => {
    heard();
    source = open(url);
    source.onopen = () => {
      heard();
      retryMs = RECONNECT_MIN_MS;
      options.onConnected(true);
    };
    source.onmessage = (event) => {
      if (stopped) return;
      heard();
      options.onMessage(event);
    };
    source.addEventListener('ping', heard);
    source.onerror = () => {
      options.onConnected(false);
      // EventSource reconnects by itself after a dropped connection, but gives up for good after an error answer
      // (a busy server's 503, a 429). Unattended screens must come back without anyone reloading them.
      if (source.readyState !== CLOSED || stopped || waiting) return;
      reconnectLater();
    };
  };
  connect();

  // Also catches a reconnect of EventSource's own that hangs: the silence counts from the last word of the old stream.
  const watchdog = setInterval(() => {
    if (stopped || waiting || now() - lastHeard < SILENCE_MS) return;
    source.close();
    options.onConnected(false);
    reconnectLater();
  }, WATCHDOG_MS);

  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    source.close();
  };
}
