/**
 * Edit keys of anonymous dashboards created in this browser.
 * They are capabilities: whoever holds one can edit that dashboard, so they
 * live only in this browser's storage and are sent as a header, never in URLs.
 */
const STORAGE_KEY = 'pb-edit-keys';

type Entry = { key: string; title: string; createdAt: string };

function read(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Entry>;
  } catch {
    return {};
  }
}

function write(all: Record<string, Entry>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private mode); editing then lasts for this page view only.
  }
}

const memory: Record<string, string> = {};

export function getEditKey(id: string): string | undefined {
  return memory[id] ?? read()[id]?.key;
}

export function saveEditKey(id: string, key: string, title: string) {
  memory[id] = key;
  write({ ...read(), [id]: { key, title, createdAt: new Date().toISOString() } });
}

export function forgetEditKey(id: string) {
  delete memory[id];
  const all = read();
  delete all[id];
  write(all);
}

export function listEditKeys(): ({ id: string } & Entry)[] {
  return Object.entries(read()).map(([id, e]) => ({ id, ...e }));
}
