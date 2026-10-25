import type { ConnectorInfo, PublicUser, ThemeMode } from '@patchbay/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api.ts';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: PublicUser | null }>('/api/me').then((r) => r.user),
    staleTime: 60_000,
  });
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api<{ google: boolean; devLogin: boolean; offline: boolean }>('/auth/config'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useConnectors() {
  return useQuery({
    queryKey: ['connectors'],
    queryFn: () => api<ConnectorInfo[]>('/api/connectors'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    qc.clear();
    window.location.href = '/';
  }, [qc]);
}

/* ---------- theme ---------- */

const listeners = new Set<() => void>();
const readTheme = (): ThemeMode => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function setTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem('pb-theme', mode);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readTheme,
    () => 'light',
  );
}

/* ---------- misc ---------- */

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Patchbay`;
    return () => {
      document.title = 'Patchbay';
    };
  }, [title]);
}

export function relativeTime(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 45) return 'just now';
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [3600, 'minute'],
    [86_400, 'hour'],
    [2_592_000, 'day'],
    [31_536_000, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  const size: Record<string, number> = {
    minute: 60,
    hour: 3600,
    day: 86_400,
    month: 2_592_000,
    year: 31_536_000,
  };
  for (const [limit, unit] of steps) {
    if (abs < limit) return rtf.format(Math.round(seconds / size[unit]!), unit);
  }
  return rtf.format(Math.round(seconds / 31_536_000), 'year');
}
