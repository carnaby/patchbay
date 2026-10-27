/** Test helpers for connectors: no network, recorded upstream shapes only. */
import type { DataTable } from '@patchbay/core';
import type { ConnectorContext } from './types.ts';

/** A fake upstream: answers by URL prefix, records what was asked. */
export function upstream(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const ctx: ConnectorContext = {
    fetchJson: async <T>(url: string) => {
      urls.push(url);
      const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
      if (!hit) throw new Error(`Unexpected request ${url}`);
      return routes[hit] as T;
    },
  };
  return { ctx, urls };
}

export const column = (table: DataTable, name: string) => table.rows.map((r) => r[name]);
