/**
 * Presentation (kiosk) mode for wall screens and TVs: no toolbar, full screen
 * where the browser allows it, the cursor hides when idle, and the screen is
 * kept awake with the Screen Wake Lock API so a live dashboard never dims.
 */
import { Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, cx } from '../components/ui.tsx';

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
