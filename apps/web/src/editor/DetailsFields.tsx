import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Card, cx } from '../components/ui.tsx';
import { commitDetails, type DetailsField, detailsLimits } from '../state/details.ts';
import { useEditor } from '../state/editor.ts';

/**
 * A title or description field. It keeps a local draft while focused and commits it on blur or Enter, so a
 * rename is one undo step and one saved version, and an empty title never reaches the document. Escape puts the
 * current value back. While nobody types in it, it shows the live value, so changes from other tabs and agents
 * appear as they arrive.
 */
export function DetailsInput({
  field,
  label,
  placeholder,
  className,
  inline,
}: {
  field: DetailsField;
  label: string;
  placeholder?: string;
  className?: string;
  /** Borderless, for editing in place on the dashboard itself. */
  inline?: boolean;
}) {
  const id = useId();
  const value = useEditor((s) => s.doc?.[field] ?? '');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Closing the panel with a tap may unmount the field without a blur (iOS does not move focus to buttons).
  useEffect(
    () => () => {
      if (draftRef.current !== null) commitDetails(field, draftRef.current);
    },
    [field],
  );

  const commit = () => {
    if (draft === null) return true;
    const problem = commitDetails(field, draft);
    if (problem) {
      setError(problem);
      return false;
    }
    setDraft(null);
    setError(null);
    return true;
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && draft !== null) {
      // The first Escape only undoes the typing; the next one may close the panel around the field.
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  const onBlur = () => {
    // Leaving the field with an empty title keeps the previous one rather than trapping focus.
    if (!commit()) setDraft(null);
  };

  const shared = {
    id,
    value: draft ?? value,
    maxLength: detailsLimits[field],
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      setError(null);
    },
    onKeyDown,
    onBlur,
  };

  const control =
    field === 'title' ? (
      <input
        {...shared}
        type="text"
        enterKeyHint="done"
        autoComplete="off"
        className={cx(
          inline
            ? 'w-full rounded-md bg-transparent px-1 -ml-1 outline-none hover:bg-surface-2 focus:bg-surface-2'
            : 'h-10 w-full rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold text-ink transition focus:border-ink-2 focus:outline-none',
          error && !inline && 'border-bad',
        )}
      />
    ) : (
      <textarea
        {...shared}
        rows={inline ? 1 : 3}
        enterKeyHint="done"
        className={cx(
          inline
            ? 'block w-full resize-none rounded-md bg-transparent px-1 -ml-1 text-sm text-ink-2 outline-none hover:bg-surface-2 focus:bg-surface-2 [field-sizing:content]'
            : 'block w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink transition focus:border-ink-2 focus:outline-none',
          error && !inline && 'border-bad',
        )}
      />
    );

  return (
    <div className={cx(!inline && 'space-y-1.5', className)}>
      <label htmlFor={id} className={inline ? 'sr-only' : 'block text-[13px] font-medium text-ink-2'}>
        {label}
      </label>
      {control}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Title and description at the top of the details and sharing panel: editable for editors, plain text for
 * everyone else.
 */
export function DetailsCard() {
  const canEdit = useEditor((s) => s.access?.canEdit ?? false);
  const title = useEditor((s) => s.doc?.title ?? '');
  const description = useEditor((s) => s.doc?.description ?? '');
  if (!canEdit) {
    return (
      <div className="space-y-1 px-1">
        <div className="text-base font-semibold break-words text-ink">{title}</div>
        {description ? <p className="text-sm break-words text-ink-2">{description}</p> : null}
      </div>
    );
  }
  return (
    <Card className="space-y-3 p-4">
      <DetailsInput field="title" label="Title" />
      <DetailsInput
        field="description"
        label="Description"
        placeholder="What this dashboard shows (optional)"
      />
    </Card>
  );
}
