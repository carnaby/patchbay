/**
 * A small RFC 4180 reader for files the showcase ships (the server counts their rows, the landing page shows them).
 * Uploads use Papa Parse on the server instead: it streams and enforces limits, which a 200 KB attachment does not
 * need, and in the browser it would land in the vendor chunk every page loads.
 *
 * Returns every record as an array of fields, header included. Blank lines are skipped and a final line break does
 * not make an empty record. Throws on an unterminated quote or on text after a closing quote.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Set once a field opened with a quote: an empty quoted field still counts, and only a separator may follow it.
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  const endRow = () => {
    const blank = row.length === 0 && field === '' && !quoted;
    endField();
    if (!blank) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
      continue;
    }
    const separator = ch === ',' || ch === '\n' || ch === '\r';
    if (quoted && !separator) throw new Error('Text after a closing quote in CSV');
    if (ch === '"' && field === '') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ',') endField();
    else if (separator) {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (inQuotes) throw new Error('Unterminated quote in CSV');
  if (row.length || field !== '' || quoted) endRow();
  return rows;
}
