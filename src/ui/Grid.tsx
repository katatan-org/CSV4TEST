import {
  CompactSelection,
  DataEditor,
  type DataEditorProps,
  type DataEditorRef,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { cellValue, columnCount, insertRecords, setCells, type CellEdit, type CsvDoc } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { isCellDirty } from "../editor/changes";
import { parseTsv, toTsv } from "../editor/clipboard";
import type { ResolvedRules } from "../rules/detect";
import { headerMatches } from "../rules/schema";
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT, cellHeight } from "./cellLayout";
import { createRichRenderer, isRichCell, richCell } from "./richCell";
import { backgroundColor, gridTheme, textColor, type ThemeMode } from "./theme";
import type { ViewContext } from "./view";

export interface GridProps {
  doc: CsvDoc;
  rows: CsvRecord[];
  rules: ResolvedRules;
  view: ViewContext;
  widths: number[];
  mode: ThemeMode;
  selection: GridSelection;
  onSelectionChange(sel: GridSelection): void;
  /** Row drag & drop is only allowed when the view shows the file order. */
  canMoveRows: boolean;
  highlights: DataEditorProps["highlightRegions"];
  apply(label: string, update: (doc: CsvDoc) => CsvDoc): void;
  /** Fills id columns etc. for rows about to be created. */
  prepareNewRows(doc: CsvDoc, rows: string[][]): string[][];
  onAppendRow(): void;
  onMoveRow(from: number, to: number): void;
  onMoveColumn(from: number, to: number): void;
  onColumnResize(col: number, width: number): void;
  onHeaderMenu(col: number, bounds: Rectangle): void;
  onCellMenu(row: number, col: number, x: number, y: number): void;
  onImageFiles(recordId: number, files: File[]): void;
  gridRef: RefObject<DataEditorRef>;
}

export const emptySelection: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
  current: undefined,
};

