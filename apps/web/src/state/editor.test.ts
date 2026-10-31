import { applyOps, type DashboardEnvelope, emptyDashboard } from '@patchbay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from './editor.ts';

const A = 'sec_AAAAAAAAAAAAAAAA';
const URL_1 = 'https://api.example.com/v1/orders';
const URL_2 = 'https://api.example.com/v1/customers';

const base = applyOps(emptyDashboard('Shop'), [
  {
    op: 'addDataset',
    dataset: {
      id: 'orders',
      name: 'Orders',
      source: { kind: 'http', url: URL_1 },
      transforms: [],
      refreshSec: 0,
      accumulate: 0,
    },
  },
]).doc;

function envelope(version: number, doc = base): DashboardEnvelope {
  return {
    meta: {
      id: 'dash',
      title: doc.title,
      ownerId: 'u1',
      visibility: 'public',
      version,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      lastViewedAt: '2026-10-26T00:00:00.000Z',
    },
    doc,
    access: { canEdit: true, isOwner: true, anonymous: false },
  };
}

const addSecret = () =>
  useEditor
    .getState()
    .apply(
      [{ op: 'updateDataset', id: 'orders', set: { source: { kind: 'http', url: URL_1, secrets: [A] } } }],
      'Added credentials',
    );

/** What useAutosave does with a 428: hand the refused document to the store. */
function refuse() {
  const job = useEditor.getState().beginSave();
  if (!job) throw new Error('expected a save');
  useEditor.getState().saveNeedsConfirmation(job.doc, [{ id: A, name: 'Shop API' }]);
  return job;
}

describe('autosave and the public-secrets confirmation', () => {
  beforeEach(() => useEditor.getState().load(envelope(1)));

  it('does not send the flag for something the user has not seen', () => {
    addSecret();
    expect(useEditor.getState().beginSave()?.confirmPublicSecrets).toBe(false);
  });

  it('holds a refused document instead of retrying it', () => {
    addSecret();
    refuse();
    const s = useEditor.getState();
    expect(s.saving).toBe(false);
    expect(s.secretsPrompt?.open).toBe(true);
    // The same document is not sent again on its own: no loop.
    expect(s.beginSave()).toBeNull();
    // And nothing was dropped.
    expect(s.doc).not.toBe(s.saved);
  });

  it('saves with the flag after the user confirms', () => {
    addSecret();
    refuse();
    useEditor.getState().answerSecretsPrompt('confirm');
    expect(useEditor.getState().secretsPrompt).toBeNull();
    const job = useEditor.getState().beginSave();
    expect(job?.confirmPublicSecrets).toBe(true);
    useEditor.getState().saveSucceeded(job!.doc, envelope(2, job!.doc));
    expect(useEditor.getState().doc).toBe(useEditor.getState().saved);
  });

  it('asks again when a confirmed secret is pointed at another URL', () => {
    addSecret();
    refuse();
    useEditor.getState().answerSecretsPrompt('confirm');
    useEditor
      .getState()
      .apply(
        [{ op: 'updateDataset', id: 'orders', set: { source: { kind: 'http', url: URL_2, secrets: [A] } } }],
        'Changed URL',
      );
    expect(useEditor.getState().beginSave()?.confirmPublicSecrets).toBe(false);
  });

  it('after "Not now" keeps a banner and does not reopen the dialog on further edits', () => {
    addSecret();
    refuse();
    useEditor.getState().answerSecretsPrompt('later');
    expect(useEditor.getState().secretsPrompt?.open).toBe(false);
    useEditor.getState().apply([{ op: 'setMeta', title: 'Shop 2' }], 'Renamed');
    // A further edit is a new document, so autosave tries again; the server refuses again.
    refuse();
    expect(useEditor.getState().secretsPrompt?.open).toBe(false);
    useEditor.getState().reopenSecretsPrompt();
    expect(useEditor.getState().secretsPrompt?.open).toBe(true);
  });

  it('can discard the unsaved changes, and undo that', () => {
    addSecret();
    refuse();
    useEditor.getState().answerSecretsPrompt('discard');
    const s = useEditor.getState();
    expect(s.doc).toBe(s.saved);
    expect(s.secretsPrompt).toBeNull();
    s.undo();
    expect(useEditor.getState().doc?.datasets[0]?.source).toMatchObject({ secrets: [A] });
  });

  it('keeps the 409 rebase working alongside', () => {
    addSecret();
    const job = useEditor.getState().beginSave();
    expect(job).not.toBeNull();
    const theirs = applyOps(base, [{ op: 'setMeta', title: 'Renamed by an agent' }]).doc;
    expect(useEditor.getState().rebaseOnto(envelope(2, theirs))).toBe('rebased');
    const s = useEditor.getState();
    expect(s.doc?.title).toBe('Renamed by an agent');
    expect(s.doc?.datasets[0]?.source).toMatchObject({ secrets: [A] });
    expect(s.beginSave()?.baseVersion).toBe(2);
  });
});

describe('failed saves', () => {
  beforeEach(() => useEditor.getState().load(envelope(1)));
  const rename = (title: string) => useEditor.getState().apply([{ op: 'setMeta', title }], 'Renamed');

  it('does not send a document the server refused for good again, until it is edited', () => {
    rename('Bad');
    const job = useEditor.getState().beginSave()!;
    useEditor.getState().saveFailed('Invalid document', job.doc);
    expect(useEditor.getState().beginSave()).toBeNull();
    expect(useEditor.getState().doc).not.toBe(useEditor.getState().saved);
    rename('Fixed');
    expect(useEditor.getState().beginSave()?.doc.title).toBe('Fixed');
  });

  it('tries again after a failure that was only a busy server', () => {
    rename('Busy');
    useEditor.getState().beginSave();
    useEditor.getState().saveFailed('The server is busy');
    expect(useEditor.getState().beginSave()?.doc.title).toBe('Busy');
  });

  it('gives each save its own number, and loading a dashboard moves past a save still waiting', () => {
    rename('One');
    const job = useEditor.getState().beginSave()!;
    expect(useEditor.getState().saveSeq).toBe(job.seq);
    useEditor.getState().load(envelope(5));
    expect(useEditor.getState().saveSeq).not.toBe(job.seq);
  });
});
