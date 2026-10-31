/**
 * Imported first by the web app, before any schema is built. Zod builds a faster parser for object schemas with
 * `new Function`, and tests whether it may while the schemas are created; under the app's Content Security Policy
 * (no 'unsafe-eval') that test is refused and the browser logs a violation on every page. Without eval Zod parses
 * the slower way, which the browser's few small documents do not notice. The server has no such policy and keeps it.
 */
import { config } from 'zod';

config({ jitless: true });
