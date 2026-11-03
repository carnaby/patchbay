import { describe, expect, it } from 'vitest';
import { columnsAfter, repickJoinKeys, switchJoinDataset } from './columns.ts';

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

describe('join key helpers', () => {
  const join = (on: Parameters<typeof repickJoinKeys>[0]['on'], extra = {}) => ({
    type: 'join' as const,
    with: 'a',
    on,
    ...extra,
  });

  it('switching dataset drops the column list and the other side of the keys', () => {
    const next = switchJoinDataset(
      join([{ left: 'id', right: 'code' }], { fields: ['x'], how: 'inner' as const }),
      'b',
    );
    expect(next).toEqual({ type: 'join', with: 'b', on: ['id'], how: 'inner' });
  });

  it('re-picks an untouched default once the other columns are known', () => {
    expect(repickJoinKeys(join(['id']), ['id', 'n'], ['country', 'n'])).toEqual(
      join([{ left: 'n', right: 'n' }].map(() => 'n')),
    );
    expect(repickJoinKeys(join(['id']), ['id', 'n'], ['zip', 'q'])).toEqual(
      join([{ left: 'id', right: 'zip' }]),
    );
  });

  it('keeps keys that exist on both sides and does nothing while columns are unknown', () => {
    const s = join([{ left: 'id', right: 'code' }]);
    expect(repickJoinKeys(s, ['id'], ['code', 'x'])).toBe(s);
    expect(repickJoinKeys(s, ['id'], [])).toBe(s);
  });
});
