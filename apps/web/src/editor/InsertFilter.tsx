/** The "Insert filter" menu and chips (proposal 0010): only references validation accepts where they go. */
import { SlidersHorizontal } from 'lucide-react';
import { Menu, MenuItem, MenuLabel } from '../components/ui.tsx';
import type { RefChoice } from './parameter-refs.ts';

export function InsertFilterMenu({
  choices,
  onInsert,
  emptyHint,
}: {
  choices: RefChoice[];
  onInsert: (text: string) => void;
  emptyHint: string;
}) {
  return (
    <Menu label="Insert filter" icon={<SlidersHorizontal className="size-4" />}>
      {choices.length > 0 ? (
        choices.map((c) => (
          <MenuItem key={c.text} onSelect={() => onInsert(c.text)}>
            <span className="font-mono text-xs">{c.text}</span> <span className="text-muted">{c.label}</span>
          </MenuItem>
        ))
      ) : (
        <MenuLabel>{emptyHint}</MenuLabel>
      )}
    </Menu>
  );
}

export function FilterChips({
  choices,
  onInsert,
}: {
  choices: RefChoice[];
  onInsert: (text: string) => void;
}) {
  if (choices.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="text-muted">Filters:</span>
      {choices.map((c) => (
        <button
          key={c.text}
          type="button"
          title={c.label}
          onClick={() => onInsert(c.text)}
          className="rounded-md border border-line px-1.5 py-0.5 font-mono text-ink-2 transition hover:border-ink-2"
        >
          {c.text}
        </button>
      ))}
    </div>
  );
}
