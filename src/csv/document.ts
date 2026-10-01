import { decodeBytes, encodeText, type TextEncodingName } from "./encoding";
import { newRecordId, parseCsv } from "./parser";
import { serializeCsv } from "./serializer";
import type { CsvField, CsvLayout, CsvRecord } from "./types";

/**
 * An open CSV file. `records[0]` is the header row.
 * Edits never mutate: each operation returns a new `CsvDoc` sharing untouched records.
 */
export interface CsvDoc {
  layout: CsvLayout;
  encoding: TextEncodingName;
  records: CsvRecord[];
  /** Records as loaded (or last saved), by id. Shared by every derived doc. */
  originals: ReadonlyMap<number, CsvRecord>;
  /** Record order as loaded (or last saved). */
  originalOrder: readonly number[];
}

export function docFromText(text: string, encoding: TextEncodingName = "utf-8", delimiter?: string): CsvDoc {
  const { layout, records } = parseCsv(text, { delimiter });
  return {
    layout,
    encoding,
    records,
    originals: new Map(records.map((r) => [r.id, r])),
    originalOrder: records.map((r) => r.id),
  };
}

export function docFromBytes(bytes: Uint8Array, delimiter?: string): CsvDoc {
  const { text, encoding } = decodeBytes(bytes);
  return docFromText(text, encoding, delimiter);
}

export function docToText(doc: CsvDoc): string {
  return serializeCsv(doc);
}

export function docToBytes(doc: CsvDoc): Promise<Uint8Array<ArrayBuffer>> {
  return encodeText(docToText(doc), doc.encoding);
}

/** The doc after a successful save: current state becomes the new baseline. */
export function markSaved(doc: CsvDoc): CsvDoc {
  return {
    ...doc,
    originals: new Map(doc.records.map((r) => [r.id, r])),
    originalOrder: doc.records.map((r) => r.id),
  };
}

export function isDirty(doc: CsvDoc): boolean {
  if (doc.records.length !== doc.originalOrder.length) return true;
  return doc.records.some((r, i) => r.id !== doc.originalOrder[i] || doc.originals.get(r.id) !== r);
}

export function cellValue(record: CsvRecord | undefined, col: number): string {
  return record?.fields[col]?.value ?? "";
}

export function recordValues(record: CsvRecord): string[] {
  return record.fields.map((f) => f.value);
}

export function columnCount(doc: CsvDoc): number {
  let n = doc.records[0]?.fields.length ?? 0;
  for (const r of doc.records) if (r.fields.length > n) n = r.fields.length;
  return n;
}

/** Converts any newline inside a cell to the file's in-cell newline style. */
export function normalizeCellNewlines(value: string, cellEol: string): string {
  return value.replace(/\r\n|\r|\n/g, cellEol);
}

/**
 * New record with `fields`, keeping the record's id and terminator.
 * If the values equal the loaded version, the loaded record (with its raw text) is
 * returned so an edit that is undone by hand produces no diff.
 */
function withFields(doc: CsvDoc, record: CsvRecord, fields: CsvField[]): CsvRecord {
  const original = doc.originals.get(record.id);
  if (original && sameValues(original.fields, fields)) return original;
  if (sameValues(record.fields, fields)) return record;
  return { id: record.id, fields, raw: null, eol: record.eol };
}

function sameValues(a: CsvField[], b: CsvField[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].value !== b[i].value) return false;
  return true;
}

const EMPTY_FIELD: CsvField = { value: "", quoted: false };

function padded(fields: CsvField[], length: number): CsvField[] {
  if (fields.length >= length) return fields.slice();
  return [...fields, ...Array<CsvField>(length - fields.length).fill(EMPTY_FIELD)];
}

export interface CellEdit {
  recordId: number;
  col: number;
  value: string;
}

export function setCells(doc: CsvDoc, edits: CellEdit[]): CsvDoc {
  if (edits.length === 0) return doc;
  const byRecord = new Map<number, CellEdit[]>();
  for (const e of edits) {
    const list = byRecord.get(e.recordId);
    if (list) list.push(e);
    else byRecord.set(e.recordId, [e]);
  }
  let changed = false;
  const records = doc.records.map((record) => {
    const recEdits = byRecord.get(record.id);
    if (!recEdits) return record;
    const maxCol = Math.max(...recEdits.map((e) => e.col));
    const fields = padded(record.fields, maxCol + 1);
    for (const e of recEdits) {
      fields[e.col] = { value: normalizeCellNewlines(e.value, doc.layout.cellEol), quoted: fields[e.col].quoted };
    }
    const next = withFields(doc, record, fields);
    if (next !== record) changed = true;
    return next;
  });
  return changed ? { ...doc, records } : doc;
}

/** Inserts new records before `index` (an index into `doc.records`). */
export function insertRecords(doc: CsvDoc, index: number, rows: string[][]): { doc: CsvDoc; ids: number[] } {
  const width = columnCount(doc);
  const created: CsvRecord[] = rows.map((values) => ({
    id: newRecordId(),
    fields: padded(
      values.map((v) => ({ value: normalizeCellNewlines(v, doc.layout.cellEol), quoted: false })),
      width,
    ),
    raw: null,
    eol: "",
  }));
  const records = [...doc.records.slice(0, index), ...created, ...doc.records.slice(index)];
  return { doc: { ...doc, records }, ids: created.map((r) => r.id) };
}

export function deleteRecords(doc: CsvDoc, ids: Iterable<number>): CsvDoc {
  const remove = new Set(ids);
  if (remove.size === 0) return doc;
  return { ...doc, records: doc.records.filter((r) => !remove.has(r.id)) };
}

/** Moves the given records (kept in their current relative order) so they start at `toIndex` in the result. */
export function moveRecords(doc: CsvDoc, ids: Iterable<number>, toIndex: number): CsvDoc {
  const move = new Set(ids);
  const moving = doc.records.filter((r) => move.has(r.id));
  const rest = doc.records.filter((r) => !move.has(r.id));
  const at = Math.max(0, Math.min(toIndex, rest.length));
  return { ...doc, records: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
}

function mapAllFields(doc: CsvDoc, fn: (fields: CsvField[], index: number) => void): CsvDoc {
  const width = columnCount(doc);
  const records = doc.records.map((record, i) => {
    const fields = padded(record.fields, width);
    fn(fields, i);
    return withFields(doc, record, fields);
  });
  return { ...doc, records };
}

export function insertColumn(doc: CsvDoc, col: number, header: string, fill = ""): CsvDoc {
  return mapAllFields(doc, (fields, i) => {
    fields.splice(col, 0, { value: i === 0 ? header : fill, quoted: false });
  });
}

export function deleteColumn(doc: CsvDoc, col: number): CsvDoc {
  return mapAllFields(doc, (fields) => {
    fields.splice(col, 1);
  });
}

export function moveColumn(doc: CsvDoc, from: number, to: number): CsvDoc {
  if (from === to) return doc;
  return mapAllFields(doc, (fields) => {
    const [f] = fields.splice(from, 1);
    fields.splice(to, 0, f);
  });
}
