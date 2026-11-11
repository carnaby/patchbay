export type StateKind = 'waiting' | 'empty' | 'error';

export interface StateClasses {
  box: string;
  text: string;
  icon: string;
  hint: string;
}

// Literal class strings: Tailwind scans the source and cannot see names built from parts.
const PLAIN: Record<StateKind, StateClasses> = {
  waiting: {
    box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted',
    text: 'line-clamp-3',
    icon: 'size-5',
    hint: '',
  },
  empty: {
    box: 'flex h-full items-center justify-center',
    text: 'text-sm text-muted',
    icon: '',
    hint: '',
  },
  error: {
    box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-bad',
    text: 'line-clamp-3',
    icon: 'size-5',
    hint: 'line-clamp-3 text-xs text-ink-2',
  },
};

// A container cannot size its own text, so the sizes sit on its children. The `length:` hint keeps Tailwind from
// reading the clamp() as a colour.
const PRESENTING: Record<StateKind, StateClasses> = {
  waiting: {
    box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted @container',
    text: 'line-clamp-3 text-[length:clamp(14px,5cqi,24px)]',
    icon: 'size-[clamp(20px,7cqi,32px)]',
    hint: '',
  },
  empty: {
    box: 'flex h-full items-center justify-center text-muted @container',
    text: 'text-[length:clamp(14px,5cqi,24px)]',
    icon: '',
    hint: '',
  },
  error: {
    box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-bad @container',
    text: 'line-clamp-3 text-[length:clamp(14px,5cqi,24px)]',
    icon: 'size-[clamp(20px,7cqi,32px)]',
    hint: 'line-clamp-3 text-ink-2 text-[length:clamp(12px,3.5cqi,18px)]',
  },
};

/** Classes of the waiting, no-data and error states; on a wall screen they scale with the widget (14 to 24 px). */
export function stateClasses(kind: StateKind, presenting: boolean): StateClasses {
  return (presenting ? PRESENTING : PLAIN)[kind];
}
