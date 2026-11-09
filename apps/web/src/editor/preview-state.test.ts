import type { DatasetResult } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { PREVIEW_DELAY_MS, previewDelay, previewState } from './preview-state.ts';

const result = (rows: number, extra: Partial<DatasetResult> = {}): DatasetResult => ({
  datasetId: 'd',
  table: {
    columns: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'string' },
    ],
    rows: Array.from({ length: rows }, (_, i) => ({ a: i, b: `r${i}` })),
  },
  fetchedAt: '2026-11-10T00:00:00Z',
  hash: 'h',
  truncated: false,
  ...extra,
});
const ok = { credentialsBlocked: false, formError: null, requestError: null };

describe('when the dataset editor previews', () => {
  const get = { kind: 'http' as const, url: 'https://api.example.com/graphql' };
  const post = (body: unknown) => ({ source: { ...get, method: 'POST' as const, body } });

  it('waits longer for a body being typed than for other edits', () => {
    // Every pause on a valid body would otherwise send a real POST upstream.
    const typing = previewDelay(post({ query: 'view' }), post({ query: 'viewe' }));
    expect(typing).toBeGreaterThanOrEqual(3 * PREVIEW_DELAY_MS);
    expect(previewDelay(post(undefined), post({}))).toBe(typing);
  });

  it('keeps the usual wait for every other change', () => {
    const body = { query: 'x' };
    expect(previewDelay(post(body), { source: { ...post(body).source, url: `${get.url}?a` } })).toBe(
      PREVIEW_DELAY_MS,
    );
    // The body and something else changed: the method switch that brings a kept body back, say.
    expect(previewDelay({ source: get }, post(body))).toBe(PREVIEW_DELAY_MS);
    expect(previewDelay({ source: { ...get, url: 'https://b.example.com/x' } }, { source: get })).toBe(
      PREVIEW_DELAY_MS,
    );
    expect(previewDelay(post(body), post(body))).toBe(PREVIEW_DELAY_MS);
    expect(
      previewDelay(
        { source: { kind: 'inline', rows: [{ a: 1 }] } },
        { source: { kind: 'inline', rows: [{ a: 2 }] } },
      ),
    ).toBe(PREVIEW_DELAY_MS);
  });
});

describe('the dataset editor preview', () => {
  it('shows the counts of a current table', () => {
    expect(previewState({ ...ok, result: result(1200, { truncated: true }) })).toEqual({
      counts: '1,200 rows (first 500) · 2 columns',
      body: { kind: 'table' },
    });
    expect(previewState({ ...ok, result: undefined })).toEqual({ counts: null, body: { kind: 'loading' } });
  });

  it('shows no counts next to an error, whatever table came with it', () => {
    // A failed source answers with an empty table ("0 rows · 0 columns") or what an earlier step kept.
    const failed = result(3, { error: 'Upstream responded 307' });
    expect(previewState({ ...ok, result: failed })).toEqual({
      counts: null,
      body: { kind: 'error', message: 'Upstream responded 307' },
    });
    // A failed request keeps the last good answer as data: its counts are not the draft's.
    expect(previewState({ ...ok, requestError: 'Network error', result: result(5) })).toEqual({
      counts: null,
      body: { kind: 'error', message: 'Network error' },
    });
  });

  it('does not present the last valid draft as current while the form has an error', () => {
    // The draft keeps the last valid body while the field holds invalid JSON: its preview is out of date.
    expect(previewState({ ...ok, formError: 'Not valid JSON: Unexpected end', result: result(5) })).toEqual({
      counts: null,
      body: { kind: 'blocked', message: 'Fix the error above to update the preview.' },
    });
    expect(previewState({ ...ok, credentialsBlocked: true, result: result(5) })).toEqual({
      counts: null,
      body: { kind: 'blocked', message: 'Fix the credentials above to load a preview.' },
    });
  });
});
