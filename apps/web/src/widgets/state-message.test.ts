import { describe, expect, it } from 'vitest';
import { stateClasses } from './state-message.ts';

describe('stateClasses', () => {
  it('keeps the state texts exactly as they are outside a presentation', () => {
    expect(stateClasses('waiting', false)).toEqual({
      box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted',
      text: 'line-clamp-3',
      icon: 'size-5',
      hint: '',
    });
    expect(stateClasses('empty', false)).toEqual({
      box: 'flex h-full items-center justify-center',
      text: 'text-sm text-muted',
      icon: '',
      hint: '',
    });
    expect(stateClasses('error', false)).toEqual({
      box: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-bad',
      text: 'line-clamp-3',
      icon: 'size-5',
      hint: 'line-clamp-3 text-xs text-ink-2',
    });
  });

  it('scales them with the widget while presenting, between 14 and 24 px', () => {
    for (const kind of ['waiting', 'empty', 'error'] as const) {
      const c = stateClasses(kind, true);
      expect(c.box).toContain('@container');
      expect(c.box).not.toContain('text-sm');
      expect(c.text).toContain('clamp(14px,');
    }
  });
});
