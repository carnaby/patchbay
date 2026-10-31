import { describe, expect, it } from 'vitest';
import { retentionSentences } from './retention.ts';

describe('retentionSentences', () => {
  it('states the configured limits with the right units', () => {
    expect(retentionSentences(30, 0)).toEqual([
      'Anonymous dashboards that nobody has opened for 30 days are deleted automatically.',
    ]);
    expect(retentionSentences(1, 1)).toEqual([
      'Anonymous dashboards that nobody has opened for 1 day are deleted automatically.',
      'Anonymous dashboards that were never edited are deleted 1 hour after they were created.',
    ]);
  });

  it('does not promise deletion when the instance has no limits', () => {
    const [only, ...rest] = retentionSentences(0, 0);
    expect(rest).toEqual([]);
    expect(only).toContain('does not delete anonymous dashboards automatically');
  });
});
