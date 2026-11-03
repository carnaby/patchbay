import { parse } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { PRESETS, presetColumnName, presetExpression } from './step-presets.ts';

describe('derive presets', () => {
  it('writes share and difference expressions, optionally per group', () => {
    expect(presetExpression('share', 'sales')).toBe('round(sales / col_sum(sales) * 100, 1)');
    expect(presetExpression('share', 'sales', 'region')).toBe(
      'round(sales / col_sum(sales, region) * 100, 1)',
    );
    expect(presetExpression('difference', 'temp', 'city')).toBe('temp - col_avg(temp, city)');
    expect(presetExpression('difference', 'wind speed')).toBe('`wind speed` - col_avg(`wind speed`)');
    for (const e of [presetExpression('share', 'wind speed', 'city'), presetExpression('difference', 'x')])
      expect(() => parse(e)).not.toThrow();
  });

  it('names the new column and explains which rows count', () => {
    expect(presetColumnName('share', 'sales')).toBe('share_sales');
    expect(presetColumnName('difference', 'temp')).toBe('diff_temp');
    expect(PRESETS.share.help).toMatch(/of the rows at this point in the pipeline$/);
  });
});
