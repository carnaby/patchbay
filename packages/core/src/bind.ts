/**
 * Binding (proposal 0010): every `$param` reference of a dataset replaced by its value before anything is resolved.
 * Nothing downstream ever sees a reference. After binding a dataset is an ordinary one, so every cache keyed by its
 * definition (HTTP responses, connector results, pipeline and final results) gives each view an entry of its own
 * without a key built by hand, and a dataset without references comes back as the same object with its one entry.
 */
import { ExprError, MAX_BOUND_EXPRESSION, paramSpans, parse } from './expr.ts';
import { PARAM_PREFIX, type RefName, readRef } from './param-ref.ts';
import { type DateRange, type ParameterValue, type ParameterValues, splitUrl } from './parameters.ts';
import type { DashboardDoc, Dataset, Source } from './schema.ts';

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

const WHOLE_REF = /^\$param\.[A-Za-z0-9_.]*$/;

/** The reference a value consists of, or null. Validation refused every other shape; this only re-checks. */
function refIn(text: string): RefName | null {
  if (!WHOLE_REF.test(text)) {
    if (text.includes(PARAM_PREFIX))
      throw new BindError(`"${text.slice(0, 60)}" puts a filter inside a longer text`);
    return null;
  }
  const ref = readRef(text)!;
  if ('problem' in ref) throw new BindError(ref.problem);
  return ref;
}

function valueFor(values: ParameterValues, ref: RefName): string | number | null {
  // Own keys only: "constructor" is a valid filter id, and Object's own members are no values.
  if (!Object.hasOwn(values, ref.id)) throw new BindError(`Unknown filter "${ref.id}"`);
  const value = values[ref.id] as ParameterValue;
  if (value !== null && typeof value === 'object') {
    if (!ref.part) throw new BindError(`Filter "${ref.id}" is a date range: use .from, .to, .start or .end`);
    return (value as DateRange)[ref.part];
  }
  if (ref.part) throw new BindError(`Filter "${ref.id}" has no part .${ref.part}`);
  return value;
}

/** A value as an expression literal. Negative numbers are parenthesised, so `$param.n ^ 2` keeps its meaning. */
function literal(value: string | number | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return value < 0 ? `(${value})` : String(value);
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * Replaces the references at the positions the tokenizer reports, by literal tokens: a value `" || true || "` is one
 * string literal, so no value can change the expression's structure.
 */
export function bindExpression(src: string, values: ParameterValues): string {
  if (!src.includes(PARAM_PREFIX)) return src;
  let spans: ReturnType<typeof paramSpans>;
  try {
    spans = paramSpans(src);
    // The tokenizer also reports references the parser refuses (`$param.a.b.c`, a reference called like a function):
    // only a template that parses is safe to fill span by span.
    if (spans.length > 0) parse(src, { maxLength: MAX_BOUND_EXPRESSION });
  } catch (e) {
    throw new BindError(e instanceof ExprError ? e.message : 'Invalid expression');
  }
  if (spans.length === 0) return src;
  let out = '';
  let at = 0;
  for (const span of spans) {
    const ref = readRef(span.text);
    if (!ref || 'problem' in ref)
      throw new BindError(ref ? ref.problem : `"${span.text}" is not a filter reference`);
    out += src.slice(at, span.start) + literal(valueFor(values, ref));
    at = span.end;
  }
  out += src.slice(at);
  if (out.length > MAX_BOUND_EXPRESSION)
    throw new BindError(
      `The filter values make this expression longer than ${MAX_BOUND_EXPRESSION.toLocaleString('en-US')} characters`,
    );
  return out;
}

/**
 * A value as one percent-encoded segment or query value. A lone surrogate (a select option may hold one) makes
 * encodeURIComponent throw a URIError; as a BindError it fails only its own dataset, not the whole document.
 */
function encode(text: string, ref: RefName): string {
  try {
    return encodeURIComponent(text);
  } catch (e) {
    if (e instanceof URIError)
      throw new BindError(`Filter "${ref.id}" has a value that cannot be part of an address`);
    throw e;
  }
}

/**
 * Fills whole path segments and whole query values, percent-encoded; every other byte stays as saved. The address's
 * scheme, host and port never hold a reference (validation), and the bound URL must keep the template's origin.
 */
export function bindUrl(url: string, values: ParameterValues): string {
  if (!url.includes(PARAM_PREFIX)) return url;
  const { authority, path, query, fragment } = splitUrl(url);
  if (authority.includes(PARAM_PREFIX) || fragment.includes(PARAM_PREFIX))
    throw new BindError(
      'Filters cannot be part of the scheme, host, port, user name or fragment of an address',
    );
  const segments = path.split('/').map((segment) => {
    const ref = refIn(segment);
    if (!ref) return segment;
    const value = valueFor(values, ref);
    const text = value === null ? '' : String(value);
    // Encoded, a value can add no "/" or "?"; these three would still empty the segment or climb out of it.
    if (text === '' || text === '.' || text === '..')
      throw new BindError(`Filter "${ref.id}" cannot be used as a path segment with the value "${text}"`);
    return encode(text, ref);
  });
  let bound = authority + segments.join('/');
  if (query !== null) {
    const pairs = query.split('&').flatMap((pair) => {
      const eq = pair.indexOf('=');
      if ((eq < 0 ? pair : pair.slice(0, eq)).includes(PARAM_PREFIX))
        throw new BindError('A query parameter name cannot be a filter');
      if (eq < 0) return [pair];
      const ref = refIn(pair.slice(eq + 1));
      if (!ref) return [pair];
      const value = valueFor(values, ref);
      // "All" means no filter, which to most APIs is the parameter left out.
      return value === null ? [] : [`${pair.slice(0, eq + 1)}${encode(String(value), ref)}`];
    });
    if (pairs.length > 0) bound += `?${pairs.join('&')}`;
  }
  bound += fragment;
  if (new URL(bound).origin !== new URL(url).origin)
    throw new BindError('A filter value changed the address');
  return bound;
}

/** A body or connector value: a string that is exactly a reference becomes the typed value. */
function bindJson(value: unknown, values: ParameterValues): unknown {
  if (typeof value === 'string') {
    const ref = refIn(value);
    return ref ? valueFor(values, ref) : value;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => bindJson(v, values));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.some(([key]) => key.includes(PARAM_PREFIX))) throw new BindError('A key cannot be a filter');
    const bound = entries.map(([key, v]) => [key, bindJson(v, values)] as const);
    // fromEntries, not assignment: a "__proto__" key of a JSON body stays an ordinary key.
    return bound.some(([, v], i) => v !== entries[i]![1]) ? Object.fromEntries(bound) : value;
  }
  return value;
}

