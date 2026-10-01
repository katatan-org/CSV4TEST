import type { CsvField, CsvRecord, ParsedCsv } from "./types";

let nextRecordId = 1;
export function newRecordId(): number {
  return nextRecordId++;
}

export interface ParseOptions {
  /** Field delimiter. Detected from the first record when omitted. */
  delimiter?: string;
}

/**
 * Lossless CSV parser (RFC 4180 plus lenient handling of malformed quotes).
 *
 * Every record keeps its exact source text in `raw` and its own terminator in
 * `eol`, so `serializeCsv(parseCsv(text))` reproduces `text` byte for byte,
 * including BOM, mixed CRLF/LF, quoting style and a missing final newline.
 */
export function parseCsv(input: string, options: ParseOptions = {}): ParsedCsv {
  const bom = input.charCodeAt(0) === 0xfeff;
  const text = bom ? input.slice(1) : input;
  const delimiter = options.delimiter ?? detectDelimiter(text);

  const records: CsvRecord[] = [];
  const eolCounts = new Map<string, number>();
  const cellEolCounts = new Map<string, number>();
  const len = text.length;
  let i = 0;

  while (i < len) {
    const start = i;
    const fields: CsvField[] = [];
    let eol = "";

    for (;;) {
      // Parse one field starting at i.
      let value = "";
      let quoted = false;
      if (text[i] === '"') {
        quoted = true;
        i++;
        for (;;) {
          if (i >= len) break; // unterminated quote: take the rest
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (ch === "\r" || ch === "\n") {
            const nl = ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch;
            cellEolCounts.set(nl, (cellEolCounts.get(nl) ?? 0) + 1);
            value += nl;
            i += nl.length;
            continue;
          }
          value += ch;
          i++;
        }
        // Lenient: keep any junk between the closing quote and the delimiter.
        while (i < len && text[i] !== delimiter && text[i] !== "\r" && text[i] !== "\n") {
          value += text[i];
          i++;
        }
      } else {
        const fieldStart = i;
        while (i < len && text[i] !== delimiter && text[i] !== "\r" && text[i] !== "\n") i++;
        value = text.slice(fieldStart, i);
      }
      fields.push({ value, quoted });

      if (i < len && text[i] === delimiter) {
        i++;
        continue;
      }
      break;
    }

    const end = i;
    if (i < len) {
      eol = text[i] === "\r" && text[i + 1] === "\n" ? "\r\n" : text[i];
      i += eol.length;
      eolCounts.set(eol, (eolCounts.get(eol) ?? 0) + 1);
    }
    records.push({ id: newRecordId(), fields, raw: text.slice(start, end), eol });
  }

  const eol = mostCommon(eolCounts) ?? "\n";
  const last = records[records.length - 1];
  return {
    layout: {
      bom,
      delimiter,
      eol,
      trailingEol: last ? last.eol !== "" : false,
      cellEol: mostCommon(cellEolCounts) ?? "\n",
    },
    records,
  };
}

function mostCommon(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Picks the delimiter that occurs most often (outside quotes) in the first record. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of ["\t", ";"]) if (counts[d] > counts[best]) best = d;
  return best;
}
