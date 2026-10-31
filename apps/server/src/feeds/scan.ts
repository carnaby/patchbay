/**
 * Linear-time text scanning for untrusted feed and page markup.
 *
 * Regexes like `<[^>]*>` or `<!--[\s\S]*?-->` look linear but are quadratic on hostile input: when a `<` has no
 * `>` after it, the engine scans to the end, gives up, moves one character on and scans to the end again. A feed of
 * a few hundred kilobytes of `<p` then blocks the event loop for minutes. Every scan here remembers what it found,
 * so each character is looked at a bounded number of times whatever the input.
 */

/**
 * `text.indexOf(needle, from)` for non-decreasing `from`. A needle that is missing after one position is missing
 * after every later one, and one found at `p` is still the first one for any `from` up to `p`; remembering both
 * turns a loop of searches into a single pass.
 */
export function finder(text: string, needle: string): (from: number) => number {
  let last = -2;
  let lastFrom = 0;
  return (from) => {
    if (last === -1 && from >= lastFrom) return -1;
    if (last >= from) return last;
    lastFrom = from;
    last = text.indexOf(needle, from);
    return last;
  };
}

/** Like `finder`, for a global regex: returns the next match at or after `from`, or null. */
function regexFinder(text: string, re: RegExp): (from: number) => RegExpExecArray | null {
  let last: RegExpExecArray | null | undefined;
  let lastFrom = 0;
  return (from) => {
    if (last === null && from >= lastFrom) return null;
    if (last && last.index >= from) return last;
    lastFrom = from;
    re.lastIndex = from;
    last = re.exec(text);
    return last;
  };
}

/**
 * `text.replace(/OPENER[^>]*>/g, by)` in linear time; `opener` must be a global regex that never matches across a
 * `>`. A match runs from the opener to the first `>` after it, exactly as `[^>]*>` does.
 */
