/**
 * Connects dataset results to sound cues (proposal 0002).
 *
 * Every result, whether pushed over SSE or fetched by a query, lands in the
 * TanStack Query cache, so the cache is the one place to listen: each result is
 * decided exactly once, however many frames (grid, maximised overlay) show the
 * widget, and editor panes that read the same data never add a second decision.
 */
import {
  type DatasetResult,
  type SoundRule,
  type SoundState,
  soundDecision,
  type Widget,
} from '@patchbay/core';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { armAutoUnlock, playCue } from '../lib/sounds.ts';
import { useEditor } from './editor.ts';
import { datasetKey, liveReconnects } from './sync.ts';

type SoundWidget = Extract<Widget, { datasetId: string }> & { sound: SoundRule };

interface Tracked {
  /** Rule + dataset definition the state belongs to; a change means a new baseline. */
  identity: string;
  epoch: number;
  hash: string | null;
  state: SoundState | null;
}

export function soundWidgets(widgets: Widget[] | undefined): SoundWidget[] {
  return (widgets ?? []).filter((w): w is SoundWidget => 'datasetId' in w && Boolean(w.sound));
}

export function useSoundCues(dashboardId: string) {
  const qc = useQueryClient();
  const hasSounds = useEditor((s) => soundWidgets(s.doc?.widgets).length > 0);

  useEffect(() => (hasSounds ? armAutoUnlock() : undefined), [hasSounds]);

  useEffect(() => {
    if (!hasSounds) return;
    const tracked = new Map<string, Tracked>();

    const identityOf = (w: SoundWidget) => {
      const dataset = useEditor.getState().doc?.datasets.find((d) => d.id === w.datasetId);
      return dataset ? JSON.stringify([w.sound, dataset]) : null;
    };

    const consider = (w: SoundWidget, result: DatasetResult, now: number): boolean => {
      const identity = identityOf(w);
      if (!identity) return false;
      const epoch = liveReconnects();
      let entry = tracked.get(w.id);
      if (!entry || entry.identity !== identity || entry.epoch !== epoch) {
        entry = { identity, epoch, hash: null, state: null };
        tracked.set(w.id, entry);
      }
      // A failed refresh serves stale rows; they are not news.
      if (result.error || result.hash === entry.hash) return false;
      const decision = soundDecision(w.sound, result.table, entry.state, now);
      entry.hash = result.hash;
      entry.state = decision.state;
      return decision.play;
    };

    const decide = (datasetId: string, result: DatasetResult) => {
      const widgets = soundWidgets(useEditor.getState().doc?.widgets).filter(
        (w) => w.datasetId === datasetId,
      );
      const now = Date.now();
      const rang = widgets.filter((w) => consider(w, result, now));
      if (rang.length === 0) return;
      useEditor.getState().ring(rang.map((w) => w.id));
      // The global throttle inside playCue lets only the first of a simultaneous burst through.
      for (const w of rang) playCue(w.sound.sound, w.sound.volume, now);
    };

    // A rule added or edited while data is already on screen takes the current result as its baseline,
    // so the very next change can ring.
    const seed = () => {
      const doc = useEditor.getState().doc;
      for (const w of soundWidgets(doc?.widgets)) {
        const dataset = doc?.datasets.find((d) => d.id === w.datasetId);
        const cached = dataset ? cachedResult(qc, dashboardId, dataset) : undefined;
        const entry = tracked.get(w.id);
        if (cached && (!entry || entry.identity !== identityOf(w))) consider(w, cached, Date.now());
      }
    };
    seed();

    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [kind, id, datasetId, definition] = event.query.queryKey as unknown[];
      if (kind !== 'data' || id !== dashboardId || typeof datasetId !== 'string') return;
      // Results for a definition that is no longer current (an edit in flight) are skipped.
      const dataset = useEditor.getState().doc?.datasets.find((d) => d.id === datasetId);
      if (!dataset || JSON.stringify(dataset) !== definition) return;
      const result = event.query.state.data as DatasetResult | undefined;
      if (result) decide(datasetId, result);
    });
    const unsubscribeDoc = useEditor.subscribe((s, prev) => {
      if (s.doc !== prev.doc) seed();
    });
    return () => {
      unsubscribeCache();
      unsubscribeDoc();
    };
  }, [qc, dashboardId, hasSounds]);
}

function cachedResult(qc: QueryClient, dashboardId: string, dataset: Parameters<typeof datasetKey>[1]) {
  return qc.getQueryData<DatasetResult>(datasetKey(dashboardId, dataset));
}
