import { GRID_COLUMNS, type LayoutItem, readingOrder, type Widget } from '@patchbay/core';
import { ArrowUpDown, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { GridLayout, type Layout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import { IconButton, Kbd } from '../components/ui.tsx';
import { useEditor } from '../state/editor.ts';
import { WidgetFrame } from './WidgetFrame.tsx';

const ROW_HEIGHT = 80;
const MOBILE_BREAKPOINT = 720;

/** Stacked (mobile) heights: compact headline tiles, roomier charts and tables. */
function mobileHeight(widget: Widget, h: number) {
  if (widget.type === 'kpi') return widget.config.sparkline ? 150 : 112;
  if (widget.type === 'gauge') return 190;
  if (widget.type === 'text') return Math.max(h, 2) * 60;
  // A world map is about twice as wide as tall; more height on a phone would only add empty sea.
  if (widget.type === 'map') return 280;
  return Math.min(Math.max(h, 3), 6) * 72;
}

function sameLayout(
  a: readonly LayoutItem[],
  b: readonly { i: string; x: number; y: number; w: number; h: number }[],
) {
  if (a.length !== b.length) return false;
  const map = new Map(b.map((it) => [it.i, it]));
  return a.every((it) => {
    const o = map.get(it.i);
    return o && o.x === it.x && o.y === it.y && o.w === it.w && o.h === it.h;
  });
}

/**
 * One layout for desktop (12 columns). Below the breakpoint widgets stack in
 * reading order instead of keeping a second, hand-maintained mobile layout;
 * editing there means reordering, which moves widgets on the same grid.
 */
export function Grid({
  dashboardId,
  live,
  onEditWidget,
}: {
  dashboardId: string;
  live: boolean;
  onEditWidget: (id: string) => void;
}) {
  const doc = useEditor((s) => s.doc)!;
  const editing = useEditor((s) => s.editing);
  const apply = useEditor((s) => s.apply);
  const { width, containerRef, mounted } = useContainerWidth();
  const [remount, setRemount] = useState(0);

  const widgets = useMemo(() => new Map(doc.widgets.map((w) => [w.id, w])), [doc.widgets]);
  const layout = useMemo(() => doc.layout.map((l) => ({ ...l })), [doc.layout]);

  // Widgets added or removed elsewhere (another tab, an agent): force RGL to re-read the layout prop.
  const count = doc.layout.length;
  useEffect(() => {
    if (count >= 0) setRemount((n) => n + 1);
  }, [count]);

  const commit = (next: Layout) => {
    const items = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    if (sameLayout(doc.layout, items)) return;
    const error = apply([{ op: 'setLayout', layout: items }], 'Rearranged widgets');
    if (error) setRemount((n) => n + 1);
  };

  const mobile = mounted && width < MOBILE_BREAKPOINT;

  return (
    <div ref={containerRef} className="w-full">
      {!mounted ? null : mobile ? (
        <div className="flex flex-col gap-3">
          {editing ? <StackHint /> : null}
          {readingOrder(doc.layout).map((id) => {
            const widget = widgets.get(id);
            const item = doc.layout.find((l) => l.i === id)!;
            if (!widget) return null;
            return (
              <div key={id} style={{ height: mobileHeight(widget, item.h) }}>
                <WidgetFrame
                  dashboardId={dashboardId}
                  widget={widget}
                  live={live}
                  editing={editing}
                  stacked
                  onEdit={onEditWidget}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <GridLayout
          key={remount}
          width={width}
          layout={layout}
          gridConfig={{
            cols: GRID_COLUMNS,
            rowHeight: ROW_HEIGHT,
            margin: [12, 12],
            containerPadding: [0, 0],
          }}
          dragConfig={{ enabled: editing, handle: '.pb-drag', cancel: '.pb-no-drag' }}
          resizeConfig={{ enabled: editing, handles: ['se'] }}
          compactor={verticalCompactor}
          onDragStop={(next) => commit(next)}
          onResizeStop={(next) => commit(next)}
        >
          {doc.layout.map((item) => {
            const widget = widgets.get(item.i);
            if (!widget) return <div key={item.i} />;
            return (
              // The grid item itself must stay unstyled; the frame is the visual card.
              <div key={item.i}>
                <WidgetFrame
                  dashboardId={dashboardId}
                  widget={widget as Widget}
                  live={live}
                  editing={editing}
                  onEdit={onEditWidget}
                />
              </div>
            );
          })}
        </GridLayout>
      )}
      {mounted && !mobile && editing ? (
        <p className="mt-6 text-center text-xs text-muted">
          Drag widgets by their title, resize from the corner. <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo,{' '}
          <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd> redo. Every change is saved and versioned.
        </p>
      ) : null}
    </div>
  );
}

const HINT_KEY = 'pb-stack-hint-dismissed';

/** A short tip on why a narrow screen only offers reordering; dismissing it is remembered per browser. */
function StackHint() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 py-1 pr-1 pl-3 text-xs text-ink-2">
      <ArrowUpDown className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Reorder with the arrows. Resizing and side-by-side placement need a wider screen.
      </span>
      <IconButton
        label="Hide this tip"
        touch
        className="shrink-0"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // Storage blocked: the tip just comes back next time.
          }
        }}
      >
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}
