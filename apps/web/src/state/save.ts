/**
 * One autosave of the editor's document: the PUT, its retries and what each answer means for the editor's state.
 * Kept out of the React hook (sync.ts) so the sequence of answers can be tested without a browser.
 */
import type { DashboardDoc, DashboardEnvelope } from '@patchbay/core';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { isRetryable, type RetryOptions, withRetry } from '../lib/retry.ts';
import { publicSecretsRequest } from '../lib/secrets.ts';
import { useEditor } from './editor.ts';

type SaveJob = NonNullable<ReturnType<ReturnType<typeof useEditor.getState>['beginSave']>>;

/** The editor moved on to another dashboard while a save waited to retry. */
class SaveAbandoned extends Error {}

/** JSON with object keys sorted, so two equal documents compare equal whatever order their keys were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** Whether the server's document is exactly the one we sent. */
export const sameDocument = (a: DashboardDoc, b: DashboardDoc) => a === b || canonical(a) === canonical(b);

export type Notify = (message: string, tone?: 'bad') => void;

/**
 * Sends `job` and settles the editor's state. A busy server (429, 503), a restarting one behind the proxy (502, 504)
 * and a dropped connection are waited out with the change kept queued while the status says "Saving…"; edits made
 * meanwhile are saved next. Only a lasting failure is reported.
 *
 * Retrying the PUT is safe because it carries the version it was based on: a first attempt that landed before its
 * answer was lost turns the retry into a 409. If the server's document then is exactly ours, that write was ours
 * and the save succeeded; anything else is someone else's change and is rebased as usual.
 */
export async function performSave(id: string, job: SaveJob, notify: Notify, retry: RetryOptions = {}) {
  const current = () => useEditor.getState().saveSeq === job.seq;
  try {
    const res = await withRetry(() => {
      if (!current()) throw new SaveAbandoned();
      return api<{ envelope: DashboardEnvelope }>(`/api/dashboards/${id}`, {
        method: 'PUT',
        body: {
          doc: job.doc,
          baseVersion: job.baseVersion,
          changes: job.labels,
          ...(job.confirmPublicSecrets ? { confirmPublicSecrets: true } : {}),
        },
        dashboardId: id,
      });
    }, retry);
    if (current()) useEditor.getState().saveSucceeded(job.doc, res.envelope);
  } catch (e) {
    if (e instanceof SaveAbandoned || !current()) return;
    const secrets = publicSecretsRequest(e);
    if (secrets) {
      // Not a failure and not retried on its own: the user decides in the dialog (PublicSecretsPrompt).
      useEditor.getState().saveNeedsConfirmation(job.doc, secrets);
    } else if (e instanceof ApiError && e.status === 409 && e.body.current) {
      const server = e.body.current as DashboardEnvelope;
      if (sameDocument(server.doc, job.doc)) {
        useEditor.getState().saveSucceeded(job.doc, server);
        return;
      }
      const outcome = useEditor.getState().rebaseOnto(server);
      if (outcome === 'rebased') notify('The dashboard changed elsewhere. Your edits were merged on top.');
    } else {
      // Still unreachable or busy after the retries: autosave starts over. Anything else would be refused again as
      // it is, so it waits for the next edit.
      useEditor.getState().saveFailed(errorMessage(e), isRetryable(e) ? undefined : job.doc);
      notify(`Could not save: ${errorMessage(e)}`, 'bad');
    }
  }
}
