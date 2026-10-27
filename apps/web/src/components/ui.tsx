/** Small, dependency-free UI kit. Tokens come from styles.css. */
import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

export { clsx as cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-page hover:opacity-90',
  accent: 'bg-accent text-accent-ink hover:brightness-110',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-surface text-bad border border-line hover:border-bad/60 hover:bg-bad/5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition select-none disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'h-8 px-2.5 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-12 px-5 text-base',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  active,
  touch,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  /** 40 px instead of 32 px, for controls that are mainly used with a finger. */
  touch?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg text-ink-2 transition hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent',
        touch ? 'size-10' : 'size-8',
        active && 'bg-surface-2 text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-xl border border-line bg-surface', className)}>{children}</div>;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'bad' | 'data';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-2 text-ink-2',
        tone === 'accent' && 'bg-accent/12 text-accent',
        tone === 'good' && 'bg-good/10 text-good',
        tone === 'bad' && 'bg-bad/10 text-bad',
        tone === 'data' && 'bg-data/10 text-data',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-muted', className)} />;
}

const fieldBase =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted transition focus:border-ink-2 focus:outline-none disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx(fieldBase, 'h-9', className)} {...rest} />;
});

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(fieldBase, 'min-h-24 py-2 font-mono text-[13px]', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(fieldBase, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-ink-2">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-5 w-9 rounded-full transition', checked ? 'bg-ink' : 'bg-line-strong')}
      >
        <span
          className={clsx(
            'absolute top-0.5 size-4 rounded-full bg-page transition',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition',
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- overlays ---------- */

/** Open overlays, innermost last: Escape and the Tab trap belong to the innermost one only. */
const overlayStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard and focus for anything that sits on top of the page: Escape closes it, Tab stays inside, focus moves
 * in on open (unless a field already took it with autoFocus) and goes back to where it was on close.
 */
export function useOverlay(open: boolean, onClose: () => void, panel: { current: HTMLElement | null }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const token = Symbol('overlay');
    overlayStack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (overlayStack.at(-1) !== token || !node) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.offsetParent !== null,
        );
        const first = items[0];
        const last = items.at(-1);
        const active = document.activeElement;
        if (!first || !last) {
          e.preventDefault();
        } else if (e.shiftKey && (active === first || active === node || !node.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !node.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      overlayStack.splice(overlayStack.indexOf(token), 1);
      // Only when focus was lost with the overlay; a click that moved it elsewhere on purpose wins.
      const active = document.activeElement;
      if (previous?.isConnected && (!active || active === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, panel]);
}

const NARROW = '(max-width: 639.98px)';

/** True below Tailwind's `sm` breakpoint, where popovers become bottom sheets. */
export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const list = window.matchMedia(NARROW);
    const onChange = () => setNarrow(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * Right-hand side panel used by the editor (datasets, widgets, versions...). Like every overlay it is portalled
 * to <body>: the sticky toolbar's backdrop blur makes it the containing block of `position: fixed` descendants,
 * which would shrink an overlay opened from there to the toolbar's 56 px.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'w-[min(560px,100vw)]',
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  useOverlay(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        className="absolute inset-0 bg-black/20 dark:bg-black/50"
        onClick={onClose}
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'relative flex h-full flex-col border-l border-line bg-page shadow-2xl outline-none',
          width,
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 id={titleId} className="truncate text-[15px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * A dialog: centred from `sm` up, a bottom sheet on phones so it never runs off the top of the screen. Closes with
 * its close button, a tap on the backdrop or Escape; long content scrolls inside it.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-black/30 dark:bg-black/60"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl border border-line bg-page pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:pb-0',
          size === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex shrink-0 items-start gap-2 pt-3 pr-3 pb-2 pl-6 sm:pt-4">
          <h2 id={titleId} className="min-w-0 flex-1 pt-1.5 text-base font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} className="max-sm:size-10">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-6 pb-5 text-sm text-ink-2">
          {children}
        </div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
      {icon ? <div className="text-muted">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      {children ? <div className="max-w-md text-sm text-ink-2">{children}</div> : null}
      {action}
    </div>
  );
}

/* ---------- toasts ---------- */

interface Toast {
  id: number;
  message: string;
  tone: 'neutral' | 'bad' | 'good';
  action?: { label: string; run: () => void };
}

const useToasts = create<{
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.action ? 8000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = (message: string, tone: Toast['tone'] = 'neutral', action?: Toast['action']) =>
  useToasts.getState().push({ message, tone, ...(action ? { action } : {}) });

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border bg-ink px-4 py-2.5 text-sm text-page shadow-lg',
            t.tone === 'bad' ? 'border-bad' : 'border-transparent',
          )}
        >
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="font-semibold text-accent"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}

export function CodeBlock({ children, className }: { children: string; className?: string }) {
  return (
    <pre
      className={clsx(
        'overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12.5px] leading-relaxed text-ink',
        className,
      )}
    >
      {children}
    </pre>
  );
}

/* ---------- menus and popovers ---------- */

/**
 * Fixed coordinates for a panel hanging off a trigger, kept inside the viewport: right-aligned with the trigger,
 * at least 8 px from either edge, below it unless the trigger sits low on the screen, and never taller than the
 * room it has (the panel scrolls inside). `place` measures; call it before opening so the first frame is right.
 */
function useAnchoredPosition(
  open: boolean,
  trigger: { current: HTMLElement | null },
  panel: { current: HTMLElement | null },
  width: number,
) {
  const [position, setPosition] = useState<CSSProperties>({});
  const place = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const panelWidth = Math.min(width, window.innerWidth - 16);
    const right = Math.min(Math.max(8, window.innerWidth - rect.right), window.innerWidth - panelWidth - 8);
    const below = window.innerHeight - rect.bottom;
    // Open upwards only when the trigger sits low on the screen (the last widget on a phone).
    setPosition(
      below < 280 && rect.top > below
        ? { right, width: panelWidth, bottom: window.innerHeight - rect.top + 4, maxHeight: rect.top - 12 }
        : { right, width: panelWidth, top: rect.bottom + 4, maxHeight: below - 12 },
    );
  }, [trigger, width]);

  useEffect(() => {
    if (!open) return;
    // Follow the trigger rather than closing: a phone's momentum scroll often outlasts the tap that opened it.
    let frame = 0;
    const follow = (e: Event) => {
      if (e.type === 'scroll' && panel.current?.contains(e.target as Node)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [open, place, panel]);

  return [position, place] as const;
}

/**
 * A small trigger that shows a few paragraphs of help next to it. From `sm` up it is a popover anchored to the
 * trigger; on phones the same content opens as a bottom sheet (`Modal`), since a popover there has no room.
 * Either way it is portalled, closes on a click or tap outside, with Escape or with its close button.
 */
export function Popover({
  label,
  title,
  trigger,
  triggerClassName,
  width = 340,
  children,
}: {
  /** Accessible name of the trigger. */
  label: string;
  title: ReactNode;
  trigger: ReactNode;
  triggerClassName?: string;
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const narrow = useNarrowScreen();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [position, place] = useAnchoredPosition(open && !narrow, button, panel, width);
  const close = useCallback(() => setOpen(false), []);
  useOverlay(open && !narrow, close, panel);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {narrow ? (
        <Modal open={open} onClose={close} title={title}>
          {children}
        </Modal>
      ) : open ? (
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close"
              tabIndex={-1}
              className="fixed inset-0 z-50 cursor-default"
              onClick={close}
            />
            <div
              ref={panel}
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
              style={position}
              className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-4 text-sm text-ink-2 shadow-xl outline-none"
            >
              <div className="mb-2 flex items-start gap-2">
                <h2 id={titleId} className="min-w-0 flex-1 pt-1 font-semibold text-ink">
                  {title}
                </h2>
                <IconButton label="Close" onClick={close} className="-mt-1 -mr-2 size-7">
                  <X className="size-3.5" />
                </IconButton>
              </div>
              {children}
            </div>
          </>,
          document.body,
        )
      ) : null}
    </>
  );
}

const MenuClose = createContext<(refocus?: boolean) => void>(() => {});

/**
 * A button that opens a list of actions. The list is portalled to <body> with fixed positioning, because
 * widget frames clip their overflow and the toolbar's backdrop blur would otherwise become its containing block.
 * Items are at least 40 px tall so they work as touch targets.
 */
export function Menu({
  label,
  icon,
  children,
  className,
  touch,
  round,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  /** A 40 px trigger, like `IconButton`'s. */
  touch?: boolean;
  /** A circular trigger, for an avatar. */
  round?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [position, place] = useAnchoredPosition(open, trigger, list, 260);
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    place();
    setOpen(true);
  };

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    // Items hidden at this breakpoint (display: none) have no offsetParent and are skipped.
    const items = [
      ...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
    ].filter((el) => el.offsetParent !== null);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={clsx(
          'inline-flex shrink-0 items-center justify-center text-ink-2 transition hover:bg-surface-2 hover:text-ink',
          round ? 'overflow-hidden rounded-full border border-line bg-surface-2' : 'rounded-lg',
          touch ? 'size-10' : 'size-8',
          open && 'bg-surface-2 text-ink',
          className,
        )}
      >
        {icon}
      </button>
      {open
        ? createPortal(
            <MenuClose.Provider value={close}>
              <button
                type="button"
                aria-label="Close menu"
                tabIndex={-1}
                className="fixed inset-0 z-50 cursor-default"
                onClick={() => close(false)}
              />
              <div
                ref={list}
                role="menu"
                aria-label={label}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                style={position}
                className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 shadow-xl"
              >
                {children}
              </div>
            </MenuClose.Provider>,
            document.body,
          )
        : null}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  disabled,
  danger,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        close(false);
        onSelect();
      }}
      className={clsx(
        'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm outline-none transition focus-visible:bg-surface-2 disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-bad hover:bg-bad/5' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        className,
      )}
    >
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuSeparator({ className }: { className?: string }) {
  return <hr className={clsx('mx-2 my-1 h-px border-0 bg-line', className)} />;
}

/** Plain text in a menu, such as who is signed in; not an action, so arrow keys skip it. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2">{children}</div>;
}
