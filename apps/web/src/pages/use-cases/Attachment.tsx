import { parseCsv, type UseCaseInfo } from '@patchbay/core';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { buttonClass, cx, Modal, Spinner } from '../../components/ui.tsx';
import { formatBytes } from '../_shared.tsx';

type Info = NonNullable<UseCaseInfo['attachment']>;

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The file the agent got with the prompt, shown the way a chat shows an attached file. */
export function Attachment({ attachment, onInteract }: { attachment: Info; onInteract: () => void }) {
  const [open, setOpen] = useState(false);
  const summary = `${attachment.rows} rows · ${formatBytes(attachment.bytes)}`;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          // Reading the data is reading this tab: the section must not move on behind the dialog.
          onInteract();
          setOpen(true);
        }}
        className="group mt-2 flex w-full max-w-xs items-center gap-3 rounded-xl border border-line bg-surface py-2 pr-2 pl-2.5 text-left transition hover:border-line-strong hover:bg-surface-2"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-good/10 text-good">
          <FileSpreadsheet className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span className="block text-xs text-muted">{summary}</span>
        </span>
        <span className="flex items-center text-xs font-medium text-ink-2 group-hover:text-ink">
          View
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={attachment.name}
        footer={
          // The server sends it with Content-Disposition: attachment; `download` names it the same way.
          <a href={attachment.url} download={attachment.name} className={buttonClass('accent', 'md')}>
            <Download className="size-4" aria-hidden="true" />
            Download CSV
          </a>
        }
      >
        <p className="mb-3">
          The file the agent got with the prompt: <span className="whitespace-nowrap">{summary}</span>.
        </p>
        <CsvTable url={attachment.url} />
      </Modal>
    </>
  );
}

function CsvTable({ url }: { url: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['use-case-attachment', url],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCsv(await res.text());
    },
    // The URL carries the content hash, so the file behind it never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (isPending)
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  if (isError || !data?.length)
    return <p className="text-bad">The file could not be loaded. Download it instead.</p>;
  const [header = [], ...rows] = data;
  // Numbers line up on the right, as in a spreadsheet.
  const numeric = header.map((_, c) => rows.every((r) => NUMBER.test(r[c] ?? '')));
  return (
    // Its own scroller in both directions, so the header can stick while the rows scroll.
    <div className="max-h-[min(55dvh,28rem)] overflow-auto overscroll-contain rounded-lg border border-line">
      <table className="w-full border-collapse text-xs text-ink">
        <thead>
          <tr>
            {header.map((h, c) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional and never reorder
                key={c}
                scope="col"
                className={cx(
                  'sticky top-0 border-b border-line bg-surface-2 px-2.5 py-2 font-semibold whitespace-nowrap sm:px-3',
                  numeric[c] ? 'text-right' : 'text-left',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static file, rows never reorder
            <tr key={i} className="border-b border-line last:border-0 even:bg-surface">
              {header.map((_, c) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional and never reorder
                  key={c}
                  className={cx(
                    'px-2.5 py-1.5 whitespace-nowrap sm:px-3',
                    numeric[c] ? 'text-right' : 'text-left',
                  )}
                >
                  {r[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
