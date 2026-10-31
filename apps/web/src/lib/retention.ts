/**
 * How this instance treats anonymous dashboards, in sentences for the privacy page. The numbers come from the
 * operator's settings (/auth/config), so the page never promises a deletion the instance does not do.
 */
export function retentionSentences(days: number, blankHours: number): string[] {
  const out: string[] = [];
  if (days > 0) {
    out.push(
      `Anonymous dashboards that nobody has opened for ${plural(days, 'day')} are deleted automatically.`,
    );
  }
  if (blankHours > 0) {
    out.push(
      `Anonymous dashboards that were never edited are deleted ${plural(blankHours, 'hour')} after they were created.`,
    );
  }
  if (out.length === 0) {
    out.push(
      'This instance does not delete anonymous dashboards automatically, but its operator may remove them at any time.',
    );
  }
  return out;
}

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
