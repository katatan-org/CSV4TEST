/**
 * Excel-compatible TSV for the clipboard: cells containing tabs, newlines or
 * quotes are quoted, so multi-line steps survive a round trip through Excel
 * or Google Sheets.
 */
export function toTsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((v) => (/[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v))
        .join("\t"),
    )
    .join("\r\n");
}

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const len = text.length;
  while (i <= len) {
    let value = "";
    if (text[i] === '"') {
      // Quoted cell: only treat as quoted if the closing quote is followed by a separator.
      const end = findQuotedEnd(text, i);
      if (end >= 0) {
        value = text.slice(i + 1, end).replace(/""/g, '"');
        i = end + 1;
      } else {
        const stop = nextSeparator(text, i);
        value = text.slice(i, stop);
        i = stop;
      }
    } else {
      const stop = nextSeparator(text, i);
      value = text.slice(i, stop);
      i = stop;
    }
    row.push(value);
    if (i >= len) {
      rows.push(row);
      break;
    }
    if (text[i] === "\t") {
      i++;
      continue;
    }
    // Newline ends the row.
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= len) break; // trailing newline does not start a new row
  }
  return rows.map((r) => r.map((v) => v.replace(/\r\n|\r/g, "\n")));
}

function nextSeparator(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\t" || ch === "\n" || ch === "\r") return i;
  }
  return text.length;
}

function findQuotedEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') {
      i++;
      continue;
    }
    const after = text[i + 1];
    return after === undefined || after === "\t" || after === "\n" || after === "\r" ? i : -1;
  }
  return -1;
}
