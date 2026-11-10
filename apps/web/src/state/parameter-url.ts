/**
 * Keeps the filter values (state/parameters.ts) and the page URL in step (proposal 0010). The URL decides when it
 * changes (a link, Back, a hand edit); the store decides when the filter bar changes a value. A value the declaration
 * does not offer falls back to the default: a toast says so, except while presenting, where nobody would read it and
 * nothing may ask for input.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from '../components/ui.tsx';
import { useEditor } from './editor.ts';
import { normalizeRaw, rawFromSearch, sameRaw, searchWith, useParameters } from './parameters.ts';

export function useParameterUrl(dashboardId: string, presenting: boolean) {
  const [search, setSearch] = useSearchParams();
  const parameters = useEditor((s) => s.doc?.parameters);
  const presentingNow = useRef(presenting);
  presentingNow.current = presenting;

  // URL (and declarations) to store. Runs again when an editor or an agent changes the declarations, so a value whose
  // option was removed resets while the link is open.
  useEffect(() => {
    const { raw, problems } = normalizeRaw(parameters, rawFromSearch(search), Date.now());
    const state = useParameters.getState();
    if (state.dashboardId !== dashboardId || !sameRaw(state.raw, raw))
      useParameters.setState({ dashboardId, raw, history: 'replace' });
    if (problems.length > 0 && !presentingNow.current)
      toast(`${problems.map((p) => p.message).join('. ')}. Showing the default instead.`, 'bad');
    const fixed = searchWith(search, raw);
    if (fixed.toString() !== search.toString()) setSearch(fixed, { replace: true });
  }, [dashboardId, parameters, search, setSearch]);

  // Store to URL: the filter bar replaces the history entry, a cross-filter click (phase 2) pushes one.
  useEffect(
    () =>
      useParameters.subscribe((s, prev) => {
        if (s.raw === prev.raw || s.dashboardId !== dashboardId) return;
        const current = new URLSearchParams(window.location.search);
        const next = searchWith(current, s.raw);
        if (next.toString() !== current.toString()) setSearch(next, { replace: s.history === 'replace' });
      }),
    [dashboardId, setSearch],
  );

  // Another dashboard starts from its own URL, never from this one's values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup must run when the dashboard changes, though it does not read dashboardId; dropping the dependency (Biome's fix) would reset only on unmount.
  useEffect(
    () => () => useParameters.setState({ dashboardId: null, raw: {}, history: 'replace' }),
    [dashboardId],
  );
}
