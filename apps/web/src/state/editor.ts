/**
 * Editor state: the working document, undo/redo history and sync bookkeeping.
 *
 * Every change goes through `applyOps` from @patchbay/core - the same function
 * the server and the MCP agent use - so the editor can never produce a document
 * the server would reject. History stores whole documents (cheap thanks to
 * structural sharing) which makes undo/redo trivial and exact.
 *
 * Sync model: `saved`/`version` mirror what the server has. Local edits since
 * the last save are kept as ops in `pendingOps`, so when somebody else (often
 * an AI agent) saved in between, they can be replayed on top of the newer
 * version instead of throwing the user's work away.
 */
import {
  type Actor,
  applyOps,
  type DashboardAccess,
  type DashboardDoc,
  type DashboardEnvelope,
  type DashboardMeta,
  type OpInput,
} from '@patchbay/core';
import { create } from 'zustand';
import { confirmedForSave, introducedSecretRefs, type PublicSecretRef } from '../lib/secrets.ts';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1200;

interface Entry {
  doc: DashboardDoc;
  label: string;
}

/** A save the server refused with 428 until the user confirms showing data fetched with secrets publicly. */
export interface SecretsPrompt {
  /** The document that was refused; autosave does not retry it until the user answers or edits further. */
  doc: DashboardDoc;
  secrets: PublicSecretRef[];
  /** False once the user chose "Not now": a banner stays instead of the dialog. */
  open: boolean;
}

export interface RemoteChange {
  actor: Actor;
  changes: string[];
  at: number;
  version: number;
}

interface EditorState {
  id: string | null;
  meta: DashboardMeta | null;
  access: DashboardAccess | null;
  doc: DashboardDoc | null;
  saved: DashboardDoc | null;
  version: number;
  past: Entry[];
  future: Entry[];
  /** Ops applied since `saved`; null once an undo/redo made the delta non-replayable. */
  pendingOps: OpInput[] | null;
  pendingLabels: string[];
  lastCoalesce: { key: string; at: number } | null;
  editing: boolean;
  /** Widget shown maximised over the dashboard (view state, not saved). */
  expanded: string | null;
  saving: boolean;
  saveError: string | null;
  conflict: DashboardEnvelope | null;
  /** widget id -> timestamp, for the "changed elsewhere" and "this widget rang" highlight */
  flash: Record<string, number>;
  lastRemote: RemoteChange | null;
  /** Secret references (see `introducedSecretRefs`) the user agreed to show on this public dashboard. */
  confirmedSecretRefs: string[];
  secretsPrompt: SecretsPrompt | null;

  load(envelope: DashboardEnvelope): void;
  setEditing(editing: boolean): void;
  setExpanded(id: string | null): void;
  /** Highlights widgets that just played their sound cue. */
  ring(ids: string[]): void;
  apply(ops: OpInput[], label: string, options?: { coalesce?: string }): string | null;
  undo(): void;
  redo(): void;
  beginSave(): {
    doc: DashboardDoc;
    baseVersion: number;
    labels: string[];
    confirmPublicSecrets: boolean;
  } | null;
  saveSucceeded(sent: DashboardDoc, envelope: DashboardEnvelope): void;
  saveFailed(error: string): void;
  /** The server answered 428: hold this document until the user decides. */
  saveNeedsConfirmation(sent: DashboardDoc, secrets: PublicSecretRef[]): void;
  /** Records that the user agreed to show these references publicly; the next save carries the flag. */
  confirmSecretRefs(refs: string[]): void;
  answerSecretsPrompt(choice: 'confirm' | 'later' | 'discard'): void;
  reopenSecretsPrompt(): void;
  /** The server has a newer version than ours: rebase local work or flag a conflict. */
  rebaseOnto(current: DashboardEnvelope): 'rebased' | 'conflict' | 'clean';
  acceptRemote(envelope: DashboardEnvelope, change: RemoteChange): void;
  resolveConflict(choice: 'mine' | 'theirs'): void;
  setMeta(meta: DashboardMeta, access?: DashboardAccess): void;
}

