import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_VERSION } from './version.ts';

it('reads the release from the root package.json, which the runtime image ships', () => {
  const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
  expect(root.name).toBe('patchbay');
  expect(APP_VERSION).toBe(root.version);
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
