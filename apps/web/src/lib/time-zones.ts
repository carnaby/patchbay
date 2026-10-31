/**
 * Used where `Intl.supportedValuesOf` is missing (older TV browsers), so the clock's zone picker is never empty.
 * Every entry is a valid IANA name in any browser that knows time zones at all.
 */
export const FALLBACK_TIME_ZONES = [
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Bratislava',
  'Europe/Prague',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

let zoneList: string[] | null = null;

/** The browser's time zones, computed once: the list has a few hundred entries and never changes. */
export function timeZones(): string[] {
  if (!zoneList) {
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf('timeZone');
    } catch {
      // Not supported: fall through to the built-in list.
    }
    zoneList = list.length > 0 ? list : FALLBACK_TIME_ZONES;
  }
  return zoneList;
}

export interface TimeZoneOption {
  value: string;
  label: string;
}

export interface TimeZoneGroups {
  /** Zones without a region, such as "UTC"; listed above the groups. */
  top: TimeZoneOption[];
  /** One group per region (the part before the first "/"), in alphabetical order. */
  groups: { region: string; zones: TimeZoneOption[] }[];
}

/**
 * Options for the time zone select. "UTC" is always offered (browsers leave it out of their list), and a saved zone
 * that the list does not contain (an alias, or a zone this browser does not know) is still added, so opening the
 * editor never silently drops it.
 */
export function groupTimeZones(zones: readonly string[], current?: string): TimeZoneGroups {
  const all = new Set(['UTC', ...zones]);
  if (current) all.add(current);
  const top: TimeZoneOption[] = [];
  const byRegion = new Map<string, TimeZoneOption[]>();
  for (const zone of [...all].sort()) {
    const slash = zone.indexOf('/');
    if (slash < 0) {
      top.push({ value: zone, label: zone });
      continue;
    }
    const region = zone.slice(0, slash);
    // Inside a region group the region is implied; "Argentina/La_Rioja" reads as "Argentina / La Rioja".
    const label = zone
      .slice(slash + 1)
      .replace(/_/g, ' ')
      .replace(/\//g, ' / ');
    const list = byRegion.get(region) ?? [];
    list.push({ value: zone, label });
    byRegion.set(region, list);
  }
  return { top, groups: [...byRegion].map(([region, list]) => ({ region, zones: list })) };
}
