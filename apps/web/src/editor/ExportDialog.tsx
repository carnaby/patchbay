import { portability, type UploadedFile } from '@patchbay/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Button, Modal, toast } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { downloadExport, exportSummary, formatMb, quoteList } from '../lib/transfer.ts';
import { useEditor } from '../state/editor.ts';

/** What the file will hold and what it will not, then the download. The file is what the server has saved. */
export function ExportDialog({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
}) {
  const doc = useEditor((s) => s.saved ?? s.doc)!;
  const access = useEditor((s) => s.access)!;
  const pending = useEditor((s) => s.doc !== s.saved || s.saving);
  const summary = exportSummary(doc, access.canEdit);
  const files = useQuery({
    queryKey: ['files', dashboardId],
    queryFn: () => api<UploadedFile[]>(`/api/dashboards/${dashboardId}/files`, { dashboardId }),
    enabled: open && summary.filesIncluded,
  });
  const used = new Set(portability(doc).uploads.map((u) => u.fileId));
  const included = (files.data ?? []).filter((f) => used.has(f.id));
  const bytes = included.reduce((sum, f) => sum + (f.storedBytes ?? f.size), 0);
  const download = useMutation({
    mutationFn: () => downloadExport(dashboardId, doc.title),
    onSuccess: () => {
      onClose();
      toast('Exported', 'good');
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Export "${doc.title}"`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={download.isPending}
            disabled={pending}
            onClick={() => download.mutate()}
          >
            Download
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-2">
        <p>
          Downloads one .patchbay.json file. Import it on any Patchbay server, this one or your own, with
          Import file on the New dashboard page.
        </p>
        <div>
          <div className="font-medium text-ink">Included</div>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              The dashboard: {summary.datasets} dataset{summary.datasets === 1 ? '' : 's'}, {summary.widgets}{' '}
              widget
              {summary.widgets === 1 ? '' : 's'}, layout and colours.
            </li>
            {summary.filesIncluded ? (
              <li>
                {used.size} uploaded file{used.size === 1 ? '' : 's'}
                {files.data ? `, about ${formatMb(bytes)}` : ''}.
              </li>
            ) : null}
          </ul>
        </div>
        <div>
          <div className="font-medium text-ink">Not included</div>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Version history, the owner and who can open it.</li>
            {summary.secretDatasets.length ? (
              <li>
                The secrets of {quoteList(summary.secretDatasets)}. Whoever imports the file adds their own
                under Credentials.
              </li>
            ) : null}
            {summary.uploadDatasets.length && !summary.filesIncluded ? (
              <li>
                The uploaded data of {quoteList(summary.uploadDatasets)}: only editors can export it. Use Make
                a copy to keep a working copy on this server.
              </li>
            ) : null}
          </ul>
        </div>
        {summary.keyInUrl.map((k) => (
          <p
            key={k.dataset}
            className="flex gap-2 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs text-ink"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden="true" />
            The address of "{k.dataset}" seems to contain a key ({k.params.join(', ')}). Anyone you give this
            file to can read it.
          </p>
        ))}
        {pending ? <p className="text-xs text-muted">Saving your latest changes first…</p> : null}
      </div>
    </Modal>
  );
}
