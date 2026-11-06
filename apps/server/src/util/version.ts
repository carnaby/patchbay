import { readFileSync } from 'node:fs';

/**
 * The release, read once at start from the root package.json (the runtime image copies it), so the MCP server info
 * and the outgoing user agent follow a version bump without anyone editing them.
 */
export const APP_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Major and minor only, the form upstream operators have seen in their logs since the first release. */
export const USER_AGENT = `Patchbay/${APP_VERSION.split('.').slice(0, 2).join('.')} (+https://github.com/carnaby/patchbay)`;
