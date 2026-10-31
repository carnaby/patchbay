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
  type LiveEvent,
} from '@patchbay/core';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '../components/ui.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { publicSecretsRequest } from '../lib/secrets.ts';
import { useEditor } from './editor.ts';

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
    const timer = setTimeout(async () => {
      const job = useEditor.getState().beginSave();
      if (!job) return;
      try {
        const res = await api<{ envelope: DashboardEnvelope }>(`/api/dashboards/${id}`, {
          method: 'PUT',
          body: {
            doc: job.doc,
            baseVersion: job.baseVersion,
            changes: job.labels,
            ...(job.confirmPublicSecrets ? { confirmPublicSecrets: true } : {}),
          },
          dashboardId: id,
        });
        useEditor.getState().saveSucceeded(job.doc, res.envelope);
      } catch (e) {
        const secrets = publicSecretsRequest(e);
        if (secrets) {
          // Not a failure and not retried on its own: the user decides in the dialog (PublicSecretsPrompt).
          useEditor.getState().saveNeedsConfirmation(job.doc, secrets);
        } else if (e instanceof ApiError && e.status === 409 && e.body.current) {
          const outcome = useEditor.getState().rebaseOnto(e.body.current as DashboardEnvelope);
          if (outcome === 'rebased') toast('The dashboard changed elsewhere. Your edits were merged on top.');
        } else {
          useEditor.getState().saveFailed(errorMessage(e));
          toast(`Could not save: ${errorMessage(e)}`, 'bad');
        }
      }
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

export const datasetKey = (dashboardId: string, dataset: Dataset) =>
  ['data', dashboardId, dataset.id, JSON.stringify(dataset)] as const;

let reconnects = 0;
/** First wait before opening a live channel the server refused again; doubled up to the maximum. */
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60_000;
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
    let source: EventSource;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryMs = RECONNECT_MIN_MS;
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
      if (stopped) return;
      const event = JSON.parse(msg.data) as LiveEvent;
      if (event.type === 'data') {
        const doc = useEditor.getState().saved;
        const dataset = doc?.datasets.find((d) => d.id === event.result.datasetId);
        if (dataset) qc.setQueryData(datasetKey(id, dataset), fromWire(event.result));
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

    const connect = () => {
      // Rows as arrays: column names once per result instead of once per row (see core wire.ts).
      source = new EventSource(`/api/dashboards/${id}/events?rows=arrays`, { withCredentials: true });
      source.onopen = () => {
        retryMs = RECONNECT_MIN_MS;
        setConnected(true);
      };
      source.onmessage = onMessage;
      source.onerror = () => {
        setConnected(false);
        // EventSource reconnects by itself after a dropped connection, but gives up for good after an error answer
        // (a busy server's 503, a 429). Unattended screens must come back without anyone reloading them.
        if (source.readyState !== EventSource.CLOSED || stopped) return;
        retry = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
      };
    };
    connect();

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
      stopped = true;
      clearTimeout(retry);
      source.close();
      unsubscribe();
    };
  }, [id, qc, navigate]);

  return connected;
}

/**
 * Data for one dataset. It only fetches definitions the server already has
 * (the editor autosaves within a second); until then the previous result stays
 * on screen, so editing never flashes empty widgets.
 */
export function useDatasetResult(dashboardId: string, dataset: Dataset | undefined, live: boolean) {
  const savedDataset = useEditor((s) => s.saved?.datasets.find((d) => d.id === dataset?.id));
  const inSync = Boolean(dataset && savedDataset && JSON.stringify(savedDataset) === JSON.stringify(dataset));
  return useQuery({
    queryKey: dataset ? datasetKey(dashboardId, dataset) : ['data', dashboardId, 'none'],
    queryFn: async () =>
      fromWire(
        await api<DatasetResult>(`/api/dashboards/${dashboardId}/data/${dataset!.id}?rows=arrays`, {
          dashboardId,
        }),
      ),
    enabled: Boolean(dataset) && inSync,
    placeholderData: keepPreviousData,
    staleTime: dataset && dataset.refreshSec > 0 ? dataset.refreshSec * 1000 : 5 * 60_000,
    // SSE pushes live updates; poll only if the live channel is down.
    refetchInterval:
      dataset && dataset.refreshSec > 0 && !live ? Math.max(dataset.refreshSec, 5) * 1000 : false,
  });
}
