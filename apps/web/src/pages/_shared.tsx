/** Small helpers shared by the secondary pages. */
import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cx, toast } from '../components/ui.tsx';

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Copy failed, select the text and copy it manually', 'bad');
    }
  };
  return { copied, copy };
}

/** A monospace value with a copy button, e.g. a URL or a token. */
export function CopyField({
  value,
  className,
  label = 'Copy',
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3',
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{value}</code>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={label}
        title={label}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
      >
        {copied ? <Check className="size-4 text-good" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1.5 max-w-2xl text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
