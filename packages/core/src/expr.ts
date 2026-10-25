/**
 * A tiny, sandboxed expression language for filters and derived columns.
 *
 * It is parsed into an AST and interpreted - never `eval`-ed - so an AI agent
 * (or a user) can write `price * qty > 100 && lower(region) == "eu"` without
 * being able to reach globals, prototypes or the network. There are no loops
 * and the AST size is capped, so evaluation time is bounded.
 */
import type { Row, Scalar } from './table.ts';

export type Node =
  | { k: 'lit'; v: Scalar }
  | { k: 'field'; name: string }
  | { k: 'unary'; op: '-' | '!'; arg: Node }
  | { k: 'binary'; op: string; left: Node; right: Node }
  | { k: 'cond'; test: Node; then: Node; else: Node }
  | { k: 'call'; fn: string; args: Node[] };

export class ExprError extends Error {
  readonly position: number | undefined;
  constructor(message: string, position?: number) {
    super(position === undefined ? message : `${message} (at ${position})`);
    this.name = 'ExprError';
    this.position = position;
  }
}

const MAX_LENGTH = 2000;
const MAX_NODES = 400;
/** Strings produced by expressions are capped so repeated derive steps cannot grow memory exponentially. */
export const MAX_STRING = 10_000;

function capped(text: string): string {
  if (text.length > MAX_STRING)
    throw new ExprError(`Text values are limited to ${MAX_STRING.toLocaleString('en')} characters`);
  return text;
}

type Token =
  | { t: 'num'; v: number; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'field'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'eof'; p: number };

const OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const next = src[j + 1]!;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else out += src[j++];
      }
      if (j >= src.length) throw new ExprError('Unterminated string', i);
      // Backticks quote field names that are not valid identifiers: `wind speed`.
      tokens.push(c === '`' ? { t: 'field', v: out, p: i } : { t: 'str', v: out, p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(src.slice(i))!;
      tokens.push({ t: 'id', v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ t: 'op', v: op, p: i });
      i += op.length;
      continue;
    }
    if (src.startsWith('=', i)) throw new ExprError('Use == for comparison', i);
    throw new ExprError(`Unexpected character "${c}"`, i);
  }
  tokens.push({ t: 'eof', p: src.length });
  return tokens;
}

const KEYWORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' };

/** Binding power of infix operators; higher binds tighter. */
const INFIX: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 8,
};