function changedWidgets(before: DashboardDoc | null, after: DashboardDoc): string[] {
  if (!before) return [];
  const prev = new Map(before.widgets.map((w) => [w.id, JSON.stringify(w)]));
  const prevLayout = new Map(before.layout.map((l) => [l.i, JSON.stringify(l)]));
  const changedDatasets = new Set(
    after.datasets
      .filter((d) => JSON.stringify(before.datasets.find((b) => b.id === d.id)) !== JSON.stringify(d))
      .map((d) => d.id),
  );
  return after.widgets
    .filter(
      (w) =>
        prev.get(w.id) !== JSON.stringify(w) ||
        prevLayout.get(w.id) !== JSON.stringify(after.layout.find((l) => l.i === w.id)) ||
        ('datasetId' in w && changedDatasets.has(w.datasetId)),
    )
    .map((w) => w.id);
}

export const useEditor = create<EditorState>((set, get) => ({
  id: null,
  meta: null,
  access: null,
  doc: null,
  saved: null,
  version: 0,
  past: [],
  future: [],
  pendingOps: [],
  pendingLabels: [],
  lastCoalesce: null,
  editing: false,
  expanded: null,
  saving: false,
  saveError: null,
  conflict: null,
  flash: {},
  lastRemote: null,
  confirmedSecretRefs: [],
  secretsPrompt: null,

  load(envelope) {
    set({
      id: envelope.meta.id,
      meta: envelope.meta,
      access: envelope.access,
      doc: envelope.doc,
      saved: envelope.doc,
      version: envelope.meta.version,
      past: [],
      future: [],
      pendingOps: [],
      pendingLabels: [],
      lastCoalesce: null,
      saving: false,
      saveError: null,
      conflict: null,
      flash: {},
      lastRemote: null,
      confirmedSecretRefs: [],
      secretsPrompt: null,
      editing: get().id === envelope.meta.id ? get().editing : false,
    });
  },

  ring(ids) {
    const at = Date.now();
    set({ flash: { ...get().flash, ...Object.fromEntries(ids.map((id) => [id, at])) } });
  },

  setExpanded(expanded) {
    set({ expanded });
  },

  setEditing(editing) {
    set({ editing });
  },

  apply(ops, label, options) {
    const { doc, past, pendingOps, pendingLabels, lastCoalesce } = get();
    if (!doc) return 'Dashboard not loaded';
    let next: DashboardDoc;
    try {
      next = applyOps(doc, ops).doc;
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid change';
    }
    const now = Date.now();
    const coalesce =
      options?.coalesce && lastCoalesce?.key === options.coalesce && now - lastCoalesce.at < COALESCE_MS;
    set({
      doc: next,
      past: coalesce ? past : [...past, { doc, label }].slice(-HISTORY_LIMIT),
      future: [],
      pendingOps: pendingOps ? [...pendingOps, ...ops] : null,
      pendingLabels: pendingLabels.includes(label) ? pendingLabels : [...pendingLabels, label],
      lastCoalesce: options?.coalesce ? { key: options.coalesce, at: now } : null,
    });
    return null;
  },

  undo() {
    const { past, future, doc, pendingLabels } = get();
    const entry = past.at(-1);
    if (!entry || !doc) return;
    set({
      doc: entry.doc,
      past: past.slice(0, -1),
      future: [{ doc, label: entry.label }, ...future],
      pendingOps: null,
      pendingLabels: [...pendingLabels, `Undo: ${entry.label}`],
      lastCoalesce: null,
    });
  },

  redo() {
    const { past, future, doc, pendingLabels } = get();
    const entry = future[0];
    if (!entry || !doc) return;
    set({
      doc: entry.doc,
      past: [...past, { doc, label: entry.label }],
      future: future.slice(1),
      pendingOps: null,
      pendingLabels: [...pendingLabels, `Redo: ${entry.label}`],
      lastCoalesce: null,
    });
  },

  beginSave() {
    const { doc, saved, saving, conflict, version, pendingLabels, secretsPrompt, confirmedSecretRefs } =
      get();
    if (!doc || doc === saved || saving || conflict) return null;
    // The refused document waits for the user's answer; any further edit makes a new document and tries again.
    if (secretsPrompt?.doc === doc) return null;
    set({ saving: true });
    return {
      doc,
      baseVersion: version,
      labels: pendingLabels.length ? pendingLabels.slice(-10) : ['Edited'],
      confirmPublicSecrets: saved ? confirmedForSave(saved, doc, confirmedSecretRefs) : false,
    };
  },

  saveNeedsConfirmation(sent, secrets) {
    const previous = get().secretsPrompt;
    // After "Not now" the banner stays; further edits must not pop the dialog up again and again.
    set({ saving: false, secretsPrompt: { doc: sent, secrets, open: previous ? previous.open : true } });
  },

  confirmSecretRefs(refs) {
    const confirmed = get().confirmedSecretRefs;
    set({ confirmedSecretRefs: [...confirmed, ...refs.filter((r) => !confirmed.includes(r))] });
  },

  answerSecretsPrompt(choice) {
    const { secretsPrompt, saved, doc, past } = get();
    if (!secretsPrompt) return;
    if (choice === 'later') {
      set({ secretsPrompt: { ...secretsPrompt, open: false } });
    } else if (choice === 'confirm') {
      // Only what the user saw is confirmed; edits made since then are checked again by the server.
      if (saved) get().confirmSecretRefs(introducedSecretRefs(saved, secretsPrompt.doc));
      set({ secretsPrompt: null });
    } else if (saved && doc) {
      set({
        doc: saved,
        past: [...past, { doc, label: 'Discarded unsaved changes' }].slice(-HISTORY_LIMIT),
        future: [],
        pendingOps: [],
        pendingLabels: [],
        lastCoalesce: null,
        secretsPrompt: null,
      });
    }
  },

  reopenSecretsPrompt() {
    const { secretsPrompt } = get();
    if (secretsPrompt) set({ secretsPrompt: { ...secretsPrompt, open: true } });
  },

  saveSucceeded(sent, envelope) {
    const { doc } = get();
    const stillCurrent = doc === sent;
    set({
      saving: false,
      saveError: null,
      // A refused document is never the one saved here (beginSave skips it), so a newer one replaced it.
      secretsPrompt: null,
      saved: sent,
      version: envelope.meta.version,
      meta: envelope.meta,
      // Edits made while the request was in flight stay pending.
      pendingOps: stillCurrent ? [] : get().pendingOps,
      pendingLabels: stillCurrent ? [] : get().pendingLabels,
    });
  },

  saveFailed(error) {
    set({ saving: false, saveError: error });
  },

  rebaseOnto(current) {
    const { doc, saved, pendingOps } = get();
    if (!doc || doc === saved) {
      return 'clean';
    }
    if (pendingOps && pendingOps.length > 0) {
      try {
        const rebased = applyOps(current.doc, pendingOps).doc;
        set({
          saved: current.doc,
          version: current.meta.version,
          meta: current.meta,
          doc: rebased,
          saving: false,
          conflict: null,
        });
        return 'rebased';
      } catch {
        // fall through to an explicit conflict
      }
    }
    set({ conflict: current, saving: false });
    return 'conflict';
  },

  acceptRemote(envelope, change) {
    const { doc, past } = get();
    const changed = changedWidgets(doc, envelope.doc);
    const at = Date.now();
    set({
      doc: envelope.doc,
      saved: envelope.doc,
      version: envelope.meta.version,
      meta: envelope.meta,
      access: envelope.access,
      // The remote change becomes an undoable step: "undo what the agent did".
      past: doc
        ? [...past, { doc, label: `${change.actor.label}: ${change.changes[0] ?? 'change'}` }].slice(
            -HISTORY_LIMIT,
          )
        : past,
      future: [],
      pendingOps: [],
      pendingLabels: [],
      flash: Object.fromEntries(changed.map((id) => [id, at])),
      lastRemote: change,
    });
  },

  resolveConflict(choice) {
    const { conflict, doc, past } = get();
    if (!conflict) return;
    if (choice === 'theirs') {
      set({
        doc: conflict.doc,
        saved: conflict.doc,
        version: conflict.meta.version,
        meta: conflict.meta,
        past: doc ? [...past, { doc, label: 'Discarded my changes' }] : past,
        pendingOps: [],
        pendingLabels: [],
        conflict: null,
      });
    } else {
      // Keep mine: save my document on top of their version (theirs stays in version history).
      set({
        saved: conflict.doc,
        version: conflict.meta.version,
        meta: conflict.meta,
        conflict: null,
        pendingOps: null,
      });
    }
  },

  setMeta(meta, access) {
    set({ meta, ...(access ? { access } : {}) });
  },
}));
