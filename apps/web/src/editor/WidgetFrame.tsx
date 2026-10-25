import type { Widget } from '@patchbay/core';
import { Copy, GripVertical, Image, Settings2, Trash2 } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { cx, IconButton, toast } from '../components/ui.tsx';
import { relativeTime } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';
import { useDatasetResult } from '../state/sync.ts';
import { WidgetBody } from '../widgets/WidgetBody.tsx';

function uniqueId(base: string, taken: Set<string>) {
  const root = base.replace(/-\d+$/, '').slice(0, 34);
  for (let n = 2; ; n++) {
    const id = `${root}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export const WidgetFrame = memo(function WidgetFrame({
  dashboardId,
  widget,
  live,
  editing,
  onEdit,
}: {
  dashboardId: string;
  widget: Widget;
  live: boolean;
  editing: boolean;
  onEdit: (id: string) => void;
}) {
  const dataset = useEditor((s) =>
    'datasetId' in widget ? s.doc?.datasets.find((d) => d.id === widget.datasetId) : undefined,
  );
  const flashAt = useEditor((s) => s.flash[widget.id]);
  const apply = useEditor((s) => s.apply);
  const query = useDatasetResult(dashboardId, dataset, live);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!flashAt) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 2400);
    return () => clearTimeout(t);
  }, [flashAt]);

  const isLive = Boolean(dataset && dataset.refreshSec > 0);
  const result = query.data;

  const duplicate = () => {
    const doc = useEditor.getState().doc!;
    const id = uniqueId(widget.id, new Set(doc.widgets.map((w) => w.id)));
    const item = doc.layout.find((l) => l.i === widget.id);
    const err = apply(
      [
        {
          op: 'addWidget',
          widget: { ...widget, id, title: widget.title ? `${widget.title} (copy)` : undefined },
          ...(item ? { position: { w: item.w, h: item.h } } : {}),
        },
      ],
      'Duplicated widget',
    );
    if (err) toast(err, 'bad');
  };

  return (
    <section
      className={cx(
        'group flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface transition-shadow',
        editing && 'hover:border-line-strong',
        flashing && 'pb-flash',
      )}
      aria-label={widget.title ?? widget.id}
    >
      <header
        className={cx(
          'flex h-10 shrink-0 items-center gap-1.5 pr-1.5 pl-3',
          editing && 'pb-drag cursor-grab active:cursor-grabbing',
        )}
      >
        {editing ? (
          <GripVertical className="-ml-1.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
        ) : null}
        <h3 className="truncate text-[13.5px] font-semibold" title={widget.description ?? widget.title}>
          {widget.title ?? (widget.type === 'text' ? '' : widget.id)}
        </h3>
        {isLive ? (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] text-muted"
            title={result ? `Updated ${relativeTime(result.fetchedAt)}` : 'Live'}
          >
            <span className={cx('size-1.5 rounded-full', live ? 'animate-pulse bg-good' : 'bg-muted')} />
            live
          </span>
        ) : null}
        {result?.error && result.table.rows.length > 0 ? (
          <span className="shrink-0 text-[11px] text-warn" title={result.error}>
            stale
          </span>
        ) : null}
        <span className="flex-1" />
        {editing ? (
          <div className="pb-no-drag flex items-center opacity-70 transition group-hover:opacity-100">
            <IconButton label="Edit widget" onClick={() => onEdit(widget.id)}>
              <Settings2 className="size-3.5" />
            </IconButton>
            <IconButton label="Duplicate widget" onClick={duplicate}>
              <Copy className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove widget"
              onClick={() => {
                const err = apply(
                  [{ op: 'removeWidget', id: widget.id }],
                  `Removed "${widget.title ?? widget.id}"`,
                );
                if (err) toast(err, 'bad');
                else
                  toast('Widget removed', 'neutral', {
                    label: 'Undo',
                    run: () => useEditor.getState().undo(),
                  });
              }}
              className="hover:text-bad"
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ) : (
          <a
            href={`/api/dashboards/${dashboardId}/snapshot.png?widget=${encodeURIComponent(widget.id)}`}
            target="_blank"
            rel="noreferrer"
            className="pb-no-drag hidden size-7 items-center justify-center rounded-md text-muted opacity-0 transition group-hover:opacity-100 hover:bg-surface-2 hover:text-ink sm:flex"
            title="Open as image"
          >
            <Image className="size-3.5" />
          </a>
        )}
      </header>
      <div className="pb-no-drag min-h-0 flex-1 px-3 pb-3">
        <WidgetBody widget={widget} result={result} loading={query.isFetching || !query.isFetched} />
      </div>
    </section>
  );
});
