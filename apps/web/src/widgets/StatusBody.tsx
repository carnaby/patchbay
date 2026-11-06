/**
 * The status widget's body: a summary line, then one tile per entity in sections. Which tiles to draw and what to
 * fold into "+N" comes from core's statusFit for the measured size, the function the snapshot renderer uses too, so a
 * screen and the image an agent looks at agree. Nothing scrolls: wall screens show it unattended.
 */
import {
  type ChartTheme,
  type DatasetResult,
  formatRelative,
  formatTime,
  resolveColor,
  STATUS_COLORS,
  STATUS_LEVEL_TEXT,
  STATUS_METRICS,
  type StatusCheck,
  type StatusPlaced,
  type StatusSection,
  type StatusTile,
  statusConfigProblem,
  statusFit,
  statusModel,
  statusMoreNames,
  statusMoreSectionsTitle,
  statusMoreTitle,
  statusProblemHead,
  statusSectionTitle,
  statusSummary,
  statusTileFoot,
  statusTilesByKey,
  THEMES,
  type Widget,
} from '@patchbay/core';
import { AlertTriangle } from 'lucide-react';
import { type CSSProperties, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx, Modal } from '../components/ui.tsx';
import { PresentingContext } from '../editor/presentation.tsx';
import { useNow, useTheme } from '../lib/hooks.ts';

const M = STATUS_METRICS;
const font = (size: number, line: number): CSSProperties => ({ fontSize: size, lineHeight: `${line}px` });

type Open = (title: string, tiles: readonly StatusTile[]) => void;

/** What the panel lists: tiles by key, looked up again in every new model, so live data never shows stale checks. */
interface PanelTarget {
  title: string;
  keys: string[];
}

/** The body's size. The card sizes the box, never its content, so drawing a new layout cannot resize it again. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = Math.floor(node.clientWidth);
      const height = Math.floor(node.clientHeight);
      // The same size keeps the same object: a new one would fit and render again for nothing.
      setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export function StatusBody({
  widget,
  result,
}: {
  widget: Extract<Widget, { type: 'status' }>;
  result: DatasetResult;
}) {
  const mode = useTheme();
  const theme = THEMES[mode];
  // "9 hours ago" stays true on a wall screen that gets no new data.
  const now = useNow(60_000);
  const { ref, size } = useBoxSize();
  const model = useMemo(() => statusModel(result.table, widget.config), [result.table, widget.config]);
  // The fit estimates text from one average glyph width; a platform font that runs wider (capitals on a phone) can
  // wrap a detail onto a line the fit did not count, and the bottom would be cut. When the drawing overflows, how much
  // taller it is than the fit's estimate is measured once per size and data, and the fit runs again with that error
  // taken off the height (the slack the estimate already left is not counted twice): one extra pass, never a loop.
  const fitKey = useMemo(() => ({ model, size }), [model, size]);
  const [overflow, setOverflow] = useState<{ key: object; px: number } | null>(null);
  const shrink = overflow?.key === fitKey ? overflow.px : 0;
  const layout = useMemo(
    () => (size ? statusFit(model, { width: size.width, height: size.height - shrink }) : null),
    [model, size, shrink],
  );
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !layout || shrink) return;
    const error = node.scrollHeight - layout.height;
    if (node.scrollHeight > node.clientHeight && error > 0) setOverflow({ key: fitKey, px: error });
  }, [ref, layout, fitKey, shrink]);
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const presenting = useContext(PresentingContext);
  // Presentations run unattended: a panel opened by a stray click beforehand would cover the board for good.
  useEffect(() => {
    if (presenting) setPanel(null);
  }, [presenting]);
  const problem = statusConfigProblem(model, widget.config);
  const open: Open = (title, tiles) => setPanel({ title, keys: tiles.map((t) => t.key) });

  return (
    // Always rendered: the size observer attaches to it once, whatever is drawn inside.
    <div ref={ref} className="h-full w-full overflow-hidden">
      {problem ? (
        <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-sm text-bad">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span className="line-clamp-3">{problem}</span>
        </div>
      ) : layout ? (
        <>
          {layout.summaryHeight ? (
            <p
              className="flex items-start gap-2 font-semibold text-ink"
              style={{ height: M.summaryHeight, ...font(M.summarySize, M.summaryLine) }}
            >
              <span
                aria-hidden="true"
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: resolveColor(STATUS_COLORS[model.level], theme, 'mark') }}
              />
              <span className="truncate">{statusSummary(model)}</span>
            </p>
          ) : model.sections.length === 0 ? (
            <p className="text-sm text-muted">No checks</p>
          ) : null}
          <div className="flex flex-col" style={{ gap: M.sectionGap }}>
            {layout.sections.map((s) => (
              <section key={s.section.key}>
                {s.header ? (
                  <HeaderLine
                    title={statusSectionTitle(s.section)}
                    onClick={() => open(s.section.label ?? 'Checks', s.section.tiles)}
                  />
                ) : null}
                {s.items.length ? (
                  <div
                    className="grid"
                    style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gap: M.gap }}
                  >
                    {s.items.map((placed) => (
                      <Cell
                        key={placed.item.kind === 'tile' ? placed.item.tile.key : `more:${placed.item.what}`}
                        placed={placed}
                        theme={theme}
                        now={now}
                        onOpen={open}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
            {layout.moreSections ? (
              <MoreSections sections={layout.moreSections.sections} onOpen={open} />
            ) : null}
          </div>
        </>
      ) : null}
      <Modal open={panel !== null} title={panel?.title ?? ''} onClose={() => setPanel(null)} size="lg">
        {panel ? <Checks tiles={statusTilesByKey(model, panel.keys)} theme={theme} now={now} /> : null}
      </Modal>
    </div>
  );
}

function HeaderLine({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="block w-full truncate text-left font-semibold text-ink-2 hover:text-ink"
      style={{ height: M.headerHeight, ...font(M.textSize, M.headerLine) }}
      onClick={onClick}
    >
      {title}
    </button>
  );
}

/** Calm sections at the end, folded into one line: like a header, it lists their checks. */
function MoreSections({ sections, onOpen }: { sections: readonly StatusSection[]; onOpen: Open }) {
  const title = statusMoreSectionsTitle(sections);
  return (
    <HeaderLine
      title={title}
      onClick={() =>
        onOpen(
          title,
          sections.flatMap((s) => s.tiles),
        )
      }
    />
  );
}

