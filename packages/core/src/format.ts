import type { Format } from './schema.ts';
import type { ColumnType, Scalar } from './table.ts';

export function formatNumber(value: number | null | undefined, format?: Format): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const style = format?.style ?? 'number';
  const decimals = format?.decimals;
  let text: string;
  switch (style) {
    case 'compact':
      text = new Intl.NumberFormat('en', {
        notation: 'compact',
        maximumFractionDigits: decimals ?? 1,
      }).format(value);
      break;
    case 'percent':
      text = new Intl.NumberFormat('en', {
        style: 'percent',
        maximumFractionDigits: decimals ?? 1,
      }).format(value / 100);
      break;
    case 'currency':
      text = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: format?.currency ?? 'USD',
        maximumFractionDigits: decimals ?? 2,
        minimumFractionDigits: decimals ?? (Math.abs(value) >= 1000 ? 0 : 2),
      }).format(value);
      break;
    default: {
      const auto = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 4;
      text = new Intl.NumberFormat('en', {
        maximumFractionDigits: decimals ?? auto,
        minimumFractionDigits: decimals ?? 0,
      }).format(value);
    }
  }
  return `${format?.prefix ?? ''}${text}${format?.suffix ?? ''}`;
}

const TIME_FORMAT = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  hour12: false,
});
const DATE_FORMAT = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  return midnight ? DATE_FORMAT.format(d) : `${TIME_FORMAT.format(d)} UTC`;
}

export function formatValue(value: Scalar, type: ColumnType | undefined, format?: Format): string {
  if (value === null || value === undefined) return '-';
  if (type === 'time' && typeof value === 'number') return formatTime(value);
  if (typeof value === 'number') return formatNumber(value, format);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return value;
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "12 minutes ago", "yesterday", "in 2 hours": for list-style tables, where the exact time is the tooltip. */
export function formatRelative(ms: number, now: number, locale = 'en'): string {
  const diff = ms - now;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });
  }
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, 'minute');
}
