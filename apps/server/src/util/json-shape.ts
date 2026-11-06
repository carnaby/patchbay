/**
 * The JSON shape scan lives in core, because the document schema measures POST bodies with it. Re-exported here so the
 * server's request guard, uploads and safe-fetch keep importing it from where they always did.
 */
export type { JsonShapeLimits, JsonShapeProblem } from '@patchbay/core';
export { jsonShapeProblem, MAX_JSON_DEPTH } from '@patchbay/core';
