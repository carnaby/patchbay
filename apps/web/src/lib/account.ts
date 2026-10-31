/** Pure rules for deleting an account, kept apart from React so they can be unit-tested. */

/** Where the browser lands after the account is gone; the landing page reads it to show a confirmation. */
export const ACCOUNT_DELETED_URL = '/?account=deleted';

/** The server compares the same way: case does not matter, stray spaces from a paste do not count. */
export function emailMatches(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.toLowerCase();
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the user is about to lose, as short phrases for the warning; zero counts are left out. */
export function erasureItems(counts: {
  dashboards: number;
  secrets: number;
  tokens: number;
  connectedApps: number;
}): string[] {
  const items: string[] = [];
  if (counts.dashboards) items.push(plural(counts.dashboards, 'dashboard', 'dashboards'));
  if (counts.secrets) items.push(plural(counts.secrets, 'secret', 'secrets'));
  if (counts.tokens) items.push(plural(counts.tokens, 'personal access token', 'personal access tokens'));
  if (counts.connectedApps) items.push(plural(counts.connectedApps, 'connected app', 'connected apps'));
  return items;
}
