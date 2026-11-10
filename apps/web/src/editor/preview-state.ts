/**
 * What the dataset editor's preview shows (the counts next to its heading and what fills it) and when it asks again.
 * Kept out of the component so the rules are tested without a browser.
 */
import type { DatasetResult, Source } from '@patchbay/core';

/** How long the draft must stay unchanged before the preview asks for it. */
export const PREVIEW_DELAY_MS = 450;

/**
 * The wait while only a POST body changes. Each body the preview asks for is a real request upstream, and typing a
 * query inside valid JSON (a string value, say) leaves valid JSON at every keystroke: with the usual wait, every
 * pause to think sent one.
 */
export const BODY_PREVIEW_DELAY_MS = 1500;

/** A dataset draft as far as the preview reads it. */
interface PreviewDraft {
  source: Source;
}

const withoutBody = (draft: PreviewDraft) =>
  JSON.stringify({ ...draft, source: { ...draft.source, body: undefined } });

/** The wait before previewing `draft`, given the draft the preview shows now. */
export function previewDelay(previewed: PreviewDraft, draft: PreviewDraft): number {
  const before = previewed.source;
  const after = draft.source;
  if (before.kind !== 'http' || after.kind !== 'http' || after.method !== 'POST') return PREVIEW_DELAY_MS;
  const bodyOnly =
    JSON.stringify(before.body) !== JSON.stringify(after.body) &&
    withoutBody(previewed) === withoutBody(draft);
  return bodyOnly ? BODY_PREVIEW_DELAY_MS : PREVIEW_DELAY_MS;
}

export type PreviewBody =
  | { kind: 'blocked'; message: string }
  /** The draft is out of date: the hint, above the last table (dimmed) when there is one to keep. */
  | { kind: 'stale'; message: string; table: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'table' }
  | { kind: 'loading' };

export interface PreviewInput {
  /** The credentials in the form would be refused, so no request is sent. */
  credentialsBlocked: boolean;
  /** A form problem that keeps the draft at its last valid value (an invalid POST body), or null. */
  formError: string | null;
  /** The preview request failed (its message), or null. */
  requestError: string | null;
  /** The last answer for the debounced draft, if any. */
  result: DatasetResult | undefined;
}

/**
 * Counts appear only beside the table they describe. Next to an error they would describe something else: the empty
 * table of a failed source, or the last good answer a failed request keeps as data. A form error keeps the draft at
 * its last valid value, so its preview is out of date: it is marked so but stays in place, because typing a body flips
 * between valid and invalid at almost every keystroke and swapping the table for a message made the panel jump.
 */
export function previewState(input: PreviewInput): { counts: string | null; body: PreviewBody } {
  const { result } = input;
  const failed = input.requestError !== null || Boolean(result?.error);
  if (input.credentialsBlocked)
    return {
      counts: null,
      body: { kind: 'blocked', message: 'Fix the credentials above to load a preview.' },
    };
  if (input.formError !== null)
    return {
      counts: null,
      body: {
        kind: 'stale',
        message: 'Fix the error above to update the preview.',
        table: Boolean(result) && !failed,
      },
    };
  if (failed)
    return { counts: null, body: { kind: 'error', message: input.requestError ?? result?.error ?? '' } };
  if (!result) return { counts: null, body: { kind: 'loading' } };
  const rows = `${result.table.rows.length.toLocaleString('en')} rows${result.truncated ? ' (first 500)' : ''}`;
  return { counts: `${rows} · ${result.table.columns.length} columns`, body: { kind: 'table' } };
}
