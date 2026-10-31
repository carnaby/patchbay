import { describe, expect, it, vi } from 'vitest';
import { checkHeapLimit, textFromWorkerBytes, workerBytes } from './workers.ts';

describe('worker helpers', () => {
  it('moves text through bytes unchanged, byte order mark and all', () => {
    for (const text of ['﻿a,b\n1,2', 'žluťoučký kůň 🐎', '']) {
      expect(textFromWorkerBytes(workerBytes(text))).toBe(text);
    }
  });

  it('warns once when a heap size flag overrides the worker limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      checkHeapLimit('test-ok', 64, 76);
      checkHeapLimit('test-ok', 64, undefined);
      expect(warn).not.toHaveBeenCalled();
      checkHeapLimit('test-flag', 64, 146);
      checkHeapLimit('test-flag', 64, 146);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('--max-old-space-size');
    } finally {
      warn.mockRestore();
    }
  });
});