function bindSource(source: Source, values: ParameterValues): Source {
  switch (source.kind) {
    case 'http': {
      const url = bindUrl(source.url, values);
      const body = source.body === undefined ? undefined : bindJson(source.body, values);
      if (url === source.url && body === source.body) return source;
      return { ...source, url, ...(body === undefined ? {} : { body }) };
    }
    case 'feed': {
      const url = bindUrl(source.url, values);
      return url === source.url ? source : { ...source, url };
    }
    case 'connector': {
      const entries = Object.entries(source.params).map(([key, v]) => [key, v, bindJson(v, values)] as const);
      if (entries.every(([, v, b]) => v === b)) return source;
      // A connector takes no null: "All" leaves the parameter out, so the connector's own default applies.
      const params = Object.fromEntries(
        entries.filter(([, v, b]) => !(b === null && v !== null)).map(([k, , b]) => [k, b]),
      );
      return { ...source, params };
    }
    default:
      return source;
  }
}

export function bindDataset<D extends Pick<Dataset, 'source' | 'transforms'>>(
  dataset: D,
  values: ParameterValues,
): D {
  const source = bindSource(dataset.source, values);
  let changed = source !== dataset.source;
  const transforms = dataset.transforms.map((t) => {
    if (t.type !== 'filter' && t.type !== 'derive') return t;
    const expr = bindExpression(t.expr, values);
    if (expr === t.expr) return t;
    changed = true;
    return { ...t, expr };
  });
  return changed ? ({ ...dataset, source, transforms } as D) : dataset;
}

/**
 * Binds every dataset of a document. A dataset whose values cannot be bound keeps its template and is named in
 * `errors`: the scope answers it (and what reads it) with the message, and the other datasets of the request load.
 */
export function bindDoc(
  doc: DashboardDoc,
  values: ParameterValues,
): { doc: DashboardDoc; errors: ReadonlyMap<string, string> } {
  const errors = new Map<string, string>();
  let changed = false;
  const datasets = doc.datasets.map((d) => {
    try {
      const bound = bindDataset(d, values);
      if (bound !== d) changed = true;
      return bound;
    } catch (e) {
      if (!(e instanceof BindError)) throw e;
      errors.set(d.id, e.message);
      return d;
    }
  });
  return { doc: changed ? { ...doc, datasets } : doc, errors };
}
