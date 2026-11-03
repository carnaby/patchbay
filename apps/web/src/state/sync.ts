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
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { datasetInSync, datasetKey, datasetKeyFor, lineageKey, refreshTiming } from './dataset-keys.ts';
import { useEditor } from './editor.ts';
import { openLiveChannel } from './live-channel.ts';
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
        // Pushed results are computed from the saved document: keyed by its lineage.
        if (saved?.datasets.some((d) => d.id === event.result.datasetId))
          qc.setQueryData(datasetKey(id, saved, event.result.datasetId), fromWire(event.result));
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

const fetchResult = (dashboardId: string, datasetId: string) => async () =>
  fromWire(
    await api<DatasetResult>(`/api/dashboards/${dashboardId}/data/${datasetId}?rows=arrays`, { dashboardId }),
  );

/**
 * Data for one dataset. It only fetches definitions the server already has, for the dataset and everything it reads
 * (the editor autosaves within a second); until then the previous result stays on screen, so editing never flashes
 * empty widgets.
 */
export function useDatasetResult(dashboardId: string, dataset: Dataset | undefined, live: boolean) {
  const id = dataset?.id;
  // Primitives only: a selector returning a new object would re-render on every store change.
  const lineage = useEditor((s) => (id && s.doc ? lineageKey(s.doc, id) : ''));
  const inSync = useEditor((s) => (id ? datasetInSync(s.saved, s.doc, id) : false));
  const refreshSec = useEditor((s) => (id && s.doc ? effectiveRefreshSec(s.doc, id) : 0));
  const timing = refreshTiming(refreshSec, live);
  return useQuery({
    queryKey: id ? datasetKeyFor(dashboardId, id, lineage) : ['data', dashboardId, 'none'],
    queryFn: fetchResult(dashboardId, id ?? ''),
    enabled: Boolean(id) && inSync,
    placeholderData: keepPreviousData,
    staleTime: timing.staleTime,
    // SSE pushes live updates; poll only if the live channel is down.
    refetchInterval: timing.refetchInterval,
  });
}

/** Column names of other datasets' current results, for the join and union step editors. */
export function useDatasetColumns(dashboardId: string, ids: readonly string[]): (id: string) => string[] {
  const doc = useEditor((s) => s.doc);
  const saved = useEditor((s) => s.saved);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: datasetKeyFor(dashboardId, id, doc ? lineageKey(doc, id) : ''),
      queryFn: fetchResult(dashboardId, id),
      enabled: datasetInSync(saved, doc, id),
      staleTime: 5 * 60_000,
    })),
  });
  return (id) => results[ids.indexOf(id)]?.data?.table.columns.map((c) => c.name) ?? [];
}
