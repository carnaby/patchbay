/**
 * Connects dataset results to sound cues (proposal 0002).
 *
 * Every result, whether pushed over SSE or fetched by a query, lands in the
 * TanStack Query cache, so the cache is the one place to listen: each result is
 * decided exactly once, however many frames (grid, maximised overlay) show the
 * widget, and editor panes that read the same data never add a second decision.
 */
import type { DatasetResult, SoundRule, Widget } from '@patchbay/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { armAutoUnlock, playCue } from '../lib/sounds.ts';
import { datasetKey, lineageKey, soundIdentity, viewKey } from './dataset-keys.ts';
import { useEditor } from './editor.ts';
import { useParameters } from './parameters.ts';
import { considerResult, type Tracked } from './sound-tracker.ts';
import { liveReconnects } from './sync.ts';

type SoundWidget = Extract<Widget, { datasetId: string }> & { sound: SoundRule };

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

    const identityOf = (w: SoundWidget, now: number) =>
      soundIdentity(useEditor.getState().doc, w.sound, w.datasetId, useParameters.getState().raw, now);

    const consider = (w: SoundWidget, result: DatasetResult, now: number): boolean =>
      considerResult(tracked, w.id, w.sound, identityOf(w, now), liveReconnects(), result, now);

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
        // A dataset that uses filters may hold a cached result of this view from an earlier visit; as a baseline, the
        // next refresh would ring for everything since. Its next result is the baseline instead.
        if (!doc || viewKey(doc, w.datasetId, {}) !== '') continue;
        const cached = doc
          ? qc.getQueryData<DatasetResult>(datasetKey(dashboardId, doc, w.datasetId))
          : undefined;
        const entry = tracked.get(w.id);
        const now = Date.now();
        if (cached && (!entry || entry.identity !== identityOf(w, now))) consider(w, cached, now);
      }
    };
    seed();

    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [kind, id, datasetId, definition, view] = event.query.queryKey as unknown[];
      if (kind !== 'data' || id !== dashboardId || typeof datasetId !== 'string') return;
      // Results for a definition or a view that is no longer current (an edit, another filter value) are skipped.
      const doc = useEditor.getState().doc;
      if (
        !doc?.datasets.some((d) => d.id === datasetId) ||
        lineageKey(doc, datasetId) !== definition ||
        viewKey(doc, datasetId, useParameters.getState().raw) !== view
      )
        return;
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