/** The rectangle the clipboard and delete key act on. */
export function selectionRect(sel: GridSelection, rowCount: number, colCount: number): Rectangle | null {
  if (sel.current) return sel.current.range;
  const rows = sel.rows.toArray();
  if (rows.length > 0) {
    const y = Math.min(...rows);
    return { x: 0, y, width: colCount, height: Math.max(...rows) - y + 1 };
  }
  const cols = sel.columns.toArray();
  if (cols.length > 0) {
    const x = Math.min(...cols);
    return { x, y: 0, width: Math.max(...cols) - x + 1, height: rowCount };
  }
  return null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtmlTable(values: string[][]): string {
  const cell = (v: string) => `<td>${escapeHtml(v).replace(/\n/g, '<br style="mso-data-placement:same-cell;">')}</td>`;
  return `<table>${values.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</table>`;
}

export function Grid(props: GridProps) {
  const { rows, rules, view, widths, mode, selection, apply, gridRef } = props;
  const viewRef = useRef(view);
  viewRef.current = view;
  const propsRef = useRef(props);
  propsRef.current = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const renderers = useMemo(() => [createRichRenderer(viewRef)], []);
  const theme = useMemo(() => gridTheme(mode), [mode]);
  const colCount = rules.columns.length;

  const freezeColumns = useMemo(() => {
    let n = 0;
    while (n < rules.columns.length && rules.columns[n].rule.pinned) n++;
    return n;
  }, [rules.columns]);
  const hintColumn = freezeColumns < colCount ? freezeColumns : 0;

  const columns = useMemo<GridColumn[]>(
    () =>
      rules.columns.map((c, i) => ({
        id: String(i),
        title: c.header === "" ? `(列 ${i + 1})` : c.header,
        width: widths[i],
        hasMenu: true,
        // Glide shows the "add row" hint in the first column unless a column carries it.
        trailingRowOptions: i === hintColumn ? { hint: "行を追加" } : { hint: "" },
      })),
    [rules.columns, widths, hintColumn],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const record = rows[row];
      const column = rules.columns[col];
      const value = cellValue(record, col);
      return richCell(
        { kind: "rich-cell", value, recordId: record?.id ?? -1, col, dirty: record ? isCellDirty(record, col, view.originals, view.columnMap) : false },
        backgroundColor(view.mode, column?.rule.background),
      );
    },
    [rows, rules.columns, view],
  );

  // Row heights depend on every cell's wrapped layout; cache per record object.
  const heightCache = useMemo(() => new WeakMap<CsvRecord, number>(), [widths, view.layouts]);
  const rowHeight = useCallback(
    (row: number) => {
      const record = rows[row];
      if (!record) return MIN_ROW_HEIGHT;
      let h = heightCache.get(record);
      if (h === undefined) {
        h = MIN_ROW_HEIGHT;
        for (let c = 0; c < colCount; c++) {
          const layout = view.layouts.get(c, widths[c], cellValue(record, c));
          if (layout) h = Math.max(h, cellHeight(layout));
        }
        h = Math.min(Math.ceil(h), MAX_ROW_HEIGHT);
        heightCache.set(record, h);
      }
      return h;
    },
    [rows, colCount, widths, view.layouts, heightCache],
  );

  const getRowThemeOverride = useCallback<NonNullable<DataEditorProps["getRowThemeOverride"]>>(
    (row) => {
      const ruleList = rules.ruleSet.rows;
      const record = rows[row];
      if (!ruleList || ruleList.length === 0 || !record) return undefined;
      for (const r of ruleList) {
        const col = rules.columns.find((c) => headerMatches(r.when.column, c.header));
        if (!col) continue;
        const v = cellValue(record, col.index);
        const hit =
          (r.when.equals !== undefined && v.trim() === r.when.equals) ||
          (r.when.empty === true && v.trim() === "") ||
          (r.when.regex !== undefined && safeTest(r.when.regex, v));
        if (hit) {
          return {
            bgCell: backgroundColor(view.mode, r.background),
            textDark: textColor(view.mode, r.color),
          };
        }
      }
      return undefined;
    },
    [rows, rules, view.mode],
  );

  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]) => {
      const edits: CellEdit[] = [];
      for (const { location, value } of items) {
        const record = rows[location[1]];
        if (record && isRichCell(value)) edits.push({ recordId: record.id, col: location[0], value: value.data.value });
      }
      if (edits.length > 0) apply(edits.length > 1 ? `${edits.length}セルを編集` : "セルを編集", (d) => setCells(d, edits));
      return true;
    },
    [rows, apply],
  );

  const clearRect = useCallback(
    (rect: Rectangle, label: string) => {
      const edits: CellEdit[] = [];
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        const record = rows[y];
        if (!record) continue;
        for (let x = rect.x; x < rect.x + rect.width; x++) edits.push({ recordId: record.id, col: x, value: "" });
      }
      apply(label, (d) => setCells(d, edits));
    },
    [rows, apply],
  );

  const onDelete = useCallback(
    (sel: GridSelection) => {
      const rect = selectionRect(sel, rows.length, colCount);
      if (rect) clearRect(rect, "セルをクリア");
      return false;
    },
    [rows.length, colCount, clearRect],
  );

  // Clipboard: handled here (not by Glide) so multi-line cells round-trip with Excel.
  useEffect(() => {
    const gridHasFocus = () => {
      const active = document.activeElement;
      return !!active && !!containerRef.current?.contains(active);
    };
    const readRect = (rect: Rectangle) => {
      const { rows } = propsRef.current;
      const out: string[][] = [];
      for (let y = rect.y; y < rect.y + rect.height && y < rows.length; y++) {
        const line: string[] = [];
        for (let x = rect.x; x < rect.x + rect.width; x++) line.push(cellValue(rows[y], x));
        out.push(line);
      }
      return out;
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (!gridHasFocus() || !e.clipboardData) return;
      const p = propsRef.current;
      const rect = selectionRect(p.selection, p.rows.length, p.rules.columns.length);
      if (!rect) return;
      e.preventDefault();
      const values = readRect(rect);
      e.clipboardData.setData("text/plain", toTsv(values));
      e.clipboardData.setData("text/html", toHtmlTable(values));
      if (cut) clearRect(rect, "切り取り");
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!gridHasFocus() || !e.clipboardData) return;
      const p = propsRef.current;
      const rect = selectionRect(p.selection, p.rows.length, p.rules.columns.length);
      if (!rect) return;
      e.preventDefault();

      const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      const target = p.rows[rect.y];
      if (images.length > 0) {
        if (target && p.rules.columns[rect.x]?.rule.display === "images") p.onImageFiles(target.id, images);
        return;
      }

      let values = parseTsv(e.clipboardData.getData("text/plain"));
      if (values.length === 0) return;
      // A single value pasted onto a range fills the range, like Excel.
      if (values.length === 1 && values[0].length === 1 && (rect.width > 1 || rect.height > 1)) {
        values = Array.from({ length: rect.height }, () => Array<string>(rect.width).fill(values[0][0]));
      }
      const width = columnCount(p.doc);
      const edits: CellEdit[] = [];
      const extra: string[][] = [];
      values.forEach((line, dy) => {
        const record = p.rows[rect.y + dy];
        if (record) {
          line.forEach((v, dx) => {
            if (rect.x + dx < width) edits.push({ recordId: record.id, col: rect.x + dx, value: v });
          });
        } else {
          const row = Array<string>(width).fill("");
          line.forEach((v, dx) => {
            if (rect.x + dx < width) row[rect.x + dx] = v;
          });
          extra.push(row);
        }
      });
      p.apply(extra.length > 0 ? `貼り付け（${extra.length}行追加）` : "貼り付け", (d) => {
        const edited = setCells(d, edits);
        return extra.length > 0 ? insertRecords(edited, edited.records.length, p.prepareNewRows(edited, extra)).doc : edited;
      });
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", onPaste);
    };
  }, [clearRect]);

  const imageColAt = (col: number) => rules.columns[col]?.rule.display === "images";

  return (
    <div className="grid-container" ref={containerRef}>
      <DataEditor
        ref={gridRef}
        columns={columns}
        rows={rows.length}
        getCellContent={getCellContent}
        customRenderers={renderers}
        rowHeight={rowHeight}
        headerHeight={36}
        freezeColumns={freezeColumns}
        theme={theme}
        width="100%"
        height="100%"
        smoothScrollX
        smoothScrollY
        rowMarkers={{ kind: "clickable-number", width: 48 }}
        rangeSelect="multi-rect"
        columnSelect="multi"
        rowSelect="multi"
        gridSelection={selection}
        onGridSelectionChange={props.onSelectionChange}
        getCellsForSelection
        fillHandle
        onCellsEdited={onCellsEdited}
        onDelete={onDelete}
        keybindings={{ copy: false, cut: false, paste: false, search: false }}
        getRowThemeOverride={getRowThemeOverride}
        highlightRegions={props.highlights}
        trailingRowOptions={{ sticky: true, tint: true, targetColumn: hintColumn }}
        onRowAppended={props.onAppendRow}
        onRowMoved={props.canMoveRows ? props.onMoveRow : undefined}
        onColumnMoved={props.onMoveColumn}
        onColumnResize={(_c, size, index) => props.onColumnResize(index, size)}
        onHeaderMenuClick={props.onHeaderMenu}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault();
          props.onHeaderMenu(col, e.bounds);
        }}
        onCellContextMenu={([col, row], e) => {
          e.preventDefault();
          props.onCellMenu(row, col, e.bounds.x + e.localEventX, e.bounds.y + e.localEventY);
        }}
        onDragOverCell={([col], dt) => {
          if (dt && imageColAt(col)) dt.dropEffect = "copy";
        }}
        onDrop={([col, row], dt) => {
          const record = rows[row];
          const files = Array.from(dt?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (record && imageColAt(col) && files.length > 0) props.onImageFiles(record.id, files);
        }}
        minColumnWidth={48}
        maxColumnWidth={1200}
      />
    </div>
  );
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
