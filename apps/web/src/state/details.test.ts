import { applyOps, type DashboardEnvelope, emptyDashboard, LIMITS } from '@patchbay/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitDetails, detailsChange } from './details.ts';
import { useEditor } from './editor.ts';

const base = applyOps(emptyDashboard('Shop'), [{ op: 'setMeta', description: 'Orders by day' }]).doc;

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

describe('detailsChange', () => {
  it('trims and turns a new title into one setMeta op', () => {
    expect(detailsChange(base, 'title', '  Shop floor ')).toEqual({
      kind: 'change',
      ops: [{ op: 'setMeta', title: 'Shop floor' }],
      label: 'Renamed dashboard',
    });
  });

  it('refuses an empty or whitespace-only title', () => {
    expect(detailsChange(base, 'title', '   ').kind).toBe('invalid');
    expect(detailsChange(base, 'title', '').kind).toBe('invalid');
  });

  it('allows an empty description, which clears it', () => {
    expect(detailsChange(base, 'description', ' ')).toEqual({
      kind: 'change',
      ops: [{ op: 'setMeta', description: '' }],
      label: 'Edited description',
    });
  });

  it('keeps to the schema limits', () => {
    expect(detailsChange(base, 'title', 'x'.repeat(LIMITS.title)).kind).toBe('change');
    expect(detailsChange(base, 'title', 'x'.repeat(LIMITS.title + 1)).kind).toBe('invalid');
    expect(detailsChange(base, 'description', 'x'.repeat(LIMITS.description + 1)).kind).toBe('invalid');
  });

  it('does nothing when the value did not change', () => {
    expect(detailsChange(base, 'title', 'Shop ')).toEqual({ kind: 'unchanged' });
    expect(detailsChange(base, 'description', 'Orders by day')).toEqual({ kind: 'unchanged' });
  });
});

describe('commitDetails through the editor store', () => {
  beforeEach(() => useEditor.getState().load(envelope(1)));

  it('renames with a pending op that autosave and rebase can replay, and undo restores the title', () => {
    expect(commitDetails('title', 'Shop floor')).toBeNull();
    const s = useEditor.getState();
    expect(s.doc?.title).toBe('Shop floor');
    expect(s.pendingOps).toEqual([{ op: 'setMeta', title: 'Shop floor' }]);
    expect(s.pendingLabels).toEqual(['Renamed dashboard']);
    expect(s.past).toHaveLength(1);

    s.undo();
    expect(useEditor.getState().doc?.title).toBe('Shop');
    useEditor.getState().redo();
    expect(useEditor.getState().doc?.title).toBe('Shop floor');
  });

  it('makes each committed rename its own undo step, even in quick succession', () => {
    commitDetails('title', 'One');
    commitDetails('title', 'Two');
    useEditor.getState().undo();
    expect(useEditor.getState().doc?.title).toBe('One');
  });

  it('leaves the document and history alone for an empty title or an unchanged value', () => {
    expect(commitDetails('title', ' ')).toBe('A dashboard needs a title.');
    expect(commitDetails('title', 'Shop')).toBeNull();
    const s = useEditor.getState();
    expect(s.doc).toBe(s.saved);
    expect(s.past).toHaveLength(0);
  });

  it('rebases a rename onto a newer version saved elsewhere, keeping their changes', () => {
    commitDetails('description', 'Daily orders');
    const theirs = applyOps(base, [{ op: 'setMeta', title: 'Shop (agent)' }]).doc;
    expect(useEditor.getState().rebaseOnto(envelope(2, theirs))).toBe('rebased');
    const s = useEditor.getState();
    expect(s.doc?.title).toBe('Shop (agent)');
    expect(s.doc?.description).toBe('Daily orders');
  });
});
