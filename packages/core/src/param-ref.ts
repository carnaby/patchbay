/**
 * The text form of a filter reference (proposal 0010): `$param.<id>`, or `$param.<id>.<part>` for a date range.
 * Shared by the expression parser and the checks of URLs, bodies and connector parameters, so every place reads a
 * reference the same way. No imports: both `expr.ts` and `parameters.ts` depend on it, and neither on the other.
 */
export const PARAM_PREFIX = '$param.';

/** A whole value that is nothing but a reference: the class decides where one ends, for the checks and the binder. */
export const WHOLE_REF = /^\$param\.[A-Za-z0-9_.]*$/;

/** Ids have no "-", unlike dataset ids: the expression tokenizer would read `$param.top-n` as `$param.top` minus n. */
export const PARAM_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** `.from`/`.to`: first and last day as YYYY-MM-DD; `.start`/`.end`: epoch ms, the end exclusive. */
export const PARAM_PARTS = ['from', 'to', 'start', 'end'] as const;
export type ParamPart = (typeof PARAM_PARTS)[number];

export interface RefName {
  id: string;
  part: ParamPart | null;
}

/** Reads a reference; null when `text` does not start like one, a problem when it starts like one but is not. */
export function readRef(text: string): RefName | { problem: string } | null {
  if (!text.startsWith(PARAM_PREFIX)) return null;
  const [id = '', ...parts] = text.slice(PARAM_PREFIX.length).split('.');
  if (!PARAM_ID.test(id)) {
    return {
      problem: `"${text}" is not a filter reference: filter ids are 1-32 chars of a-z, 0-9 or "_", starting with a letter`,
    };
  }
  if (parts.length > 1 || (parts.length === 1 && !(PARAM_PARTS as readonly string[]).includes(parts[0]!))) {
    return {
      problem: `"${text}" is not a filter reference: a filter has no part "${parts.join('.')}"; date ranges have .from, .to, .start and .end`,
    };
  }
  return { id, part: (parts[0] as ParamPart | undefined) ?? null };
}
