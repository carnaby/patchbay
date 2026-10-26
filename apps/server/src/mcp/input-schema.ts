/**
 * How tool input schemas are advertised in `tools/list`.
 *
 * The SDK converts zod schemas with zod's defaults, which inline a subschema at every place it is used. In
 * apply_operations that repeated the widget union twice, the transform union three times and the sound rule nine
 * times: 43 KB, three quarters of the whole tools/list result, paid by every client on every connection. Here the
 * big shared subschemas are emitted once under `$defs` and referenced with local `$ref`s instead.
 *
 * Only the advertised JSON Schema changes. Calls are still validated by the original zod schema (its own
 * `~standard.validate`), so the server stays exactly as strict as before.
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { FormatSchema, SoundRuleSchema, SourceSchema, TransformSchema, WidgetSchema } from '@patchbay/core';
import { z } from 'zod';

type Json = Record<string, unknown>;

/** Subschemas worth sharing: large and used more than once. Small ones (ids, field names) stay inline. */
const SHARED = new Map<z.ZodType, string>([
  [SourceSchema, 'Source'],
  [TransformSchema, 'Transform'],
  [WidgetSchema, 'Widget'],
  [SoundRuleSchema, 'SoundRule'],
  [FormatSchema, 'Format'],
]);

/**
 * zod names `$defs` after an `id` in the metadata registry. Ids are added only for this conversion rather than with
 * `.meta({ id })` in core, which would change every other JSON Schema made from these schemas. Everything else
 * (descriptions) still comes from the global registry.
 */
const namingRegistry = {
  get: (schema: z.ZodType) => {
    const meta = z.globalRegistry.get(schema);
    const id = SHARED.get(schema);
    return id ? { ...meta, id } : meta;
  },
};

const connectorIdSchema = SourceSchema.options.flatMap((o) =>
  'connector' in o.shape ? [o.shape.connector] : [],
)[0];

const isObjectShaped = (s: unknown): boolean => {
  const node = s as Json | undefined;
  if (!node) return false;
  if (node.type === 'object') return true;
  const branches = (node.oneOf ?? node.anyOf) as unknown[] | undefined;
  return Array.isArray(branches) && branches.length > 0 && branches.every(isObjectShaped);
};

/**
 * Puts `type: "object"` next to every `$ref` to an object definition (and on the union definitions themselves).
 * Redundant for a validator, but some MCP clients read only `type` and never resolve `$ref`: without it they treat
 * the property as untyped, and models then tend to send the object as a JSON string.
 */
function typeRefs(root: Json): Json {
  const defs = (root.$defs ?? {}) as Record<string, Json>;
  const objectDefs = new Set(Object.keys(defs).filter((k) => isObjectShaped(defs[k])));
  for (const k of objectDefs) defs[k] = { type: 'object', ...defs[k] };
  const walk = (node: unknown): void => {
    // Arrays are walked by the same loop: Object.values of an array is its items.
    if (!node || typeof node !== 'object') return;
    const n = node as Json;
    const ref = typeof n.$ref === 'string' ? n.$ref.match(/^#\/\$defs\/(.+)$/) : null;
    if (ref && objectDefs.has(ref[1]!) && n.type === undefined) n.type = 'object';
    for (const v of Object.values(n)) walk(v);
  };
  walk(root);
  return root;
}

export interface AdvertiseOptions {
  /** Ids of the registered connectors, advertised as an enum so agents do not invent one. */
  connectorIds: readonly string[];
  /** Emit the shared subschemas once under `$defs`. Only pays off for schemas that repeat them. */
  shareDefs?: boolean;
}

/**
 * Wraps a zod schema so the SDK advertises a compact JSON Schema for it, computed once per process instead of on
 * every tools/list request.
 */
export function advertise<T extends z.ZodType>(
  schema: T,
  options: AdvertiseOptions,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const std = schema['~standard'];
  const cache = new Map<string, Json>();
  const libraryOptions = {
    ...(options.shareDefs ? { metadata: namingRegistry } : {}),
    // The connector set lives in the server, so the shared core schema keeps a plain string (stored documents that
    // name a since-removed connector must still load); only what agents are shown is narrowed.
    override: ({ zodSchema, jsonSchema }: { zodSchema: unknown; jsonSchema: Json }) => {
      if (zodSchema !== connectorIdSchema) return;
      delete jsonSchema.minLength;
      delete jsonSchema.maxLength;
      jsonSchema.enum = [...options.connectorIds];
    },
  };
  const convert =
    (io: 'input' | 'output') =>
    ({ target }: { target: string }): Json => {
      const key = `${io}:${target}`;
      let json = cache.get(key);
      if (!json) {
        json = typeRefs(std.jsonSchema[io]({ target, libraryOptions }));
        cache.set(key, json);
      }
      return json;
    };
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      validate: std.validate,
      jsonSchema: { input: convert('input'), output: convert('output') },
    },
  } as StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
