import {
  AllCellRenderers,
  CompactSelection,
  DataEditorCore,
  ImageWindowLoaderImpl,
  markerCellRenderer,
  sprites,
  type DataEditorProps,
  type DataEditorRef,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cellValue, columnCount, setCells, type CellEdit, type CsvDoc } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { isCellDirty } from "../editor/changes";
import { parseTsv, toTsv } from "../editor/clipboard";
import { editViewCells, rowsAddedBy, type ViewCellEdit } from "../editor/viewRows";
import type { ResolvedRules } from "../rules/detect";
import { headerMatches } from "../rules/schema";
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT, cellHeight } from "./cellLayout";
import { Icon } from "./icons";
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
  /** Show blank rows below the data that become records when typed into (off while filtered). */
  canExtend: boolean;
  /** Nothing can be edited. */
  readOnly: boolean;
  /** Columns whose cells cannot be edited. */
  readOnlyCols: ReadonlySet<number>;
  /** Columns can be inserted and moved. */
  canEditColumns: boolean;
  highlights: DataEditorProps["highlightRegions"];
  /** Host overrides for the canvas theme (the canvas cannot read CSS variables). */
  themeOverride?: Partial<Theme>;
  apply(label: string, update: (doc: CsvDoc) => CsvDoc): void;
  /** Inserts a blank row next to the record shown at view row `row`. */
  onInsertRow(row: number, below: boolean): void;
  /** Inserts a column before index `at`. */
  onInsertColumn(at: number): void;
  onMoveRow(from: number, to: number): void;
  onMoveColumn(from: number, to: number): void;
  onColumnResize(col: number, width: number): void;
  onHeaderMenu(col: number, bounds: Rectangle): void;
  onCellMenu(row: number, col: number, x: number, y: number): void;
  onImageFiles(recordId: number, files: File[]): void;
  gridRef: RefObject<DataEditorRef>;
}

// With row dragging on, Glide only toggles a row from the 20px around its number;
// the rest of the row number cell should select the row too.
const wholeCellMarker: typeof markerCellRenderer = { ...markerCellRenderer, onClick: (e) => ({ ...e.cell, checked: !e.cell.checked }) };
const cellRenderers = AllCellRenderers.map((r) => (r === markerCellRenderer ? (wholeCellMarker as (typeof AllCellRenderers)[number]) : r));

/** Blank rows shown below the data, so any cell there can be typed into. */
const BLANK_ROWS = 50;

interface Hover {
  kind: "row" | "column";
  index: number;
}

