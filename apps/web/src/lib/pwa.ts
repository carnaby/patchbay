/** Progressive Web App helpers: service worker registration and the install prompt. */
import { useEffect, useState } from 'react';

export function registerServiceWorker() {
  // Production only: in development a service worker would get in the way of hot reloading.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* not fatal: the app works without it */
    });
  });
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the browser's prompt for our own "Install app" button.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    for (const l of listeners) l();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    for (const l of listeners) l();
  });
}

/** Whether the browser offers installation (Chromium browsers), and a function to trigger it. */
export function useInstallPrompt() {
  const [available, setAvailable] = useState(Boolean(deferred));
  useEffect(() => {
    const update = () => setAvailable(Boolean(deferred));
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    setAvailable(false);
  };
  return { available, install };
}