export function parse(src: string): Node {
  if (src.length > MAX_LENGTH) throw new ExprError(`Expression longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(src).map((tok) =>
    tok.t === 'id' && Object.hasOwn(KEYWORD_OPS, tok.v)
      ? ({ t: 'op', v: KEYWORD_OPS[tok.v]!, p: tok.p } as Token)
      : tok,
  );
  let pos = 0;
  let nodes = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const node = <T extends Node>(n: T): T => {
    if (++nodes > MAX_NODES) throw new ExprError('Expression is too complex');
    return n;
  };
  const expectOp = (v: string) => {
    const tok = next();
    if (tok.t !== 'op' || tok.v !== v) throw new ExprError(`Expected "${v}"`, tok.p);
  };

  const prefix = (): Node => {
    const tok = next();
    switch (tok.t) {
      case 'num':
        return node({ k: 'lit', v: tok.v });
      case 'str':
        return node({ k: 'lit', v: tok.v });
      case 'field':
        return node({ k: 'field', name: tok.v });
      case 'id': {
        if (tok.v === 'true' || tok.v === 'false') return node({ k: 'lit', v: tok.v === 'true' });
        if (tok.v === 'null') return node({ k: 'lit', v: null });
        const after = peek();
        if (after.t === 'op' && after.v === '(') {
          next();
          const fn = tok.v;
          if (!Object.hasOwn(FUNCTIONS, fn)) throw new ExprError(`Unknown function "${fn}"`, tok.p);
          const args: Node[] = [];
          const close = peek();
          if (!(close.t === 'op' && close.v === ')')) {
            do args.push(expression(0));
            while (peek().t === 'op' && (peek() as { v: string }).v === ',' && next());
          }
          expectOp(')');
          return node({ k: 'call', fn, args });
        }
        return node({ k: 'field', name: tok.v });
      }
      case 'op':
        if (tok.v === '(') {
          const inner = expression(0);
          expectOp(')');
          return inner;
        }
        if (tok.v === '-' || tok.v === '!') return node({ k: 'unary', op: tok.v, arg: expression(7) });
        throw new ExprError(`Unexpected "${tok.v}"`, tok.p);
      default:
        throw new ExprError('Unexpected end of expression', tok.p);
    }
  };

  const expression = (minPower: number): Node => {
    let left = prefix();
    for (;;) {
      const tok = peek();
      if (tok.t !== 'op') break;
      if (tok.v === '?' && minPower === 0) {
        next();
        const then = expression(0);
        expectOp(':');
        const otherwise = expression(0);
        left = node({ k: 'cond', test: left, then, else: otherwise });
        continue;
      }
      const power = INFIX[tok.v];
      if (power === undefined || power <= minPower) break;
      next();
      // `^` is right-associative, everything else is left-associative.
      const right = expression(tok.v === '^' ? power - 1 : power);
      left = node({ k: 'binary', op: tok.v, left, right });
    }
    return left;
  };

  const ast = expression(0);
  const rest = peek();
  if (rest.t !== 'eof') throw new ExprError('Unexpected trailing input', rest.p);
  return ast;
}

/** Field names an expression reads; used to validate against a table's columns. */
export function referencedFields(ast: Node, out = new Set<string>()): Set<string> {
  switch (ast.k) {
    case 'field':
      out.add(ast.name);
      break;
    case 'unary':
      referencedFields(ast.arg, out);
      break;
    case 'binary':
      referencedFields(ast.left, out);
      referencedFields(ast.right, out);
      break;
    case 'cond':
      referencedFields(ast.test, out);
      referencedFields(ast.then, out);
      referencedFields(ast.else, out);
      break;
    case 'call':
      for (const a of ast.args) referencedFields(a, out);
      break;
  }
  return out;
}

const num = (v: Scalar): number | null => {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};
const str = (v: Scalar): string => (v === null ? '' : String(v));
const truthy = (v: Scalar) => v !== null && v !== false && v !== 0 && v !== '';
const math =
  (fn: (...n: number[]) => number) =>
  (...args: Scalar[]): Scalar => {
    const ns = args.map(num);
    if (ns.some((n) => n === null)) return null;
    const r = fn(...(ns as number[]));
    return Number.isFinite(r) ? r : null;
  };
const dateOf = (v: Scalar): Date | null => {
  const n = typeof v === 'string' ? Date.parse(v) : num(v);
  return n === null || Number.isNaN(n) ? null : new Date(n);
};
const datePart = (fn: (d: Date) => number) => (v: Scalar) => {
  const d = dateOf(v);
  return d ? fn(d) : null;
};

/** The complete, whitelisted function library. All date parts are UTC. */
export const FUNCTIONS: Record<string, { args: string; doc: string; fn: (...a: Scalar[]) => Scalar }> = {
  abs: { args: 'x', doc: 'Absolute value', fn: math(Math.abs) },
  round: {
    args: 'x, digits?',
    doc: 'Round to digits (default 0)',
    fn: (x, d = 0) => {
      const n = num(x);
      const p = 10 ** (num(d) ?? 0);
      return n === null ? null : Math.round(n * p) / p;
    },
  },
  floor: { args: 'x', doc: 'Round down', fn: math(Math.floor) },
  ceil: { args: 'x', doc: 'Round up', fn: math(Math.ceil) },
  sqrt: { args: 'x', doc: 'Square root', fn: math(Math.sqrt) },
  pow: { args: 'x, y', doc: 'x to the power y', fn: math(Math.pow) },
  log: { args: 'x', doc: 'Natural logarithm', fn: math(Math.log) },
  log10: { args: 'x', doc: 'Base-10 logarithm', fn: math(Math.log10) },
  exp: { args: 'x', doc: 'e^x', fn: math(Math.exp) },
  min: { args: 'a, b, ...', doc: 'Smallest argument', fn: math(Math.min) },
  max: { args: 'a, b, ...', doc: 'Largest argument', fn: math(Math.max) },
  clamp: {
    args: 'x, lo, hi',
    doc: 'Limit x to [lo, hi]',
    fn: math((x, lo, hi) => Math.min(Math.max(x, lo), hi)),
  },
  if: {
    args: 'cond, a, b',
    doc: 'a when cond is truthy, else b',
    fn: (c, a = null, b = null) => (truthy(c) ? a : b),
  },
  coalesce: {
    args: 'a, b, ...',
    doc: 'First non-null argument',
    fn: (...a) => a.find((v) => v !== null) ?? null,
  },
  isNull: { args: 'x', doc: 'True when x is null', fn: (x) => x === null },
  number: { args: 'x', doc: 'Convert to number', fn: (x) => num(x) },
  string: { args: 'x', doc: 'Convert to string', fn: (x) => (x === null ? null : String(x)) },
  lower: { args: 's', doc: 'Lowercase', fn: (s) => (s === null ? null : str(s).toLowerCase()) },
  upper: { args: 's', doc: 'Uppercase', fn: (s) => (s === null ? null : str(s).toUpperCase()) },
  trim: { args: 's', doc: 'Strip whitespace', fn: (s) => (s === null ? null : str(s).trim()) },
  len: { args: 's', doc: 'String length', fn: (s) => (s === null ? null : str(s).length) },
  concat: { args: 'a, b, ...', doc: 'Join as strings', fn: (...a) => capped(a.map(str).join('')) },
  substr: {
    args: 's, start, length?',
    doc: 'Substring',
    fn: (s, start, length = null) =>
      s === null
        ? null
        : str(s).substr(num(start) ?? 0, length === null ? undefined : (num(length) ?? undefined)),
  },
  contains: {
    args: 's, part',
    doc: 'Case-insensitive substring test',
    fn: (s, p) => str(s).toLowerCase().includes(str(p).toLowerCase()),
  },
  startsWith: { args: 's, prefix', doc: 'Prefix test', fn: (s, p) => str(s).startsWith(str(p)) },
  endsWith: { args: 's, suffix', doc: 'Suffix test', fn: (s, p) => str(s).endsWith(str(p)) },
  now: { args: '', doc: 'Current time (epoch ms)', fn: () => Date.now() },
  date: { args: 's', doc: 'Parse a date string to epoch ms', fn: (s) => dateOf(s)?.getTime() ?? null },
  year: { args: 't', doc: 'UTC year', fn: datePart((d) => d.getUTCFullYear()) },
  month: { args: 't', doc: 'UTC month 1-12', fn: datePart((d) => d.getUTCMonth() + 1) },
  day: { args: 't', doc: 'UTC day of month', fn: datePart((d) => d.getUTCDate()) },
  hour: { args: 't', doc: 'UTC hour', fn: datePart((d) => d.getUTCHours()) },
  weekday: { args: 't', doc: 'UTC weekday, 1 = Monday', fn: datePart((d) => ((d.getUTCDay() + 6) % 7) + 1) },
  daysAgo: {
    args: 'n',
    doc: 'Epoch ms of now minus n days',
    fn: (n) => {
      const d = num(n);
      return d === null ? null : Date.now() - d * 86_400_000;
    },
  },
};

function compare(op: string, a: Scalar, b: Scalar): boolean {
  if (op === '==') return a === b || (a !== null && b !== null && num(a) !== null && num(a) === num(b));
  if (op === '!=') return !compare('==', a, b);
  if (a === null || b === null) return false;
  const na = num(a);
  const nb = num(b);
  const [x, y] = na !== null && nb !== null ? [na, nb] : [str(a), str(b)];
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

export function evaluate(ast: Node, row: Row): Scalar {
  switch (ast.k) {
    case 'lit':
      return ast.v;
    case 'field':
      return Object.hasOwn(row, ast.name) ? (row[ast.name] ?? null) : null;
    case 'unary': {
      const v = evaluate(ast.arg, row);
      if (ast.op === '!') return !truthy(v);
      const n = num(v);
      return n === null ? null : -n;
    }
    case 'cond':
      return truthy(evaluate(ast.test, row)) ? evaluate(ast.then, row) : evaluate(ast.else, row);
    case 'call':
      return FUNCTIONS[ast.fn]!.fn(...ast.args.map((a) => evaluate(a, row)));
    case 'binary': {
      if (ast.op === '&&') return truthy(evaluate(ast.left, row)) && truthy(evaluate(ast.right, row));
      if (ast.op === '||') return truthy(evaluate(ast.left, row)) || truthy(evaluate(ast.right, row));
      const a = evaluate(ast.left, row);
      const b = evaluate(ast.right, row);
      if (['==', '!=', '<', '<=', '>', '>='].includes(ast.op)) return compare(ast.op, a, b);
      if (
        ast.op === '+' &&
        (typeof a === 'string' || typeof b === 'string') &&
        (num(a) === null || num(b) === null)
      ) {
        return capped(str(a) + str(b));
      }
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      let r: number;
      switch (ast.op) {
        case '+':
          r = x + y;
          break;
        case '-':
          r = x - y;
          break;
        case '*':
          r = x * y;
          break;
        case '/':
          r = x / y;
          break;
        case '%':
          r = x % y;
          break;
        default:
          r = x ** y;
      }
      return Number.isFinite(r) ? r : null;
    }
  }
}

/** Parses once and returns a fast per-row evaluator. */
export function compile(src: string): (row: Row) => Scalar {
  const ast = parse(src);
  return (row) => evaluate(ast, row);
}

export function isTruthy(v: Scalar): boolean {
  return truthy(v);
}