const sameHover = (a: Hover | null, b: Hover | null) => a === b || (!!a && !!b && a.kind === b.kind && a.index === b.index);

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
  const imageWindowLoader = useMemo(() => new ImageWindowLoaderImpl(), []);
  const theme = useMemo(() => ({ ...gridTheme(mode), ...props.themeOverride }), [mode, props.themeOverride]);
  const colCount = rules.columns.length;
  const rowCount = rows.length + (props.canExtend ? BLANK_ROWS : 0);

  const freezeColumns = useMemo(() => {
    let n = 0;
    while (n < rules.columns.length && rules.columns[n].rule.pinned) n++;
    return n;
  }, [rules.columns]);

  const columns = useMemo<GridColumn[]>(
    () =>
      rules.columns.map((c, i) => ({
        id: String(i),
        title: c.header === "" ? `(列 ${i + 1})` : c.header,
        width: widths[i],
        hasMenu: true,
      })),
    [rules.columns, widths],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const record = rows[row];
      const column = rules.columns[col];
      const value = cellValue(record, col);
      const cell = richCell(
        { kind: "rich-cell", value, recordId: record?.id ?? -1, col, dirty: record ? isCellDirty(record, col, view.originals, view.columnMap) : false },
        backgroundColor(view.mode, column?.rule.background),
      );
      return props.readOnly || props.readOnlyCols.has(col) ? { ...cell, allowOverlay: false, readonly: true } : cell;
    },
    [rows, rules.columns, view, props.readOnly, props.readOnlyCols],
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
      const edits: ViewCellEdit[] = [];
      for (const { location, value } of items) {
        if (isRichCell(value)) edits.push({ row: location[1], col: location[0], value: value.data.value });
      }
      if (edits.length === 0) return true;
      const added = rowsAddedBy(rows.length, edits);
      const label = edits.length > 1 ? `${edits.length}セルを編集` : "セルを編集";
      apply(added > 0 ? `${label}（${added}行追加）` : label, (d) => editViewCells(d, rows, edits));
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
      const edits: ViewCellEdit[] = [];
      values.forEach((line, dy) => {
        line.forEach((v, dx) => {
          if (rect.x + dx < width) edits.push({ row: rect.y + dy, col: rect.x + dx, value: v });
        });
      });
      const added = rowsAddedBy(p.rows.length, edits);
      p.apply(added > 0 ? `貼り付け（${added}行追加）` : "貼り付け", (d) => editViewCells(d, p.rows, edits));
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

  // Insert buttons on the borders of the hovered row number / column header.
  // Hit-tested here on every pointer move rather than via Glide's onItemHovered, which
  // only fires when the item changes and skips moves it considers obscured.
  const [hover, setHover] = useState<Hover | null>(null);
  const visible = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
  const scrollOffset = useRef<[number, number]>([0, 0]);
  const hideTimer = useRef<number>();
  const keepHover = () => window.clearTimeout(hideTimer.current);
  const hideHover = (delay = 200) => {
    keepHover();
    hideTimer.current = window.setTimeout(() => setHover(null), delay);
  };
  useEffect(() => keepHover, []);

  const hitTest = (x: number, y: number): Hover | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const inside = (b: Rectangle | undefined) => !!b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    const v = visible.current;
    for (let row = Math.max(0, v.y); row <= v.y + v.height && row < rows.length; row++) {
      if (inside(grid.getBounds(-1, row))) return { kind: "row", index: row };
    }
    // Frozen columns first: they cover the scrolled ones.
    const cols = [...Array.from({ length: freezeColumns }, (_, i) => i), ...Array.from({ length: v.width + 1 }, (_, i) => v.x + i)];
    for (const col of cols) {
      if (col < colCount && inside(grid.getBounds(col, -1))) return { kind: "column", index: col };
    }
    return null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if ((e.target as Element).closest(".grid-insert")) {
      keepHover();
      return;
    }
    const h = e.buttons === 0 ? hitTest(e.clientX, e.clientY) : null;
    if (!h) {
      hideHover();
      return;
    }
    keepHover();
    setHover((prev) => (sameHover(prev, h) ? prev : h));
  };

  const insertButton = (key: string, x: number, y: number, title: string, onClick: () => void) => (
    <button
      key={key}
      className="grid-insert"
      style={{ left: x, top: y }}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setHover(null);
        onClick();
      }}
    >
      <Icon name="plus" size={12} />
    </button>
  );

  let insertButtons: JSX.Element[] = [];
  const box = containerRef.current?.getBoundingClientRect();
  const bounds = hover && (hover.kind === "row" ? gridRef.current?.getBounds(-1, hover.index) : gridRef.current?.getBounds(hover.index, -1));
  const canInsert = hover && !props.readOnly && (hover.kind === "row" || props.canEditColumns);
  if (hover && canInsert && box && bounds) {
    const rect = { ...bounds, x: bounds.x - box.left, y: bounds.y - box.top };
    const { index } = hover;
    if (hover.kind === "row") {
      const x = rect.x + rect.width / 2;
      insertButtons = [
        insertButton("above", x, rect.y, "上に行を挿入", () => props.onInsertRow(index, false)),
        insertButton("below", x, rect.y + rect.height, "下に行を挿入", () => props.onInsertRow(index, true)),
      ];
    } else {
      const y = rect.y + rect.height / 2;
      insertButtons = [
        insertButton("left", rect.x, y, "左に列を挿入", () => props.onInsertColumn(index)),
        insertButton("right", rect.x + rect.width, y, "右に列を挿入", () => props.onInsertColumn(index + 1)),
      ];
    }
  }

  return (
    <div className="grid-container" ref={containerRef} onPointerMove={onPointerMove} onPointerLeave={() => hideHover()}>
      <DataEditorCore
        ref={gridRef}
        renderers={cellRenderers}
        headerIcons={sprites}
        imageWindowLoader={imageWindowLoader}
        columns={columns}
        rows={rowCount}
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
        fillHandle={!props.readOnly}
        onCellsEdited={onCellsEdited}
        onDelete={onDelete}
        keybindings={{ copy: false, cut: false, paste: false, search: false }}
        getRowThemeOverride={getRowThemeOverride}
        highlightRegions={props.highlights}
        onVisibleRegionChanged={(range, tx, ty) => {
          // Only scrolling moves items away from the pointer; row inserts also land here.
          const v = visible.current;
          const scrolled = range.x !== v.x || range.y !== v.y || tx !== scrollOffset.current[0] || ty !== scrollOffset.current[1];
          visible.current = range;
          scrollOffset.current = [tx ?? 0, ty ?? 0];
          if (scrolled) setHover(null);
        }}
        onRowMoved={props.canMoveRows && !props.readOnly ? props.onMoveRow : undefined}
        onColumnMoved={props.canEditColumns && !props.readOnly ? props.onMoveColumn : undefined}
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
      {insertButtons}
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
