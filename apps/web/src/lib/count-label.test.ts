import { describe, expect, it } from 'vitest';
import { countLabel } from './count-label.ts';

describe('countLabel', () => {
  it('names one thing in the singular and groups the digits of larger counts', () => {
    expect(countLabel(1, 'row')).toBe('1 row');
    expect(countLabel(0, 'row')).toBe('0 rows');
    expect(countLabel(12_500, 'row')).toBe('12,500 rows');
    expect(countLabel(1, 'column')).toBe('1 column');
  });
});
