/**
 * What the dataset editor's preview shows: the counts next to its heading and what fills it. Kept out of the component
 * so the rules are tested without a browser.
 */
import type { DatasetResult } from '@patchbay/core';

export type PreviewBody =
  | { kind: 'blocked'; message: string }
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
 * its last valid value, so its preview is out of date and is replaced, as the credentials problem replaces it.
 */
export function previewState(input: PreviewInput): { counts: string | null; body: PreviewBody } {
  const { result } = input;
  if (input.credentialsBlocked)
    return {
      counts: null,
      body: { kind: 'blocked', message: 'Fix the credentials above to load a preview.' },
    };
  if (input.formError !== null)
    return { counts: null, body: { kind: 'blocked', message: 'Fix the error above to update the preview.' } };
  if (input.requestError !== null || result?.error)
    return { counts: null, body: { kind: 'error', message: input.requestError ?? result?.error ?? '' } };
  if (!result) return { counts: null, body: { kind: 'loading' } };
  const rows = `${result.table.rows.length.toLocaleString('en')} rows${result.truncated ? ' (first 500)' : ''}`;
  return { counts: `${rows} · ${result.table.columns.length} columns`, body: { kind: 'table' } };
}
