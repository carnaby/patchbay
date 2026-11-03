import { describe, expect, it } from 'vitest';
import { columnsAfter } from './columns.ts';

describe('columnsAfter', () => {
  it('adds what a join brings, suffixing clashes like the server does', () => {
    const of = (id: string) => (id === 'c' ? ['country', 'region', 'total'] : []);
    expect(
      columnsAfter(['id', 'country', 'total'], [{ type: 'join', with: 'c', on: ['country'] }], of),
    ).toEqual(['id', 'country', 'total', 'region', 'total_c']);
  });

  it('merges union columns, then the origin, and keeps working after it', () => {
    expect(
      columnsAfter(
        ['time', 'temp'],
        [
          { type: 'union', with: ['b'], origin: 'city' },
          { type: 'derive', as: 'f', expr: '1' },
        ],
        () => ['time', 'temp', 'wind'],
      ),
    ).toEqual(['time', 'temp', 'wind', 'city', 'f']);
  });

  it('still handles the existing steps without other datasets', () => {
    expect(
      columnsAfter(
        ['a'],
        [
          { type: 'derive', as: 'b', expr: '1' },
          { type: 'select', fields: ['b'] },
        ],
      ),
    ).toEqual(['b']);
  });
});
