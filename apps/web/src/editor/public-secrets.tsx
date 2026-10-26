/**
 * Confirmations before data fetched with secrets becomes public. The server enforces them (it answers
 * `428 confirm_public_secrets` until the request carries `confirmPublicSecrets: true`); these dialogs are how the
 * user answers. Autosave keeps its refused document in the editor store (`secretsPrompt`) and never retries it on
 * its own; one-off actions (visibility, restore, saving a dataset) await `askPublicSecrets`.
 */
import { AlertTriangle, Globe } from 'lucide-react';
import { create } from 'zustand';
import { Button, Modal } from '../components/ui.tsx';
import { joinNames, publicSecretsRequest, secretRefNames } from '../lib/secrets.ts';
import { useEditor } from '../state/editor.ts';

type AskKind = 'publish' | 'change' | 'restore';

interface Ask {
  kind: AskKind;
  names: string[];
  resolve: (ok: boolean) => void;
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Shows the confirmation and resolves with the user's answer. A second request cancels a pending one. */
export function askPublicSecrets(kind: AskKind, names: string[]): Promise<boolean> {
  useAsk.getState().ask?.resolve(false);
  return new Promise((resolve) => useAsk.setState({ ask: { kind, names, resolve } }));
}

/**
 * Runs a request; if the server asks for the public-secrets confirmation, asks the user and repeats it with the
 * flag. Resolves to null when the user declines. Any other error is rethrown unchanged.
 */
export async function withPublicSecretsConfirmation<T>(
  kind: AskKind,
  run: (confirmPublicSecrets: boolean) => Promise<T>,
): Promise<T | null> {
  try {
    return await run(false);
  } catch (e) {
    const refs = publicSecretsRequest(e);
    if (!refs) throw e;
    if (!(await askPublicSecrets(kind, secretRefNames(refs)))) return null;
    return run(true);
  }
}

const quoted = (names: string[]) => joinNames(names.map((n) => `“${n}”`));
const secretWord = (names: string[]) => (names.length === 1 ? 'secret' : 'secrets');

function Body({ kind, names }: { kind: AskKind; names: string[] }) {
  const list = <strong className="text-ink">{quoted(names)}</strong>;
  return (
    <div className="flex gap-3 rounded-xl border-2 border-warn bg-warn/15 p-3 text-ink">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
      <p>
        {kind === 'publish' ? (
          <>
            This dashboard uses your {secretWord(names)} {list}.
          </>
        ) : kind === 'restore' ? (
          <>
            This dashboard is public, and the version you restore uses your {secretWord(names)} {list}.
          </>
        ) : (
          <>
            This dashboard is public, and the change uses your {secretWord(names)} {list}.
          </>
        )}{' '}
        Anyone with the link will see the data {names.length === 1 ? 'it returns' : 'they return'} (never the{' '}
        {secretWord(names)} {names.length === 1 ? 'itself' : 'themselves'}).
      </p>
    </div>
  );
}

const TITLES: Record<AskKind, string> = {
  publish: 'Make it public?',
  change: 'Show this data publicly?',
  restore: 'Restore and show this data publicly?',
};
const CONFIRM: Record<AskKind, string> = {
  publish: 'Make public',
  change: 'Save and show the data',
  restore: 'Restore',
};

/** Mounted once on the dashboard page. */
export function PublicSecretsDialogs() {
  const ask = useAsk((s) => s.ask);
  const prompt = useEditor((s) => s.secretsPrompt);
  const answer = useEditor((s) => s.answerSecretsPrompt);
  const close = (ok: boolean) => {
    ask?.resolve(ok);
    useAsk.setState({ ask: null });
  };

  if (ask) {
    return (
      <Modal
        open
        title={TITLES[ask.kind]}
        onClose={() => close(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Globe className="size-4" />} onClick={() => close(true)}>
              {CONFIRM[ask.kind]}
            </Button>
          </>
        }
      >
        <Body kind={ask.kind} names={ask.names} />
      </Modal>
    );
  }
  if (prompt?.open) {
    return (
      <Modal
        open
        title={TITLES.change}
        onClose={() => answer('later')}
        footer={
          <>
            <Button variant="ghost" onClick={() => answer('later')}>
              Not now
            </Button>
            <Button variant="danger" onClick={() => answer('discard')}>
              Discard unsaved changes
            </Button>
            <Button variant="primary" icon={<Globe className="size-4" />} onClick={() => answer('confirm')}>
              {CONFIRM.change}
            </Button>
          </>
        }
      >
        <Body kind="change" names={secretRefNames(prompt.secrets)} />
        <p className="mt-3">
          Your changes are not saved until you decide. You can also make the dashboard private first.
        </p>
      </Modal>
    );
  }
  return null;
}

/** Shown while a refused save waits, after the user chose "Not now". */
export function SecretsSaveBanner() {
  const prompt = useEditor((s) => s.secretsPrompt);
  const reopen = useEditor((s) => s.reopenSecretsPrompt);
  if (!prompt || prompt.open) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2.5 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-warn" aria-hidden="true" />
      <span className="text-ink-2">
        Not saved: the change would show data fetched with {quoted(secretRefNames(prompt.secrets))} on this
        public dashboard.
      </span>
      <span className="flex-1" />
      <Button size="sm" variant="primary" onClick={reopen}>
        Review
      </Button>
    </div>
  );
}