export function replaceTags(text: string, opener: RegExp, by: string): string {
  const nextGt = finder(text, '>');
  let out = '';
  let pos = 0;
  opener.lastIndex = 0;
  for (let m = opener.exec(text); m; m = opener.exec(text)) {
    const gt = nextGt(m.index + m[0].length);
    if (gt === -1) break;
    out += text.slice(pos, m.index) + by;
    pos = gt + 1;
    opener.lastIndex = pos;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

/** Every `<link …>` tag, as `/<link\b[^>]*>/gi` would find them. */
export function* linkTags(html: string): Generator<string> {
  const opener = /<link\b/gi;
  const nextGt = finder(html, '>');
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const gt = nextGt(m.index + m[0].length);
    if (gt === -1) return;
    yield html.slice(m.index, gt + 1);
    opener.lastIndex = gt + 1;
  }
}

/** `<script>` and `<style>` elements with their content, as `/<(script|style)\b[\s\S]*?<\/\1\s*>/gi` matches them. */
function replaceScriptsAndStyles(text: string, by: string): string {
  const opener = /<(script|style)\b/gi;
  const closers = {
    script: regexFinder(text, /<\/script\s*>/gi),
    style: regexFinder(text, /<\/style\s*>/gi),
  };
  let out = '';
  let pos = 0;
  for (let m = opener.exec(text); m; m = opener.exec(text)) {
    const close = closers[m[1]!.toLowerCase() as 'script' | 'style'](m.index + m[0].length);
    // An element that never closes is left alone, as the regex leaves it: its tags go with the generic tag pass.
    if (!close) continue;
    out += text.slice(pos, m.index) + by;
    pos = close.index + close[0].length;
    opener.lastIndex = pos;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

/** Comments, as `/<!--[\s\S]*?-->/g` matches them. */
function replaceComments(text: string, by: string): string {
  const nextOpen = finder(text, '<!--');
  const nextClose = finder(text, '-->');
  let out = '';
  let pos = 0;
  for (let open = nextOpen(0); open !== -1; open = nextOpen(pos)) {
    const close = nextClose(open + 4);
    if (close === -1) break;
    out += text.slice(pos, open) + by;
    pos = close + 3;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

const BLOCK_TAG = /<\/?(br|p|div|li|h[1-6]|tr|blockquote)\b/gi;

/**
 * Markup to bare text, before entities are decoded: scripts and styles go with their content, block ends become
 * spaces, every other tag goes. The same passes, in the same order, as the regexes this replaced.
 */
export function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  return replaceTags(
    replaceTags(replaceComments(replaceScriptsAndStyles(text, ' '), ' '), BLOCK_TAG, ' '),
    /</g,
    '',
  );
}

export interface Section {
  text: string;
  cdata: boolean;
}

/**
 * Raw XML split into CDATA sections and the text between them, as `split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)` does. With
 * `openEnded`, a CDATA section that never closes runs to the end: that is what a text cut short looks like.
 */
export function cdataSections(raw: string, openEnded = false): Section[] {
  const nextOpen = finder(raw, '<![CDATA[');
  const nextClose = finder(raw, ']]>');
  const sections: Section[] = [];
  let pos = 0;
  for (let open = nextOpen(0); open !== -1; open = nextOpen(pos)) {
    const close = nextClose(open + 9);
    if (close === -1) {
      if (!openEnded) break;
      if (open > pos) sections.push({ text: raw.slice(pos, open), cdata: false });
      sections.push({ text: raw.slice(open + 9), cdata: true });
      return sections;
    }
    if (open > pos) sections.push({ text: raw.slice(pos, open), cdata: false });
    sections.push({ text: raw.slice(open + 9, close), cdata: true });
    pos = close + 3;
  }
  if (pos < raw.length) sections.push({ text: raw.slice(pos), cdata: false });
  return sections;
}

/**
 * Counts each `<` from which a quote-aware scan finds no closing `>`, the way fast-xml-parser reads a tag. Inside a
 * text element it keeps for raw markup (a "stop node"), the parser rescans to the end of the document from every
 * such `<`, which is quadratic. Well-formed XML has none: every `<` outside CDATA and comments opens markup that
 * closes. Computed backwards in one pass: for each position, whether a `>` is reachable outside, inside a double
 * and inside a single quote.
 */
export function unclosedTagStarts(xml: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let plain = false;
  let inDouble = false;
  let inSingle = false;
  let count = 0;
  for (let i = xml.length - 1; i >= 0; i--) {
    const c = xml.charCodeAt(i);
    if (c === 62 /* > */) {
      plain = true;
    } else if (c === 34 /* " */) {
      const was: boolean = plain;
      plain = inDouble;
      inDouble = was;
    } else if (c === 39 /* ' */) {
      const was: boolean = plain;
      plain = inSingle;
      inSingle = was;
    } else if (c === 60 /* < */ && !plain) {
      // `plain` still describes the scan that starts right after this `<`.
      if (++count >= stopAfter) return count;
    }
  }
  return count;
}

/**
 * Whether a document declares entities in a DTD, as `/<!DOCTYPE[^>]*\[[\s\S]*?<!ENTITY/i` decides: a DOCTYPE whose
 * internal subset `[` opens before its `>`, followed anywhere by `<!ENTITY`.
 */
export function declaresEntities(xml: string): boolean {
  const doctype = /<!DOCTYPE/gi;
  const nextGt = finder(xml, '>');
  const nextBracket = finder(xml, '[');
  const nextEntity = regexFinder(xml, /<!ENTITY/gi);
  for (let m = doctype.exec(xml); m; m = doctype.exec(xml)) {
    const from = m.index + m[0].length;
    const bracket = nextBracket(from);
    if (bracket === -1) return false;
    const gt = nextGt(from);
    if (gt !== -1 && gt < bracket) continue;
    return nextEntity(bracket + 1) !== null;
  }
  return false;
}

const HTML_START = /<(!doctype\s+html|html)\b/iy;
const SPACE = /\s*/y;

/**
 * Whether a text begins like an HTML page, as `/^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html)\b/i` decides. That
 * regex backtracks exponentially over a run of comments; it is equivalent to: optional comments, then the page
 * start right after some `-->` (one lazy group can swallow everything up to any `-->`).
 */
export function startsLikeHtml(text: string): boolean {
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.test(text);
  };
  const skipSpace = (i: number) => {
    SPACE.lastIndex = i;
    SPACE.test(text);
    return SPACE.lastIndex;
  };
  const start = skipSpace(0);
  if (at(HTML_START, start)) return true;
  if (!text.startsWith('<!--', start)) return false;
  for (let close = text.indexOf('-->', start + 4); close !== -1; close = text.indexOf('-->', close + 1)) {
    if (at(HTML_START, skipSpace(close + 3))) return true;
  }
  return false;
}
