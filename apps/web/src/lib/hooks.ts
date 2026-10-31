import type { ConnectorInfo, PublicUser, SecretMode, ThemeMode } from '@patchbay/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import type { SecretsList } from './secrets.ts';

interface MeResponse {
  user: PublicUser | null;
  /** The instance switch for secrets, and whether this user may store and use them. */
  secrets: SecretMode;
  canUseSecrets: boolean;
}

const meQuery = {
  queryKey: ['me'],
  queryFn: () => api<MeResponse>('/api/me'),
  staleTime: 60_000,
};

export function useMe() {
  return useQuery({ ...meQuery, select: (r: MeResponse) => r.user });
}

/** Whether this instance offers secrets, and to this user. */
export function useSecretsStatus() {
  return useQuery({
    ...meQuery,
    select: (r: MeResponse) => ({ mode: r.secrets ?? 'off', canUseSecrets: Boolean(r.canUseSecrets) }),
  });
}

/** The signed-in user's secrets (metadata only; values never leave the server). */
export function useSecrets(enabled = true) {
  return useQuery({
    queryKey: ['secrets'],
    queryFn: () => api<SecretsList>('/api/secrets'),
    enabled,
    staleTime: 30_000,
  });
}

export interface AuthConfig {
  google: boolean;
  devLogin: boolean;
  offline: boolean;
  /** Days without a view after which anonymous dashboards are deleted; 0 = never. */
  pruneAnonymousAfterDays: number;
  /** Hours after which an anonymous dashboard nobody edited is deleted; 0 = never. */
  pruneBlankAnonymousAfterHours: number;
  /** Whether the operator turned on cookieless Umami page views. */
  analytics: boolean;
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api<AuthConfig>('/auth/config'),
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

/** Connector id to credit text, for the "Data: ..." line viewers see. Empty until the connector list has loaded. */
export function useAttributions(): Record<string, string> {
  const { data } = useConnectors();
  return useMemo(() => Object.fromEntries((data ?? []).map((c) => [c.id, c.attribution])), [data]);
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

/** Re-renders on every second (or minute) boundary, and at once when a hidden tab becomes visible again. */
export function useNow(stepMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      // Aligned to the boundary, so the display never lags the real second by a random fraction.
      timer = setTimeout(tick, stepMs - (t % stepMs) + 5);
    };
    tick();
    // Browsers throttle timers in hidden tabs; a wall screen that comes back must not show a stale time.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [stepMs]);
  return now;
}
