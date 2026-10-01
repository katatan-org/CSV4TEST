/** One field of a record. `quoted` remembers whether the source wrapped it in quotes. */
export interface CsvField {
  value: string;
  quoted: boolean;
}

/**
 * One record (physical row of the CSV, possibly spanning several lines when a
 * quoted field contains newlines).
 *
 * Records are treated as immutable: every edit produces a new record object.
 * `raw` holds the exact source text of the record (without its terminator) and
 * is only present while the record is untouched, so serialization can emit the
 * original bytes and keep Git diffs minimal.
 */
export interface CsvRecord {
  /** Stable identity across edits, used for undo, diffing and selection. */
  id: number;
  fields: CsvField[];
  raw: string | null;
  /** Record terminator as found in the source ("\r\n", "\n", "\r" or ""). */
  eol: string;
}

export interface CsvLayout {
  bom: boolean;
  delimiter: string;
  /** Most common record terminator; used for new records. */
  eol: string;
  /** Whether the last record is followed by a terminator. */
  trailingEol: boolean;
  /** Newline style used inside quoted fields (KATATAN files use "\n" with CRLF records). */
  cellEol: string;
}

export interface ParsedCsv {
  layout: CsvLayout;
  records: CsvRecord[];
}
