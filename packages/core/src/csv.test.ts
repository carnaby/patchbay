import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';

describe('parseCsv', () => {
  it('splits plain rows and ignores the final line break', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('accepts CRLF and a lone CR as line breaks', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parseCsv('a\r1')).toEqual([['a'], ['1']]);
  });

  it('keeps commas, doubled quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('name,note\n"Smith, J.","He said ""hi""\r\nand left"\n')).toEqual([
      ['name', 'note'],
      ['Smith, J.', 'He said "hi"\r\nand left'],
    ]);
  });

  it('keeps empty fields, including a trailing one and an empty quoted one', () => {
    expect(parseCsv('a,b,c\n,"",\n')).toEqual([
      ['a', 'b', 'c'],
      ['', '', ''],
    ]);
  });

  it('drops a byte order mark and blank lines', () => {
    expect(parseCsv('﻿a\n\n1\n\n')).toEqual([['a'], ['1']]);
  });

  it('returns no rows for empty text', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('refuses an unterminated quote and text after a closing quote', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/quote/);
    expect(() => parseCsv('"a"b,c')).toThrow(/quote/);
  });
});
