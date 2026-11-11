/**
 * Server synchronisation for the editor:
 * - autosave with optimistic concurrency (baseVersion) and automatic rebase,
 * - live events over SSE (document changes by other clients, refreshed data),
 * - dataset results, kept in the TanStack Query cache.
 */
import {
  type DashboardEnvelope,
  type Dataset,
  type DatasetResult,
  decodeTable,
  effectiveRefreshSec,
  type LiveEvent,
} from '@patchbay/core';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import {
  choiceChecks,
  datasetInSync,
  datasetKey,
  datasetKeyFor,
  followsCalendar,
  lastFetch,
  lineageKey,
  NO_VALUES,
  nextRefetch,
  queryOfView,
  refreshTiming,
  viewKey,
} from './dataset-keys.ts';
import { useEditor } from './editor.ts';
import { openLiveChannel } from './live-channel.ts';
import {
  choicesOfResult,
  dataValueReady,
  pendingDataValue,
  type RawValues,
  useParameters,
} from './parameters.ts';
import { performSave } from './save.ts';

const SAVE_DEBOUNCE_MS = 600;

async function fetchEnvelope(id: string) {
  return api<DashboardEnvelope>(`/api/dashboards/${id}`, { dashboardId: id });
}

export function useAutosave() {
  const doc = useEditor((s) => s.doc);
  const saving = useEditor((s) => s.saving);
  const conflict = useEditor((s) => s.conflict);
  const id = useEditor((s) => s.id);
  const secretsPrompt = useEditor((s) => s.secretsPrompt);

  useEffect(() => {
    if (!id || !doc || saving || conflict) return;
    if (doc === useEditor.getState().saved) return;
    if (secretsPrompt?.doc === doc) return;
    const timer = setTimeout(() => {
      const job = useEditor.getState().beginSave();
      if (job) void performSave(id, job, (message, tone) => toast(message, tone));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [id, doc, saving, conflict, secretsPrompt]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState();
      if (s.doc !== s.saved) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

/** A result as the server sends it with `rows=arrays`, back to rows keyed by column name. */
export const fromWire = (result: DatasetResult): DatasetResult => ({
  ...result,
  table: decodeTable(result.table),
});

let reconnects = 0;
/** How often the live channel reconnected; results after a reconnect only set a new sound baseline. */
export const liveReconnects = () => reconnects;

/** Subscribes to the dashboard's live channel. Returns whether it is connected. */
export function useLiveEvents(id: string | undefined) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const pendingVersion = useRef(0);

  useEffect(() => {
    if (!id) return;
    let greeted = false;

    const pullRemote = async (event: Extract<LiveEvent, { type: 'doc' }>) => {
      const state = useEditor.getState();
      if (event.version <= state.version) return; // our own save, already applied
      if (state.saving) {
        pendingVersion.current = Math.max(pendingVersion.current, event.version);
        return;
      }
      try {
        const envelope = await fetchEnvelope(id);
        const s = useEditor.getState();
        if (envelope.meta.version <= s.version) return;
        if (s.doc === s.saved) {
          s.acceptRemote(envelope, {
            actor: event.actor,
            changes: event.changes,
            at: Date.now(),
            version: envelope.meta.version,
          });
          const who = event.actor.label;
          const what = event.changes.slice(0, 2).join('; ');
          if (event.actor.kind === 'mcp') {
            toast(`${who}: ${what}`, 'neutral', { label: 'Undo', run: () => useEditor.getState().undo() });
          }
        } else {
          // Local edits pending: the next save will 409 and rebase.
          s.rebaseOnto(envelope);
        }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
          toast('This dashboard is no longer available to you.', 'bad');
          navigate('/');
        }
      }
    };

    const onMessage = (msg: MessageEvent<string>) => {
      const event = JSON.parse(msg.data) as LiveEvent;
      if (event.type === 'data') {
        const saved = useEditor.getState().saved;
        const datasetId = event.result.datasetId;
        // Pushed results are computed from the saved document, at no view: the hub pushes only datasets that use no
        // filter, and a push for one that does (an older server) is not this viewer's view.
        if (saved?.datasets.some((d) => d.id === datasetId) && viewKey(saved, datasetId, NO_VALUES) === '')
          qc.setQueryData(datasetKey(id, saved, datasetId), fromWire(event.result));
      } else if (event.type === 'doc') {
        void pullRemote(event);
      } else if (event.type === 'hello') {
        // Results after a gap must not ring for everything that happened while we were away.
        if (greeted) reconnects++;
        greeted = true;
        // Reconnected after a gap: catch up if we missed changes.
        if (event.version > useEditor.getState().version)
          void pullRemote({
            type: 'doc',
            version: event.version,
            actor: { kind: 'system', label: 'Someone' },
            changes: ['changes while you were offline'],
          });
      } else if (event.type === 'deleted') {
        toast('This dashboard was deleted.', 'bad');
        navigate('/');
      }
    };

    // Rows as arrays: column names once per result instead of once per row (see core wire.ts).
    const close = openLiveChannel(`/api/dashboards/${id}/events?rows=arrays`, {
      onMessage,
      onConnected: setConnected,
    });

    // After our own save finishes, process a remote version that arrived meanwhile.
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (prev.saving && !s.saving && pendingVersion.current > s.version) {
        const v = pendingVersion.current;
        pendingVersion.current = 0;
        void pullRemote({
          type: 'doc',
          version: v,
          actor: { kind: 'system', label: 'Someone' },
          changes: ['concurrent change'],
        });
      }
    });

    return () => {
      close();
      unsubscribe();
    };
  }, [id, qc, navigate]);

  return connected;
}

const fetchResult =
  (dashboardId: string, datasetId: string, view = '') =>
  async () =>
    fromWire(
      await api<DatasetResult>(
        `/api/dashboards/${dashboardId}/data/${datasetId}?rows=arrays${queryOfView(view)}`,
        { dashboardId },
      ),
    );

type ChoiceCheck = [id: string, dataset: string, lineage: string, view: string];

/** A data-driven value a dataset's request waits for: the filter's label and the value its choices lack. */
export interface PendingValue {
  label: string;
  value: string;
}

/**
 * Whether the data-driven values a request would carry may be sent (`dataValueReady`): their choices are loaded and
 * hold them, or failed. Also the first of them that loaded choices lack, which a wall screen holds until they hold it
 * again. The choices are read from the cache without fetching them: the page's DataOptionsGuard loads every options
 * dataset, with the same key.
 */
function useChoiceState(
  dashboardId: string,
  checks: string,
  raw: RawValues,
): { ready: boolean; pending: PendingValue | null } {
  const entries = useMemo(() => (checks ? (JSON.parse(checks) as ChoiceCheck[]) : []), [checks]);
  const parameters = useEditor((s) => s.doc?.parameters);
  return useQueries({
    queries: entries.map(([, dataset, lineage, view]) => ({
      queryKey: datasetKeyFor(dashboardId, dataset, lineage, view),
      queryFn: fetchResult(dashboardId, dataset, view),
      enabled: false,
    })),
    combine: (results) => {
      let ready = true;
      let pending: PendingValue | null = null;
      for (const [i, [id]] of entries.entries()) {
        const param = parameters?.find((p) => p.id === id);
        const from = param?.type === 'select' ? param.optionsFrom : undefined;
        if (!param || !from) continue;
        const query = results[i];
        const choices = choicesOfResult(from.field, query?.data, Boolean(query?.isError));
        if (!dataValueReady(param, raw, choices)) ready = false;
        const value = pendingDataValue(param, raw, choices);
        if (pending === null && value !== null) pending = { label: param.label, value };
      }
      return { ready, pending };
    },
  });
}

/**
 * The data-driven value a dataset's request waits for because the loaded choices lack it, or null. The checks are the
 * ones `useDatasetResult` waits on, so a widget can tell a held value from an ordinary wait.
 */
export function usePendingDataValue(dashboardId: string, dataset: Dataset | undefined): PendingValue | null {
  const id = dataset?.id;
  const raw = useParameters((s) => s.raw);
  const checks = useEditor((s) => (id && s.doc ? choiceChecks(s.doc, id, raw) : ''));
  return useChoiceState(dashboardId, checks, raw).pending;
}

/**
 * Data for one dataset. It only fetches definitions the server already has, for the dataset and everything it reads
 * (the editor autosaves within a second); until then the previous result stays on screen, so editing never flashes
 * empty widgets.
 */
export function useDatasetResult(dashboardId: string, dataset: Dataset | undefined, live: boolean) {
  const id = dataset?.id;
  const raw = useParameters((s) => s.raw);
  // No request before this dashboard's URL was read: a value of another dashboard or an invalid link value waits.
  const ready = useParameters((s) => s.dashboardId === dashboardId);
  // Primitives only: a selector returning a new object would re-render on every store change.
  const lineage = useEditor((s) => (id && s.doc ? lineageKey(s.doc, id) : ''));
  const view = useEditor((s) => (id && s.doc ? viewKey(s.doc, id, raw) : ''));
  const calendar = useEditor((s) => (id && s.doc ? followsCalendar(s.doc, id, raw) : false));
  const inSync = useEditor((s) => (id ? datasetInSync(s.saved, s.doc, id) : false));
  const refreshSec = useEditor((s) => (id && s.doc ? effectiveRefreshSec(s.doc, id) : 0));
  const checks = useEditor((s) => (id && s.doc ? choiceChecks(s.doc, id, raw) : ''));
  const checked = useChoiceState(dashboardId, checks, raw).ready;
  // A dataset that uses filters is never pushed (one result per view): it polls even while the live channel is up.
  const timing = refreshTiming(refreshSec, live && view === '');
  return useQuery({
    queryKey: id ? datasetKeyFor(dashboardId, id, lineage, view) : ['data', dashboardId, 'none'],
    queryFn: fetchResult(dashboardId, id ?? '', view),
    enabled: Boolean(id) && inSync && ready && checked,
    placeholderData: keepPreviousData,
    staleTime: timing.staleTime,
    // SSE pushes live updates; poll when it cannot, and after midnight for a relative period.
    refetchInterval: (query) =>
      nextRefetch(timing.refetchInterval, calendar, Date.now(), lastFetch(query.state)),
  });
}

/** Column names of other datasets' current results, for the join and union step editors. */
export function useDatasetColumns(dashboardId: string, ids: readonly string[]): (id: string) => string[] {
  const doc = useEditor((s) => s.doc);
  const saved = useEditor((s) => s.saved);
  const raw = useParameters((s) => s.raw);
  const ready = useParameters((s) => s.dashboardId === dashboardId);
  const results = useQueries({
    queries: ids.map((id) => {
      const view = doc ? viewKey(doc, id, raw) : '';
      return {
        queryKey: datasetKeyFor(dashboardId, id, doc ? lineageKey(doc, id) : '', view),
        queryFn: fetchResult(dashboardId, id, view),
        enabled: datasetInSync(saved, doc, id) && ready,
        staleTime: 5 * 60_000,
      };
    }),
  });
  return (id) => results[ids.indexOf(id)]?.data?.table.columns.map((c) => c.name) ?? [];
}
