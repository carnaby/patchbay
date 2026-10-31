import { describe, expect, it } from 'vitest';
import { FALLBACK_TIME_ZONES, groupTimeZones, timeZones } from './time-zones.ts';

describe('time zone picker options', () => {
  it('groups zones by region and labels them without the region', () => {
    const { top, groups } = groupTimeZones([
      'Europe/Vienna',
      'America/New_York',
      'Europe/Bratislava',
      'America/Argentina/La_Rioja',
    ]);
    expect(top).toEqual([{ value: 'UTC', label: 'UTC' }]);
    expect(groups).toEqual([
      {
        region: 'America',
        zones: [
          { value: 'America/Argentina/La_Rioja', label: 'Argentina / La Rioja' },
          { value: 'America/New_York', label: 'New York' },
        ],
      },
      {
        region: 'Europe',
        zones: [
          { value: 'Europe/Bratislava', label: 'Bratislava' },
          { value: 'Europe/Vienna', label: 'Vienna' },
        ],
      },
    ]);
  });

  it('keeps a saved zone the list does not know, and never lists one twice', () => {
    const kept = groupTimeZones(['Europe/Kyiv'], 'Europe/Kiev');
    expect(kept.groups[0]?.zones.map((z) => z.value)).toEqual(['Europe/Kiev', 'Europe/Kyiv']);
    const etc = groupTimeZones(['Europe/Kyiv'], 'Etc/GMT+2');
    expect(etc.groups.map((g) => g.region)).toEqual(['Etc', 'Europe']);
    expect(groupTimeZones(['UTC', 'Europe/Kyiv'], 'UTC').top).toEqual([{ value: 'UTC', label: 'UTC' }]);
  });

  it('always has zones to offer', () => {
    expect(timeZones().length).toBeGreaterThan(0);
    expect(groupTimeZones(FALLBACK_TIME_ZONES).groups.length).toBeGreaterThan(3);
  });
});