function Cell({
  placed,
  theme,
  now,
  onOpen,
}: {
  placed: StatusPlaced;
  theme: ChartTheme;
  now: number;
  onOpen: Open;
}) {
  const { item } = placed;
  const level = item.kind === 'tile' ? item.tile.level : item.level;
  const token = STATUS_COLORS[level];
  const name = item.kind === 'tile' ? item.tile.entity : statusMoreTitle(item);
  const tiles = item.kind === 'tile' ? [item.tile] : item.tiles;
  const foot = item.kind === 'tile' ? statusTileFoot(item.tile) : statusMoreNames(item.tiles);
  return (
    <button
      type="button"
      title={name}
      onClick={() => onOpen(name, tiles)}
      className="flex min-w-0 flex-col overflow-hidden rounded-md text-left"
      style={{
        gridColumn: `span ${placed.span}`,
        // The fit's estimate, so rows line up with the snapshot; content that runs longer still grows the row.
        minHeight: placed.height,
        padding: `${M.padY}px ${M.padX}px`,
        borderLeft: `${M.accent}px solid ${resolveColor(token, theme, 'mark')}`,
        backgroundColor: resolveColor(token, theme, 'fill'),
      }}
    >
      <span
        className={cx('block truncate font-semibold', level === 'off' ? 'text-ink-2' : 'text-ink')}
        style={{ height: M.nameHeight, ...font(M.nameSize, M.nameHeight) }}
      >
        {name}
        <span className="sr-only">: {STATUS_LEVEL_TEXT[level]}</span>
      </span>
      {item.kind === 'tile'
        ? item.tile.problems.map((check, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checks have no identity of their own
            <Problem key={i} check={check} clamp={item.clamp} theme={theme} now={now} />
          ))
        : null}
      {foot ? (
        <span className="block truncate text-ink-2" style={font(M.textSize, M.lineHeight)}>
          {foot}
        </span>
      ) : null}
    </button>
  );
}

function Problem({
  check,
  clamp,
  theme,
  now,
}: {
  check: StatusCheck;
  clamp: boolean;
  theme: ChartTheme;
  now: number;
}) {
  return (
    <span className="block" style={{ marginTop: M.problemGap }}>
      <span
        className="block truncate font-semibold"
        style={{
          ...font(M.textSize, M.lineHeight),
          color: resolveColor(STATUS_COLORS[check.level], theme, 'text'),
        }}
      >
        {statusProblemHead(check, now)}
      </span>
      {check.detail ? (
        // pre-line and break-words: the wrapping core's wrapText estimates.
        <span
          className={cx('break-words whitespace-pre-line text-ink', clamp ? 'line-clamp-2' : 'block')}
          style={font(M.textSize, M.lineHeight)}
        >
          {check.detail}
        </span>
      ) : null}
    </span>
  );
}

function Checks({ tiles, theme, now }: { tiles: StatusTile[]; theme: ChartTheme; now: number }) {
  if (!tiles.length) return <p className="text-sm text-muted">These checks are no longer in the data.</p>;
  return (
    <div className="space-y-4">
      {tiles.map((tile) => (
        <section key={tile.key}>
          {tiles.length > 1 ? (
            <h3 className="mb-1 text-[13px] font-semibold text-ink">{tile.entity}</h3>
          ) : null}
          <ul className="divide-y divide-line">
            {tile.checks.map((check, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: checks have no identity of their own
              <CheckRow key={i} check={check} theme={theme} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CheckRow({ check, theme, now }: { check: StatusCheck; theme: ChartTheme; now: number }) {
  const extra = [
    check.kind,
    check.value && check.value.toLowerCase() !== check.level ? `status "${check.value}"` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span
          className="w-14 shrink-0 font-semibold"
          style={{ color: resolveColor(STATUS_COLORS[check.level], theme, 'text') }}
        >
          {STATUS_LEVEL_TEXT[check.level]}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{check.label ?? (check.value || 'Check')}</span>
        {check.since !== null ? (
          <span className="shrink-0 text-xs text-muted" title={formatTime(check.since)}>
            {formatRelative(check.since, now)}
          </span>
        ) : null}
      </div>
      {check.detail ? (
        <p className="mt-0.5 pl-16 text-xs break-words whitespace-pre-line text-ink-2">{check.detail}</p>
      ) : null}
      {extra ? <p className="mt-0.5 pl-16 text-xs text-muted">{extra}</p> : null}
    </li>
  );
}
