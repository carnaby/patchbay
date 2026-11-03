import type { DashboardExport } from '@patchbay/core';
import { FileUp, Upload } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../lib/api.ts';
import { saveEditKey } from '../lib/edit-keys.ts';
import { relativeTime, useMe } from '../lib/hooks.ts';
import { withRetry } from '../lib/retry.ts';
import {
  formatSize,
  type ImportResult,
  type ImportSummary,
  importSummary,
  type PreparedFile,
  prepareFiles,
  quoteList,
  readImportFile,
  runImport,
} from '../lib/transfer.ts';
import { Button, Card, cx, Modal, Spinner, toast } from './ui.tsx';

type Step =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'error'; message: string }
  // The summary is measured once, when the file is chosen; the files are the ones that will be uploaded.
  | { kind: 'confirm'; exp: DashboardExport; files: PreparedFile[]; summary: ImportSummary }
  | { kind: 'importing'; progress: string }
  | { kind: 'partial'; result: ImportResult; title: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function useImport() {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const navigate = useNavigate();
  const choose = async (file: File) => {
    setStep({ kind: 'reading' });
    try {
      const exp = await readImportFile(file);
      const files = prepareFiles(exp);
      setStep({ kind: 'confirm', exp, files, summary: importSummary(exp, files) });
    } catch (e) {
      setStep({ kind: 'error', message: errorMessage(e) });
    }
  };
  const start = async (exp: DashboardExport, files: PreparedFile[]) => {
    const title = exp.doc.title;
    setStep({ kind: 'importing', progress: 'Creating the dashboard…' });
    try {
      const result = await runImport(exp, files, {
        call: api,
        saveEditKey,
        retry: (task) => withRetry(task),
        onProgress: ({ done, total, name }) => {
          if (name)
            setStep({ kind: 'importing', progress: `Uploading file ${done + 1} of ${total}: ${name}…` });
        },
      });
      if (result.failed.length) {
        setStep({ kind: 'partial', result, title });
        return;
      }
      setStep({ kind: 'idle' });
      navigate(`/d/${result.id}`);
      toast(`Imported "${title}"`, 'good');
    } catch (e) {
      setStep({ kind: 'error', message: errorMessage(e) });
    }
  };
  return { step, setStep, choose, start, navigate };
}

type Flow = ReturnType<typeof useImport>;

function ImportDialog({ flow }: { flow: Flow }) {
  const { data: me } = useMe();
  const { step } = flow;
  const close = () => flow.setStep({ kind: 'idle' });
  if (step.kind === 'idle' || step.kind === 'reading') return null;
  if (step.kind === 'error')
    return (
      <Modal
        open
        title="Cannot import this file"
        onClose={close}
        footer={<Button onClick={close}>Close</Button>}
      >
        <p className="text-sm text-ink-2">{step.message}</p>
      </Modal>
    );
  if (step.kind === 'importing')
    return (
      // Closing would not stop the requests already on their way, so the dialog stays until they are done.
      <Modal open title="Importing…" onClose={() => {}}>
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> {step.progress}
        </p>
      </Modal>
    );
  if (step.kind === 'partial') {
    // The dashboard exists already: every way out of this dialog leads to it, so the list is never just lost.
    const openDashboard = () => {
      close();
      flow.navigate(`/d/${step.result.id}`);
    };
    return (
      <Modal
        open
        title={`Imported "${step.title}", but not all files`}
        onClose={openDashboard}
        footer={
          <Button variant="primary" onClick={openDashboard}>
            Open dashboard
          </Button>
        }
      >
        <div className="space-y-2 text-sm text-ink-2">
          <p>
            These files did not arrive. Datasets that use them show an error until you upload the data again:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {step.result.failed.map((f) => (
              <li key={f.id}>
                <span className="font-medium text-ink">{f.name}</span>: {f.message}
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    );
  }
  const { summary } = step;
  return (
    <Modal
      open
      title={`Import "${summary.title}"`}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void flow.start(step.exp, step.files)}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-ink-2">
        <p>
          Creates a new dashboard with {plural(summary.datasets, 'dataset')} and{' '}
          {plural(summary.widgets, 'widget')}
          {summary.files
            ? `, and ${plural(summary.files, 'uploaded file')} (${formatSize(summary.bytes)})`
            : ''}
          .{summary.exportedAt ? ` Exported ${relativeTime(summary.exportedAt)}.` : ''}
        </p>
        {/* undefined = still loading, null = signed out: saying "public" before we know would flash for members. */}
        {me !== undefined ? (
          <p>
            {me
              ? 'It will be private to you. You can share it afterwards.'
              : 'You are not signed in, so it will be public (anyone with the link can view it) and editable only from this browser.'}
          </p>
        ) : null}
        {summary.secretDatasets.length ? (
          <p>
            {quoteList(summary.secretDatasets)} used secrets where this file comes from. Add your own under
            Credentials in each dataset; until then they load without credentials.
          </p>
        ) : null}
        {summary.missingFileDatasets.length ? (
          <p>
            {quoteList(summary.missingFileDatasets)} use uploaded files that are not in this file. They will
            show an error until you upload the data again.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function FilePicker({ flow, children }: { flow: Flow; children: (open: () => void) => ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void flow.choose(file);
          e.target.value = '';
        }}
      />
      {children(() => input.current?.click())}
      <ImportDialog flow={flow} />
    </>
  );
}

/** For page headers (My dashboards). */
export function ImportDashboardButton() {
  const flow = useImport();
  return (
    <FilePicker flow={flow}>
      {(open) => (
        <Button icon={<Upload className="size-4" />} loading={flow.step.kind === 'reading'} onClick={open}>
          Import
        </Button>
      )}
    </FilePicker>
  );
}

/** For the New dashboard page: works without an account, and takes a dropped file too. */
export function ImportDashboardCard() {
  const flow = useImport();
  const [over, setOver] = useState(false);
  return (
    <FilePicker flow={flow}>
      {(open) => (
        <Card className="mt-4 p-0">
          <button
            type="button"
            onClick={open}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void flow.choose(file);
            }}
            className={cx(
              'flex w-full items-center gap-4 rounded-xl border border-dashed p-5 text-left text-sm transition',
              over ? 'border-ink bg-surface-2' : 'border-transparent hover:bg-surface-2',
            )}
          >
            {flow.step.kind === 'reading' ? <Spinner /> : <FileUp className="size-6 shrink-0 text-muted" />}
            <span>
              <span className="block font-medium text-ink">Import file</span>
              <span className="text-ink-2">
                Drop a .patchbay.json file here or click to choose one. It becomes a new dashboard with its
                data.
              </span>
            </span>
          </button>
        </Card>
      )}
    </FilePicker>
  );
}
