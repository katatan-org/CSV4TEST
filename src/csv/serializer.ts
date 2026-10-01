import type { CsvField, CsvLayout, CsvRecord, ParsedCsv } from "./types";

export function formatField(field: CsvField, delimiter: string): string {
  const v = field.value;
  const needsQuotes =
    v.includes(delimiter) || v.includes('"') || v.includes("\n") || v.includes("\r");
  if (!field.quoted && !needsQuotes) return v;
  return '"' + v.replace(/"/g, '""') + '"';
}

/** Text of one record without its terminator. Untouched records return their source text. */
export function serializeRecord(record: CsvRecord, delimiter: string): string {
  if (record.raw !== null) return record.raw;
  return record.fields.map((f) => formatField(f, delimiter)).join(delimiter);
}

/** Terminator of the record at `index`, taking moves/appends into account. */
export function recordEol(records: CsvRecord[], index: number, layout: CsvLayout): string {
  const isLast = index === records.length - 1;
  if (isLast && !layout.trailingEol) return "";
  return records[index].eol || layout.eol;
}

export function serializeCsv({ layout, records }: ParsedCsv): string {
  let out = layout.bom ? "﻿" : "";
  for (let i = 0; i < records.length; i++) {
    out += serializeRecord(records[i], layout.delimiter) + recordEol(records, i, layout);
  }
  return out;
}
