/**
 * Who a piece of work is done for, without threading it through every call: the queues that must be fair between
 * clients (the pipeline worker, the heavy-work gate, outbound fetches) read it where they enqueue.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** "user:<id>", "ip:<address>", "live:<dashboard>" for refresh loops, or "server" outside any request. */
export function currentClient(): string {
  return storage.getStore() ?? 'server';
}

export function runAsClient<T>(client: string, fn: () => T): T {
  return storage.run(client, fn);
}
