import { cellValue } from "../csv/document";
import type { CsvRecord } from "../csv/types";

export interface FindOptions {
  regex: boolean;
  caseSensitive: boolean;
  /** Only search these columns (all when undefined). */
  columns?: number[];
}

export interface Match {
  recordId: number;
  col: number;
}

/** Builds the search pattern, or an error message for an invalid regex. */
export function buildPattern(query: string, opts: FindOptions): RegExp | string {
  if (query === "") return "検索語が空です";
  const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch (e) {
    return `正規表現が不正です: ${(e as Error).message}`;
  }
}

/** Matching cells in display order (rows as given, then columns left to right). */
export function findMatches(rows: CsvRecord[], colCount: number, pattern: RegExp, opts: FindOptions): Match[] {
  const cols = opts.columns ?? Array.from({ length: colCount }, (_, i) => i);
  const out: Match[] = [];
  for (const r of rows) {
    for (const c of cols) {
      pattern.lastIndex = 0;
      if (pattern.test(cellValue(r, c))) out.push({ recordId: r.id, col: c });
    }
  }
  return out;
}

/** Replaces every occurrence in a cell. `$1` etc. work in regex mode. */
export function replaceAll(value: string, pattern: RegExp, replacement: string, opts: FindOptions): string {
  pattern.lastIndex = 0;
  return opts.regex ? value.replace(pattern, replacement) : value.replace(pattern, () => replacement);
}
