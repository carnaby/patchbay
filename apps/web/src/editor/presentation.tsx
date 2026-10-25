/**
 * Presentation (kiosk) mode for wall screens and TVs: no toolbar, full screen
 * where the browser allows it, the cursor hides when idle, and the screen is
 * kept awake with the Screen Wake Lock API so a live dashboard never dims.
 */
import { Copy, Info, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, cx, toast } from '../components/ui.tsx';

const IDLE_MS = 2500;

export function usePresentation(initial: boolean) {
  const [presenting, setPresenting] = useState(initial);
  const enteredFullscreen = useRef(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  const requestFullscreen = useCallback(async () => {
    if (!document.fullscreenEnabled || document.fullscreenElement) return;
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      enteredFullscreen.current = true;
    } catch {
      // Not allowed without a user gesture or not supported (iPhone): the kiosk layout still applies.
    }
  }, []);

  const start = useCallback(async () => {
    setPresenting(true);
    await requestFullscreen();
  }, [requestFullscreen]);

  const stop = useCallback(async () => {
    setPresenting(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    enteredFullscreen.current = false;
  }, []);

  // Leaving full screen with Esc (or the browser's own UI) ends the presentation too.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && enteredFullscreen.current) {
        enteredFullscreen.current = false;
        setPresenting(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keep the screen awake while presenting; the lock is dropped when the tab is hidden, so take it again.
  useEffect(() => {
    if (!presenting || !('wakeLock' in navigator)) return;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) await lock.release();
        else wakeLock.current = lock;
      } catch {
        // Denied (battery saver, unsupported context): presenting still works, the screen may dim.
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void wakeLock.current?.release().catch(() => {});
      wakeLock.current = null;
    };
  }, [presenting]);

  return useMemo(
    () => ({ presenting, start, stop, requestFullscreen }),
    [presenting, start, stop, requestFullscreen],
  );
}

/** True while the pointer has been still for a moment (used to hide cursor and controls). */
export function useIdle(active: boolean) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!active) {
      setIdle(false);
      return;
    }
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [active]);
  return idle;
}

export function PresentationControls({
  title,
  idle,
  onExit,
  onFullscreen,
}: {
  title: string;
  idle: boolean;
  onExit: () => void;
  onFullscreen: () => void;
}) {
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled;
  const [inFullscreen, setInFullscreen] = useState(Boolean(document.fullscreenElement));
  useEffect(() => {
    const onChange = () => setInFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  return (
    <div
      className={cx(
        'fixed inset-x-0 top-0 z-40 flex items-center gap-3 bg-gradient-to-b from-page/95 to-transparent px-4 pt-3 pb-6 transition-opacity duration-300',
        idle ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
    >
      <span className="truncate text-sm font-semibold">{title}</span>
      <span className="flex-1" />
      {fullscreenAvailable && !inFullscreen ? (
        <Button size="sm" onClick={onFullscreen}>
          Full screen
        </Button>
      ) : null}
      <Button size="sm" icon={<Minimize2 className="size-4" />} onClick={onExit}>
        Exit
      </Button>
    </div>
  );
}

/** A small (i) next to the present button: how to put this dashboard on a TV or wall screen. */
export function TvInfo({ dashboardId, isPrivate }: { dashboardId: string; isPrivate: boolean }) {
  const [open, setOpen] = useState(false);
  const link = `${window.location.origin}/d/${dashboardId}?present=1`;
  return (
    <div className="relative -ml-1.5">
      <button
        type="button"
        aria-label="Showing this on a TV"
        title="Showing this on a TV"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-5 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <Info className="size-3.5" />
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Showing this on a TV"
            className="absolute right-0 z-40 mt-2 w-[min(340px,calc(100vw-24px))] rounded-xl border border-line bg-surface p-4 text-sm text-ink-2 shadow-xl"
          >
            <div className="mb-2 font-semibold text-ink">Showing this on a TV</div>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>Open this link in the TV's (or wall tablet's) browser. It starts without the toolbar.</li>
              <li>Click once, or press OK on the remote, and choose Full screen.</li>
              <li>The screen stays on and live data updates by itself. Nobody needs to touch it.</li>
            </ol>
            <div className="mt-3 flex gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 font-mono text-[11px]"
              />
              <Button
                size="sm"
                icon={<Copy className="size-3.5" />}
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  toast('Link copied');
                }}
              >
                Copy
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">
              {isPrivate
                ? 'This dashboard is private, so sign in on the TV first, or make it public under Share.'
                : 'Public dashboards open without signing in.'}{' '}
              On a tablet, install Patchbay as an app for a true full screen. Press F here to try it.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
