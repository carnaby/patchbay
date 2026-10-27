/**
 * The one colour picker: named colours first (they adapt to dark mode and keep contrast), a custom hex as the
 * exception, with its contrast in both themes shown so a colour that vanishes in one of them is caught here.
 */
import { COLOR_TOKENS, type Color, isHexColor, resolveColor, THEMES } from '@patchbay/core';
import { Check, ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { colorName, contrastNote } from '../lib/color-labels.ts';
import { useTheme } from '../lib/hooks.ts';
import { cx, Input } from './ui.tsx';

const ACCENTS = COLOR_TOKENS.slice(0, 8);
const STATUS = COLOR_TOKENS.slice(8);

/** Arrow keys move between swatches of a row, as in a toolbar; Tab leaves the row. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? buttons.length - 1
        : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function ColorPicker({
  label,
  value,
  onChange,
  onReset,
  placeholder = 'Automatic',
  automatic,
}: {
  /** What the colour is for, e.g. "Colour of sun"; the trigger's accessible name. */
  label: string;
  value: Color | undefined;
  onChange: (color: Color) => void;
  /** Offered as "Reset" when there is a value: removes it instead of choosing another. */
  onReset?: () => void;
  /** The colour used when there is no value, shown on the trigger so "Automatic" is not a blank. */
  automatic?: string | undefined;
  /** Shown when there is no value. */
  placeholder?: string;
}) {
  const mode = useTheme();
  const theme = THEMES[mode];
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(value && isHexColor(value) ? value : '');
  const panelId = useId();
  const swatch = value ? resolveColor(value, theme, 'mark') : automatic;
  const customValid = isHexColor(custom);
  const note = customValid ? contrastNote(custom) : null;

  const row = (tokens: readonly Color[], title: string) => (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend layout the drawer does not want
    <div role="group" aria-label={title} className="flex flex-wrap gap-1.5" onKeyDown={moveFocus}>
      {tokens.map((token) => {
        const selected = value === token;
        return (
          <button
            key={token}
            type="button"
            aria-label={colorName(token)}
            aria-pressed={selected}
            title={colorName(token)}
            onClick={() => {
              onChange(token);
              setOpen(false);
            }}
            className={cx(
              'flex size-7 items-center justify-center rounded-md border transition',
              selected ? 'border-ink ring-2 ring-ink/30' : 'border-line hover:border-ink-2',
            )}
            style={{ backgroundColor: resolveColor(token, theme, 'mark') }}
          >
            {selected ? (
              <Check className="size-3.5 text-white mix-blend-difference" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`${label}: ${colorName(value) === 'Automatic' ? placeholder : colorName(value)}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink-2 transition hover:border-ink-2"
        >
          <span
            className={cx('size-4 shrink-0 rounded', !swatch && 'border border-dashed border-line-strong')}
            style={swatch ? { backgroundColor: swatch } : undefined}
          />
          <span className="truncate">{value ? colorName(value) : placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        </button>
        {value && onReset ? (
          <button type="button" onClick={onReset} className="text-xs text-muted hover:text-ink">
            Reset
          </button>
        ) : null}
      </div>
      {open ? (
        <div id={panelId} className="mt-2 space-y-2.5 rounded-lg border border-line bg-surface p-3">
          {row(ACCENTS, 'Palette colours')}
          {row(STATUS, 'Status colours')}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick a custom colour"
                value={customValid ? custom : '#2a78d6'}
                onChange={(e) => setCustom(e.target.value)}
                className="size-8 shrink-0 cursor-pointer rounded border border-line bg-transparent"
              />
              <Input
                aria-label="Custom colour (hex)"
                placeholder="Custom… #rrggbb"
                value={custom}
                maxLength={7}
                spellCheck={false}
                className="h-8 font-mono text-[13px]"
                onChange={(e) => setCustom(e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customValid) {
                    onChange(custom.toLowerCase());
                    setOpen(false);
                  }
                }}
              />
              <button
                type="button"
                disabled={!customValid}
                onClick={() => {
                  onChange(custom.toLowerCase());
                  setOpen(false);
                }}
                className="h-8 shrink-0 rounded-lg border border-line px-2.5 text-[13px] text-ink-2 hover:border-ink-2 disabled:opacity-40"
              >
                Use
              </button>
            </div>
            {note ? (
              <p className={cx('text-xs', note.poor ? 'text-bad' : 'text-muted')}>{note.text}</p>
            ) : null}
            <p className="text-xs text-muted">Named colours adapt to dark mode; custom ones do not.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
