import { cellValue, columnCount, type CsvDoc } from "../csv/document";
import type { CsvRecord } from "../csv/types";

export interface CellChange {
  /** Current column index, or -1 for a column that was deleted. */
  col: number;
  header: string;
  before: string;
  after: string;
}

export interface RecordChange {
  kind: "added" | "removed" | "modified";
  record: CsvRecord;
  /** Position in the current doc (added/modified) or the original doc (removed). */
  index: number;
  cells: CellChange[];
}

export interface ChangeSummary {
  changes: RecordChange[];
  /** Rows kept but in a different order. */
  reordered: boolean;
  dirtyCells: number;
  /** Columns added or removed since loading; every line of the file changes. */
  columns: { added: string[]; removed: string[] };
}

/**
 * Maps each current column to the loaded file's column with the same header
 * (null for a new column), so inserting or moving a column does not make every
 * cell look edited. Unmatched columns fall back to the same position (renames).
 */
export function columnMapping(doc: CsvDoc): (number | null)[] {
  const width = columnCount(doc);
  const header = doc.records[0];
  const original = header ? doc.originals.get(header.id) : undefined;
  if (!header || !original) return Array<null>(width).fill(null);
  const identity = Array.from({ length: width }, (_, i) => i);
  if (original === header && width === original.fields.length) return identity;

  const used = new Set<number>();
  const map: (number | null)[] = identity.map((c) => {
    const name = cellValue(header, c);
    if (c < original.fields.length && original.fields[c].value === name) {
      used.add(c);
      return c;
    }
    return null;
  });
  map.forEach((m, c) => {
    if (m !== null) return;
    const name = cellValue(header, c);
    const o = original.fields.findIndex((f, i) => !used.has(i) && f.value === name);
    if (o >= 0) {
      used.add(o);
      map[c] = o;
    }
  });
  if (width === original.fields.length) {
    map.forEach((m, c) => {
      if (m === null && !used.has(c)) {
        used.add(c);
        map[c] = c;
      }
    });
  }
  return map;
}

/** What will differ from the file on disk if the doc is saved now. */
export function computeChanges(doc: CsvDoc): ChangeSummary {
  const width = columnCount(doc);
  const map = columnMapping(doc);
  const headerNow = (col: number) => cellValue(doc.records[0], col);
  const originalHeader = doc.records[0] ? doc.originals.get(doc.records[0].id) : undefined;
  const mapped = new Set(map.filter((m): m is number => m !== null));
  const removedCols = (originalHeader?.fields ?? []).map((_, i) => i).filter((i) => !mapped.has(i));

  const currentIds = new Set(doc.records.map((r) => r.id));
  const changes: RecordChange[] = [];
  let dirtyCells = 0;

  doc.records.forEach((record, index) => {
    const original = doc.originals.get(record.id);
    if (!original) {
      const cells = Array.from({ length: width }, (_, col) => ({ col, header: headerNow(col), before: "", after: cellValue(record, col) }));
      changes.push({ kind: "added", record, index, cells });
      dirtyCells += width;
      return;
    }
    if (original === record) return;
    const cells: CellChange[] = [];
    for (let col = 0; col < width; col++) {
      const m = map[col];
      const before = m === null ? "" : cellValue(original, m);
      const after = cellValue(record, col);
      if (before !== after) cells.push({ col, header: headerNow(col), before, after });
    }
    for (const o of removedCols) {
      const before = cellValue(original, o);
      if (before !== "") cells.push({ col: -1, header: cellValue(originalHeader, o), before, after: "" });
    }
    if (cells.length > 0) {
      changes.push({ kind: "modified", record, index, cells });
      dirtyCells += cells.length;
    }
  });

  doc.originalOrder.forEach((id, index) => {
    if (currentIds.has(id)) return;
    const record = doc.originals.get(id)!;
    changes.push({
      kind: "removed",
      record,
      index,
      cells: record.fields.map((f, col) => ({ col, header: cellValue(originalHeader, col), before: f.value, after: "" })),
    });
  });

  const keptOriginal = doc.originalOrder.filter((id) => currentIds.has(id));
  const keptCurrent = doc.records.filter((r) => doc.originals.has(r.id)).map((r) => r.id);
  const reordered = keptOriginal.some((id, i) => keptCurrent[i] !== id);

  return {
    changes,
    reordered,
    dirtyCells,
    columns: {
      added: map.map((m, c) => (m === null ? headerNow(c) : null)).filter((h): h is string => h !== null),
      removed: removedCols.map((o) => cellValue(originalHeader, o)),
    },
  };
}

/**
 * Whether a single cell differs from the loaded file. New rows count as dirty;
 * cells of a newly added column only when they are not empty.
 */
export function isCellDirty(
  record: CsvRecord,
  col: number,
  originals: ReadonlyMap<number, CsvRecord>,
  map: (number | null)[],
): boolean {
  const original = originals.get(record.id);
  if (!original) return true;
  const m = map[col];
  if (original === record && m === col) return false;
  return (m === null ? "" : cellValue(original, m)) !== cellValue(record, col);
}
