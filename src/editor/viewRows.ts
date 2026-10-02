import { cellValue, insertRecords, setCells, type CsvDoc } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { cellLines } from "../rules/tokens";

export interface ColumnFilter {
  col: number;
  /** Case-insensitive substring; empty matches everything. */
  text: string;
}

export interface ViewOptions {
  /** Record ids in sorted order (a snapshot taken when sorting; see sortSnapshot). */
  sortOrder: number[] | null;
  filters: ColumnFilter[];
  /** Rows having any of these labels in `labelCol`. */
  labels: string[];
  labelCol: number | null;
  /** Substring searched in every column. */
  quick: string;
}

export const EMPTY_VIEW: ViewOptions = { sortOrder: null, filters: [], labels: [], labelCol: null, quick: "" };

export function isViewFiltered(v: ViewOptions): boolean {
  return v.filters.some((f) => f.text !== "") || v.labels.length > 0 || v.quick.trim() !== "";
}

/**
 * Data rows (header excluded) as shown in the grid. Sorting and filtering only
 * affect the view; the file keeps its row order.
 */
export function computeViewRows(records: CsvRecord[], v: ViewOptions): CsvRecord[] {
  let rows = records.slice(1);

  const order = v.sortOrder;
  if (order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    // Rows added after sorting keep their file position at the end.
    rows = rows
      .map((r, i) => ({ r, k: pos.get(r.id) ?? order.length + i }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.r);
  }

  const filters = v.filters.filter((f) => f.text !== "").map((f) => ({ col: f.col, text: f.text.toLowerCase() }));
  const quick = v.quick.trim().toLowerCase();
  const labels = v.labelCol !== null && v.labels.length > 0 ? new Set(v.labels) : null;
  if (filters.length === 0 && !quick && !labels) return rows;

  return rows.filter((r) => {
    for (const f of filters) if (!cellValue(r, f.col).toLowerCase().includes(f.text)) return false;
    if (labels && !cellLines(cellValue(r, v.labelCol!)).some((l) => labels.has(l))) return false;
    if (quick && !r.fields.some((f) => f.value.toLowerCase().includes(quick))) return false;
    return true;
  });
}

const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/** Record ids ordered by a column. Taken once, so editing a sorted column does not move the row away. */
export function sortSnapshot(records: CsvRecord[], col: number, desc: boolean): number[] {
  const rows = records.slice(1).map((r, i) => ({ id: r.id, v: cellValue(r, col), i }));
  rows.sort((a, b) => {
    // Empty values always last.
    if ((a.v === "") !== (b.v === "")) return a.v === "" ? 1 : -1;
    const c = collator.compare(a.v, b.v);
    return (desc ? -c : c) || a.i - b.i;
  });
  return rows.map((r) => r.id);
}

export interface ViewCellEdit {
  /** Row in the view; rows at or past `rows.length` are blank rows below the data. */
  row: number;
  col: number;
  value: string;
}

// Clearing a blank row is not a reason to create it.
const effective = (rowCount: number, edits: ViewCellEdit[]) => edits.filter((e) => e.row < rowCount || e.value !== "");

/** How many records `editViewCells` appends for these edits. */
export function rowsAddedBy(rowCount: number, edits: ViewCellEdit[]): number {
  return effective(rowCount, edits).reduce((n, e) => Math.max(n, e.row - rowCount + 1), 0);
}

/**
 * Applies edits addressed by view row. Editing below the last row appends records
 * up to that row; the ones in between are saved as empty records (delimiters only).
 */
export function editViewCells(doc: CsvDoc, rows: CsvRecord[], edits: ViewCellEdit[]): CsvDoc {
  const live = effective(rows.length, edits);
  if (live.length === 0) return doc;
  const blank = Array.from({ length: rowsAddedBy(rows.length, live) }, () => []);
  const { doc: extended, ids } = insertRecords(doc, doc.records.length, blank);
  const idOf = (row: number) => (row < rows.length ? rows[row].id : ids[row - rows.length]);
  return setCells(extended, live.map((e) => ({ recordId: idOf(e.row), col: e.col, value: e.value })));
}
