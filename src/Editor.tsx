import { CompactSelection, type DataEditorRef, type GridSelection, type Rectangle } from "@glideapps/glide-data-grid";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
  cellValue,
  columnCount,
  deleteColumn,
  deleteRecords,
  docFromBytes,
  docFromText,
  docToBytes,
  insertColumn,
  insertRecords,
  isDirty,
  moveColumn,
  moveRecords,
  recordValues,
  setCells,
  type CellEdit,
  type CsvDoc,
} from "./csv/document";
import { columnMapping, computeChanges, type ChangeSummary } from "./editor/changes";
import type { Match } from "./editor/findReplace";
import { editorReducer, initialEditorState } from "./editor/history";
import { computeViewRows, EMPTY_VIEW, isViewFiltered, sortSnapshot, type ViewOptions } from "./editor/viewRows";
import { pickImagesByInput } from "./fs/fallback";
import { assetsDirFor, ImageStore } from "./fs/imageStore";
import { analyze, nextId, referencedImages, type Issue } from "./rules/analysis";
import { findColumn, headersOf, parseRuleOverride, resolveRules, type RuleOverride } from "./rules/detect";
import { cellLines } from "./rules/tokens";
import { NotFoundError, dirOf, joinPath, type SaveResult, type StorageBackend, type TreeEntry } from "./storage/types";
import { GuideDialog, Lightbox, PromptDialog, ShortcutsDialog, type PromptRequest } from "./ui/Dialogs";
import { buildTree, FileTree, type TreeNode } from "./ui/FileTree";
import { FindBar } from "./ui/FindBar";
import { emptySelection, Grid, selectionRect } from "./ui/Grid";
import { Icon } from "./ui/icons";
import { Menu, type MenuItem } from "./ui/Menu";
import { SidePanel, type PanelTab } from "./ui/SidePanel";
import { badgeColors, uiColors, type ThemeMode } from "./ui/theme";
import { LayoutCache, type ViewContext } from "./ui/view";

export interface EditorProps {
  /** Where files come from. Null shows `emptyState`. */
  backend: StorageBackend | null;
  /** File to open first (path from the backend root). */
  file?: string;
  /** Open the first CSV of the tree when no `file` is given (standalone app). */
  openFirst?: boolean;
  /** Name shown at the top of the file tree. */
  rootName?: string;
  /** Forces read-only, on top of the backend's capabilities. */
  readOnly?: boolean;
  theme: ThemeMode;
  /**
   * Embedded in another page: shortcuts only work while focus is inside the
   * editor, and nothing on the page (title, unload prompt) is touched.
   */
  embedded?: boolean;
  /** Shown at the left of the toolbar (e.g. the standalone app's open buttons). */
  toolbarStart?: ReactNode;
  /** Shown instead of the grid when there is no backend. */
  emptyState?: ReactNode;
  onToggleTheme?(): void;
  onDirtyChange?(dirty: boolean): void;
  onFileChange?(path: string | null): void;
  onSaved?(result: Extract<SaveResult, { ok: true }>): void;
  onError?(error: { code: string; message: string }): void;
}

export interface EditorHandle {
  isDirty(): boolean;
  /** Saves now. Resolves to false when nothing was saved (cancelled, conflict, error). */
  save(): Promise<boolean>;
  open(path: string): Promise<void>;
  currentPath(): string | null;
}

interface OpenFile {
  path: string;
  name: string;
  version: string;
  /** Changes on every (re)load so derived state resets. */
  loadId: number;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

type MenuState = { x: number; y: number; items: MenuItem[] };
type Conflict = Extract<SaveResult, { conflict: unknown }>["conflict"];

const EMPTY_DOC = docFromText("");
const AUTOSAVE_MS = 2000;
const OVERRIDE_FILE = ".csvview.json";

function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preference is just not remembered */
  }
}

const isCsvPath = (path: string) => /\.(csv|tsv)$/i.test(path);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const normalizeHeader = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();

/** The first CSV in tree order (folders before files), like the tree shows it. */
function firstCsv(node: TreeNode): string | null {
  for (const c of node.children ?? []) {
    if (c.kind === "file") return c.path;
    const f = firstCsv(c);
    if (f) return f;
  }
  return null;
}

let loadCounter = 0;
let toastCounter = 0;

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const { backend, theme: mode, embedded = false } = props;
  const caps = backend?.capabilities;
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [file, setFileState] = useState<OpenFile | null>(null);
  const [state, dispatch] = useReducer(editorReducer, initialEditorState(EMPTY_DOC));
  const [override, setOverride] = useState<{ rules?: RuleOverride; path?: string; error?: string }>({});
  const [presetChoice, setPresetChoice] = useState("auto");
  const [view, setView] = useState<ViewOptions>(EMPTY_VIEW);
  const [sortInfo, setSortInfo] = useState<{ col: number; desc: boolean } | null>(null);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [panel, setPanel] = useState<PanelTab | null>(() => storageGet<PanelTab | null>("csv4test:panel", "issues"));
  const [showTree, setShowTree] = useState(true);
  const [find, setFind] = useState<{ open: boolean; replace: boolean }>({ open: false, replace: false });
  const [matches, setMatches] = useState<Match[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [help, setHelp] = useState<"shortcuts" | "guide" | null>(null);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [externalChange, setExternalChange] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [widthsByHeader, setWidthsByHeader] = useState<Record<string, number>>({});
  const [imageIssues, setImageIssues] = useState<Issue[]>([]);
  const [imageTick, setImageTick] = useState(0);
  const [extraVariables, setExtraVariables] = useState<string[]>([]);
  const gridRef = useRef<DataEditorRef>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const fileRef = useRef<OpenFile | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const setFile = useCallback((update: OpenFile | null | ((f: OpenFile | null) => OpenFile | null)) => {
    const next = typeof update === "function" ? update(fileRef.current) : update;
    fileRef.current = next;
    setFileState(next);
  }, []);

  const doc = state.doc;
  const dirty = useMemo(() => isDirty(doc), [doc]);
  const lfs = !!file && !!entries?.find((e) => e.path === file.path)?.lfs;
  const readOnly = !!props.readOnly || !!caps?.readOnly || lfs;
  const fixedColumns = !!caps?.fixedColumns;

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastCounter;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);

  const ask = useCallback(
    (title: string, label: string, initial?: string, confirmLabel?: string) =>
      new Promise<string | null>((resolve) => setPrompt({ title, label, initial, confirmLabel, resolve })),
    [],
  );

  // ---- Rules, analysis, view ----------------------------------------------------------

  const headerRecord = doc.records[0];
  const width = columnCount(doc);
  const rules = useMemo(
    () => resolveRules(doc, override.rules, presetChoice === "auto" ? undefined : presetChoice),
    // Inference samples the data once per header change, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headerRecord, width, override.rules, presetChoice, file?.loadId],
  );
  const features = rules.ruleSet.features ?? {};
  const headers = useMemo(() => headersOf(doc), [headerRecord, width]); // eslint-disable-line react-hooks/exhaustive-deps
  const analysis = useMemo(() => analyze(doc, rules), [doc, rules]);
  const rows = useMemo(() => computeViewRows(doc.records, view), [doc.records, view]);
  const changes = useMemo(() => computeChanges(doc), [doc]);
  const columnMap = useMemo(() => columnMapping(doc), [doc]);
  const idCol = findColumn(rules.columns, features.idColumn);
  const imagesCol = findColumn(rules.columns, features.images?.column) ?? rules.columns.find((c) => c.rule.display === "images");
  const labelsCol = rules.columns.find((c) => c.rule.display === "labels");
  const filtered = isViewFiltered(view);

  const readOnlyCols = useMemo(() => {
    const names = new Set((caps?.readOnlyColumns ?? []).map(normalizeHeader));
    return new Set(rules.columns.filter((c) => names.has(normalizeHeader(c.header))).map((c) => c.index));
  }, [caps, rules.columns]);

  const widthKey = file ? `csv4test:widths:${file.path}` : null;
  useEffect(() => {
    setWidthsByHeader(widthKey ? storageGet<Record<string, number>>(widthKey, {}) : {});
  }, [widthKey]);
  const widths = useMemo(
    () => rules.columns.map((c) => widthsByHeader[c.header] ?? c.rule.width ?? 160),
    [rules.columns, widthsByHeader],
  );

  const imageStore = useMemo(() => {
    if (!file || !backend) return null;
    let queued = false;
    return new ImageStore(backend, file.path, () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setImageTick((t) => t + 1);
      });
    });
  }, [file, backend]);
  useEffect(() => () => imageStore?.clear(), [imageStore]);
  const imagesWritable = !!imageStore?.writable && !readOnly;

  const layouts = useMemo(
    () => new LayoutCache(rules.columns, features.caseRef?.pattern, imagesWritable),
    [rules.columns, features.caseRef?.pattern, imagesWritable],
  );

  // Redraw image cells when thumbnails finish loading.
  useEffect(() => {
    if (!imagesCol || imageTick === 0) return;
    gridRef.current?.updateCells(rows.map((_, row) => ({ cell: [imagesCol.index, row] as const })));
  }, [imageTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Missing / unreferenced images (debounced).
  useEffect(() => {
    if (!imageStore?.writable || !imagesCol || !file) {
      setImageIssues([]);
      return;
    }
    const t = setTimeout(() => {
      const issues: Issue[] = [];
      for (const r of doc.records.slice(1)) {
        for (const p of cellLines(cellValue(r, imagesCol.index))) {
          if (/^https?:/i.test(p)) continue;
          if (imageStore.get(p).status === "missing") {
            issues.push({ severity: "warning", recordId: r.id, col: imagesCol.index, message: `画像が見つかりません: ${p}` });
          }
        }
      }
      if (entries) {
        const dir = dirOf(file.path);
        const assetsDir = joinPath(dir, assetsDirFor(features.images?.assetsDir ?? "{name}.assets", file.name));
        const referenced = referencedImages(doc.records, imagesCol.index);
        for (const e of entries) {
          if (!e.path.startsWith(`${assetsDir}/`) || baseName(e.path).startsWith(".")) continue;
          const relative = dir ? e.path.slice(dir.length + 1) : e.path;
          if (!referenced.has(relative)) issues.push({ severity: "warning", message: `どの行からも参照されていない画像: ${relative}` });
        }
      }
      setImageIssues(issues);
    }, 600);
    return () => clearTimeout(t);
  }, [doc.records, imageStore, imagesCol, file, entries, imageTick, features.images?.assetsDir]);

  const issues = useMemo(() => [...analysis.issues, ...imageIssues], [analysis.issues, imageIssues]);

  // ---- Editing ------------------------------------------------------------------------

  /**
   * Every edit goes through here, so read-only files, read-only columns and a
   * fixed column layout are enforced in one place whatever the UI path.
   */
  const apply = useCallback(
    (label: string, update: (d: CsvDoc) => CsvDoc) => {
      if (readOnly) {
        toast("このファイルは読み取り専用です", "error");
        return;
      }
      if (readOnlyCols.size > 0 || fixedColumns) {
        const before = stateRef.current.doc;
        const after = update(before);
        if (after === before) return;
        if (fixedColumns && (columnCount(after) !== columnCount(before) || (after.records[0] && before.records[0] && after.records[0] !== before.records[0]))) {
          toast("このファイルでは列の構成を変更できません", "error");
          return;
        }
        if (readOnlyCols.size > 0) {
          const prev = new Map(before.records.map((r) => [r.id, r]));
          const touched = after.records.some((r) => {
            const old = prev.get(r.id);
            return old !== undefined && old !== r && [...readOnlyCols].some((c) => cellValue(old, c) !== cellValue(r, c));
          });
          if (touched) {
            const names = [...readOnlyCols].map((c) => rules.columns[c]?.header).join(", ");
            toast(`${names} 列は編集できません`, "error");
            return;
          }
        }
      }
      dispatch({ type: "apply", label, update });
    },
    [readOnly, readOnlyCols, fixedColumns, rules.columns, toast],
  );

  // ---- Navigation ----------------------------------------------------------------------

  const pendingJump = useRef<{ recordId: number; col: number } | null>(null);
  const selectCell = useCallback((col: number, row: number) => {
    setSelection({
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
    });
    requestAnimationFrame(() => {
      gridRef.current?.scrollTo(col, row, "both", 0, 0, { vAlign: "center" });
      gridRef.current?.focus();
    });
  }, []);

  const jumpTo = useCallback(
    (recordId: number, col = idCol?.index ?? 0) => {
      const row = rows.findIndex((r) => r.id === recordId);
      if (row >= 0) {
        selectCell(col, row);
        return;
      }
      // Hidden by a filter: clear filters, then jump once the rows update.
      pendingJump.current = { recordId, col };
      setView((v) => ({ ...EMPTY_VIEW, sortOrder: v.sortOrder }));
    },
    [rows, idCol, selectCell],
  );
  useEffect(() => {
    const p = pendingJump.current;
    if (!p) return;
    pendingJump.current = null;
    const row = rows.findIndex((r) => r.id === p.recordId);
    if (row >= 0) selectCell(p.col, row);
  }, [rows, selectCell]);

  const describeRecord = useCallback(
    (recordId: number) => {
      const index = doc.records.findIndex((r) => r.id === recordId);
      if (idCol && index > 0) {
        const id = cellValue(doc.records[index], idCol.index);
        if (id) return rules.columns[idCol.index].rule.format?.replace("{value}", id) ?? id;
      }
      return index > 0 ? `${index}行目` : "（削除済み）";
    },
    [doc.records, idCol, rules.columns],
  );

  // ---- Row / column operations -------------------------------------------------------

  const prepareNewRows = useCallback(
    (d: CsvDoc, newRows: string[][]) => {
      // A read-only ID column is filled in by the backend on save.
      if (!idCol || readOnlyCols.has(idCol.index)) return newRows;
      let next = Number(nextId(d, idCol.index));
      return newRows.map((r) => {
        if (r[idCol.index]?.trim()) return r;
        const copy = r.slice();
        copy[idCol.index] = String(next++);
        return copy;
      });
    },
    [idCol, readOnlyCols],
  );

  const selectedRecordIds = useCallback((): number[] => {
    const fromRows = selection.rows.toArray();
    if (fromRows.length > 0) return fromRows.map((i) => rows[i]?.id).filter((x): x is number => x !== undefined);
    const rect = selectionRect(selection, rows.length, rules.columns.length);
    if (!rect) return [];
    return rows.slice(rect.y, rect.y + rect.height).map((r) => r.id);
  }, [selection, rows, rules.columns.length]);

  const insertRowsAt = useCallback(
    (anchorRecordId: number | null, below: boolean, count = 1) => {
      apply(count > 1 ? `${count}行を挿入` : "行を挿入", (d) => {
        const at = anchorRecordId === null ? d.records.length : d.records.findIndex((r) => r.id === anchorRecordId) + (below ? 1 : 0);
        const blank = Array.from({ length: count }, () => Array<string>(columnCount(d)).fill(""));
        return insertRecords(d, Math.max(1, at), prepareNewRows(d, blank)).doc;
      });
    },
    [apply, prepareNewRows],
  );

  const duplicateRows = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      apply(`${ids.length}行を複製`, (d) => {
        const set = new Set(ids);
        const source = d.records.filter((r) => set.has(r.id));
        const last = d.records.findIndex((r) => r.id === source[source.length - 1].id);
        const copies = source.map((r) => {
          const v = recordValues(r);
          if (idCol) v[idCol.index] = "";
          return v;
        });
        return insertRecords(d, last + 1, prepareNewRows(d, copies)).doc;
      });
    },
    [apply, idCol, prepareNewRows],
  );

  const deleteRows = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      apply(`${ids.length}行を削除`, (d) => deleteRecords(d, ids));
      setSelection(emptySelection);
    },
    [apply],
  );

  const moveRow = useCallback(
    (from: number, to: number) => {
      const record = rows[from];
      if (!record || filtered || view.sortOrder) return;
      apply("行を移動", (d) => moveRecords(d, [record.id], to + 1));
      // Glide leaves the row number it was dragged from selected; follow the moved row instead.
      setSelection({ ...emptySelection, rows: CompactSelection.fromSingleSelection(to) });
    },
    [rows, filtered, view.sortOrder, apply],
  );

  const addColumn = useCallback(
    async (at: number) => {
      const name = await ask("列を挿入", "列名", "", "挿入");
      if (name === null) return;
      apply(`列「${name}」を挿入`, (d) => insertColumn(d, at, name));
    },
    [ask, apply],
  );

  const addOptionalColumn = useCallback(
    (name: string) => {
      const def = features.optionalColumns?.find((c) => c.name === name);
      const after = findColumn(rules.columns, def?.after);
      apply(`${name}列を追加`, (d) => insertColumn(d, after ? after.index + 1 : columnCount(d), name));
    },
    [features.optionalColumns, rules.columns, apply],
  );

  const missingOptional = useMemo(
    () =>
      readOnly || fixedColumns ? [] : (features.optionalColumns ?? []).filter((c) => !findColumn(rules.columns, c.name)).map((c) => c.name),
    [features.optionalColumns, rules.columns, readOnly, fixedColumns],
  );

  const sortBy = useCallback(
    (col: number, desc: boolean) => {
      setView((v) => ({ ...v, sortOrder: sortSnapshot(doc.records, col, desc) }));
      setSortInfo({ col, desc });
    },
    [doc.records],
  );
  const clearSort = useCallback(() => {
    setView((v) => ({ ...v, sortOrder: null }));
    setSortInfo(null);
  }, []);

  const filterColumn = useCallback(
    async (col: number) => {
      const current = view.filters.find((f) => f.col === col)?.text ?? "";
      const text = await ask(`「${headers[col] || `列 ${col + 1}`}」で絞り込み`, "含む文字列（空欄で解除）", current, "絞り込む");
      if (text === null) return;
      setView((v) => ({ ...v, filters: [...v.filters.filter((f) => f.col !== col), { col, text }] }));
    },
    [view.filters, headers, ask],
  );

  const openHeaderMenu = useCallback(
    (col: number, bounds: Rectangle) => {
      const name = headers[col] || `列 ${col + 1}`;
      const hasFilter = view.filters.some((f) => f.col === col && f.text !== "");
      const canEditColumns = !readOnly && !fixedColumns;
      setMenu({
        x: bounds.x,
        y: bounds.y + bounds.height,
        items: [
          { label: "昇順で並べ替え（表示のみ）", onClick: () => sortBy(col, false), checked: sortInfo?.col === col && !sortInfo.desc },
          { label: "降順で並べ替え（表示のみ）", onClick: () => sortBy(col, true), checked: sortInfo?.col === col && sortInfo.desc },
          { label: "並べ替えを解除（ファイルの順序）", onClick: clearSort, disabled: !sortInfo },
          "separator",
          { label: hasFilter ? "絞り込み条件を変更…" : "この列で絞り込み…", onClick: () => void filterColumn(col), checked: hasFilter },
          ...(hasFilter
            ? [{ label: "この列の絞り込みを解除", onClick: () => setView((v) => ({ ...v, filters: v.filters.filter((f) => f.col !== col) })) }]
            : []),
          ...(canEditColumns
            ? ([
                "separator",
                { label: "左に列を挿入…", onClick: () => void addColumn(col) },
                { label: "右に列を挿入…", onClick: () => void addColumn(col + 1) },
                {
                  label: "列名を変更…",
                  onClick: async () => {
                    const v = await ask("列名を変更", "新しい列名", headers[col], "変更");
                    if (v !== null && headerRecord) apply("列名を変更", (d) => setCells(d, [{ recordId: d.records[0].id, col, value: v }]));
                  },
                },
                "separator",
                {
                  label: `列「${name}」を削除`,
                  danger: true,
                  onClick: () => {
                    if (window.confirm(`列「${name}」を削除しますか？（元に戻すで復元できます）`)) apply(`列「${name}」を削除`, (d) => deleteColumn(d, col));
                  },
                },
              ] as MenuItem[])
            : []),
        ],
      });
    },
    [headers, view.filters, sortInfo, sortBy, clearSort, filterColumn, addColumn, ask, apply, headerRecord, readOnly, fixedColumns],
  );

  const openCellMenu = useCallback(
    (row: number, col: number, x: number, y: number) => {
      const record = rows[row];
      if (!record) return;
      const inSelection = selectedRecordIds().includes(record.id);
      if (!inSelection) selectCell(col, row);
      const ids = inSelection ? selectedRecordIds() : [record.id];
      const n = ids.length;
      const copy: MenuItem = { label: "コピー", shortcut: "Ctrl+C", onClick: () => document.execCommand("copy") };
      setMenu({
        x,
        y,
        items: readOnly
          ? [copy]
          : [
              { label: "上に行を挿入", onClick: () => insertRowsAt(ids[0], false, 1) },
              { label: "下に行を挿入", shortcut: "Ctrl+Shift++", onClick: () => insertRowsAt(ids[n - 1], true, 1) },
              { label: n > 1 ? `${n}行を複製` : "行を複製", onClick: () => duplicateRows(ids) },
              "separator",
              copy,
              { label: "切り取り", shortcut: "Ctrl+X", onClick: () => document.execCommand("cut") },
              {
                label: "貼り付け",
                shortcut: "Ctrl+V",
                onClick: () => toast("貼り付けは Ctrl+V を使ってください（ブラウザの制限により、メニューからは貼り付けできません）"),
              },
              "separator",
              { label: n > 1 ? `${n}行を削除` : "行を削除", shortcut: "Ctrl+-", danger: true, onClick: () => deleteRows(ids) },
            ],
      });
    },
    [rows, selectedRecordIds, selectCell, insertRowsAt, duplicateRows, deleteRows, toast, readOnly],
  );

  // ---- Images -------------------------------------------------------------------------

  const addImageFiles = useCallback(
    async (recordId: number, files: File[]) => {
      if (!imageStore || !imagesWritable || !imagesCol || !file) {
        toast(
          readOnly
            ? "このファイルは読み取り専用です"
            : caps?.tree
              ? "このファイルには画像を追加できません"
              : "画像を追加するには、CSVのあるフォルダを「フォルダを開く」で開いてください",
          "error",
        );
        return;
      }
      const record = doc.records.find((r) => r.id === recordId);
      if (!record) return;
      const assetsDir = assetsDirFor(features.images?.assetsDir ?? "{name}.assets", file.name);
      const id = idCol ? cellValue(record, idCol.index).trim() : "";
      const base = id ? `case-${id}` : `row-${doc.records.indexOf(record)}`;
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await imageStore.add(f, assetsDir, base));
        const dir = dirOf(file.path);
        setEntries((prev) => (prev ? [...prev, ...paths.map((p) => ({ path: joinPath(dir, p) }))] : prev));
        apply(paths.length > 1 ? `画像を${paths.length}枚追加` : "画像を追加", (d) => {
          const current = d.records.find((r) => r.id === recordId);
          const lines = cellLines(cellValue(current, imagesCol.index));
          return setCells(d, [{ recordId, col: imagesCol.index, value: [...lines, ...paths].join("\n") }]);
        });
        toast(`${paths.join(", ")} を保存しました`);
      } catch (e) {
        toast(`画像を追加できませんでした: ${(e as Error).message}`, "error");
      }
    },
    [imageStore, imagesWritable, imagesCol, file, doc.records, features.images?.assetsDir, idCol, apply, toast, readOnly, caps],
  );

  const openImage = useCallback(
    (recordId: number, path: string) => {
      if (!imagesCol) return;
      const record = doc.records.find((r) => r.id === recordId);
      const paths = cellLines(cellValue(record, imagesCol.index));
      setLightbox({ paths, index: Math.max(0, paths.indexOf(path)) });
    },
    [doc.records, imagesCol],
  );

  // ---- View context for the canvas renderer ---------------------------------------------

  const variableNames = useMemo(() => {
    const names = analysis.variables.map((v) => v.name);
    return [...names, ...extraVariables.filter((v) => !names.includes(v))];
  }, [analysis.variables, extraVariables]);

  const viewCtx: ViewContext = {
    mode,
    columns: rules.columns,
    features,
    labelColors: rules.ruleSet.labelColors ?? {},
    idToRecord: analysis.idToRecord,
    originals: doc.originals,
    columnMap,
    images: imageStore,
    variables: variableNames,
    labels: analysis.labels,
    layouts,
    onJump: (ref) => {
      const recordId = analysis.idToRecord.get(ref);
      if (recordId !== undefined) jumpTo(recordId);
    },
    onOpenImage: openImage,
    onAddImage: (recordId) =>
      void pickImagesByInput().then((files) => {
        if (files.length > 0) void addImageFiles(recordId, files);
      }),
  };

  // ---- Files --------------------------------------------------------------------------

  const findOverride = useCallback(async (path: string): Promise<{ text: string; path: string } | null> => {
    const b = backendRef.current;
    if (!b) return null;
    const known = entriesRef.current ? new Set(entriesRef.current.map((e) => e.path)) : null;
    const segs = dirOf(path).split("/").filter(Boolean);
    for (let i = segs.length; i >= 0; i--) {
      const candidate = joinPath(...segs.slice(0, i), OVERRIDE_FILE);
      if (known && !known.has(candidate)) continue;
      try {
        const { bytes } = await b.read(candidate);
        return { text: new TextDecoder().decode(bytes), path: candidate };
      } catch (e) {
        if (!(e instanceof NotFoundError) && known) throw e;
      }
    }
    return null;
  }, []);

  const loadDoc = useCallback(
    async (path: string, bytes: Uint8Array, version: string) => {
      let next: CsvDoc;
      try {
        next = docFromBytes(bytes, path.toLowerCase().endsWith(".tsv") ? "\t" : undefined);
      } catch (e) {
        toast(`読み込めませんでした: ${(e as Error).message}`, "error");
        return;
      }
      dispatch({ type: "load", doc: next });
      setFile({ path, name: baseName(path), version, loadId: ++loadCounter });
      setView(EMPTY_VIEW);
      setSortInfo(null);
      setSelection(emptySelection);
      setExternalChange(false);
      setConflict(null);
      setLightbox(null);
      backendRef.current?.watch?.(path, version);
      try {
        const found = await findOverride(path);
        setOverride(found ? { rules: parseRuleOverride(found.text), path: found.path } : {});
      } catch (e) {
        setOverride({ error: (e as Error).message });
      }
    },
    [toast, setFile, findOverride],
  );

  const confirmDiscard = useCallback(
    () => !isDirty(stateRef.current.doc) || window.confirm("保存していない変更があります。破棄して続けますか？"),
    [],
  );

  const openPath = useCallback(
    async (path: string, force = false) => {
      const b = backendRef.current;
      if (!b) return;
      if (!force && fileRef.current?.path === path) return;
      if (!force && !confirmDiscard()) return;
      try {
        const { bytes, version } = await b.read(path);
        await loadDoc(path, bytes, version);
      } catch (e) {
        toast(`開けませんでした: ${(e as Error).message}`, "error");
      }
    },
    [confirmDiscard, loadDoc, toast],
  );

  const reload = useCallback(async () => {
    const f = fileRef.current;
    if (f) await openPath(f.path, true);
  }, [openPath]);

  const refreshTree = useCallback(async () => {
    const b = backendRef.current;
    if (b?.capabilities.tree && b.listTree) setEntries(await b.listTree());
  }, []);

  // A new backend starts from scratch: list its files and open the first one.
  useEffect(() => {
    dispatch({ type: "load", doc: EMPTY_DOC });
    setFile(null);
    setEntries(null);
    setOverride({});
    setExtraVariables([]);
    if (!backend) return;
    let cancelled = false;
    void (async () => {
      let list: TreeEntry[] | null = null;
      if (backend.capabilities.tree && backend.listTree) {
        try {
          list = await backend.listTree();
        } catch (e) {
          toast(`ファイル一覧を取得できませんでした: ${(e as Error).message}`, "error");
        }
        if (cancelled) return;
        setEntries(list);
        entriesRef.current = list;
      }
      const initial = props.file ?? (props.openFirst && list ? firstCsv(buildTree("", list.map((e) => e.path).filter(isCsvPath))) : null);
      if (initial) await openPath(initial, true);
      else if (props.openFirst && list) toast("このフォルダにはCSVファイルがありません");
    })();
    void backend.variables?.().then(
      (vars) => !cancelled && setExtraVariables(vars.map((v) => v.name)),
      () => undefined,
    );
    const unsubscribe = backend.onExternalChange?.((paths) => {
      const f = fileRef.current;
      if (!f || !paths.includes(f.path) || savingRef.current) return;
      if (!isDirty(stateRef.current.doc)) {
        void reload().then(() => toast("ファイルが外部で変更されたため、再読み込みしました"));
      } else {
        setExternalChange(true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The edit, per record, for backends that store rows (header excluded). */
  const recordChanges = useCallback((snapshot: CsvDoc, path: string) => {
    const header = snapshot.records[0];
    const summary: ChangeSummary = computeChanges(snapshot);
    return {
      path,
      changes: summary.changes.filter((c) => c.record.id !== header?.id),
      order: snapshot.records.slice(1).map((r) => r.id),
      headers: headersOf(snapshot),
    };
  }, []);

  const defaultMessage = useCallback(
    (summary: ChangeSummary, name: string) => {
      const parts: string[] = [];
      const label = (id: number) => describeRecord(id);
      const modified = summary.changes.filter((c) => c.kind === "modified" && c.index > 0);
      const added = summary.changes.filter((c) => c.kind === "added");
      const removed = summary.changes.filter((c) => c.kind === "removed");
      if (modified.length > 0) parts.push(`${modified.slice(0, 5).map((c) => label(c.record.id)).join(", ")}${modified.length > 5 ? " ほか" : ""} を更新`);
      if (added.length > 0) parts.push(`${added.length}行を追加`);
      if (removed.length > 0) parts.push(`${removed.length}行を削除`);
      if (summary.reordered) parts.push("行を並べ替え");
      return `${name}: ${parts.join("、") || "更新"}`;
    },
    [describeRecord],
  );

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      const b = backendRef.current;
      const f = fileRef.current;
      if (!b || !f || savingRef.current || readOnly) return false;
      const snapshot = stateRef.current.doc;
      if (!isDirty(snapshot) && !force && !b.capabilities.download) return true;
      let message: string | undefined;
      if (b.capabilities.commitMessage) {
        const answer = await ask("変更をコミット", "コミットメッセージ", defaultMessage(computeChanges(snapshot), f.name), "コミット");
        if (answer === null || answer.trim() === "") return false;
        message = answer.trim();
      }
      savingRef.current = true;
      setSaving(true);
      try {
        const bytes = await docToBytes(snapshot);
        const result = await b.save({
          files: [{ path: f.path, op: "put", bytes, baseVersion: f.version }],
          records: recordChanges(snapshot, f.path),
          message,
          force,
        });
        if (result.ok) {
          const snapshotHeaders = headersOf(snapshot);
          const assigned: CellEdit[] = [];
          for (const [id, values] of Object.entries(result.assigned ?? {})) {
            for (const [header, value] of Object.entries(values)) {
              const col = snapshotHeaders.findIndex((h) => normalizeHeader(h) === normalizeHeader(header));
              if (col >= 0) assigned.push({ recordId: Number(id), col, value });
            }
          }
          dispatch({ type: "saved", doc: snapshot, assigned });
          const version = result.versions[f.path] ?? f.version;
          setFile((cur) => (cur && cur.path === f.path ? { ...cur, version } : cur));
          b.watch?.(f.path, version);
          setExternalChange(false);
          setConflict(null);
          if (!b.capabilities.autosave) {
            toast(result.message ?? (b.capabilities.download ? `${f.name} をダウンロードしました` : `${f.path} を保存しました`));
          }
          props.onSaved?.(result);
          return true;
        }
        if ("conflict" in result) {
          setConflict(result.conflict);
          return false;
        }
        toast(`保存できませんでした: ${result.error.message}`, "error");
        props.onError?.(result.error);
        return false;
      } catch (e) {
        const message = (e as Error).message;
        toast(`保存できませんでした: ${message}`, "error");
        props.onError?.({ code: "exception", message });
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [readOnly, ask, defaultMessage, recordChanges, setFile, toast, props.onSaved, props.onError], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // Autosave a little after the last edit.
  useEffect(() => {
    if (!caps?.autosave || !dirty || conflict || readOnly || saving) return;
    const t = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [caps, doc, dirty, conflict, readOnly, saving]);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => isDirty(stateRef.current.doc),
      save: () => saveRef.current(),
      open: (path: string) => openPath(path),
      currentPath: () => fileRef.current?.path ?? null,
    }),
    [openPath],
  );

  useEffect(() => props.onDirtyChange?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => props.onFileChange?.(file?.path ?? null), [file?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => storageSet("csv4test:panel", panel), [panel]);

  // Glide renders cell editors into #portal; make sure it exists and is styled like the editor.
  useEffect(() => {
    let portal = document.getElementById("portal");
    if (!portal) {
      portal = document.createElement("div");
      portal.id = "portal";
      document.body.appendChild(portal);
    }
    portal.classList.add("c4t", "c4t-portal");
    portal.dataset.theme = mode;
  }, [mode]);

  // Test seam for E2E (dev server only).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __csv4test?: Record<string, unknown> };
    w.__csv4test = {
      ...w.__csv4test,
      getBounds: (col: number, row: number) => gridRef.current?.getBounds(col, row),
      scrollTo: (col: number, row: number) => gridRef.current?.scrollTo(col, row),
      text: () => stateRef.current.doc.records.map((r) => r.fields.map((f) => f.value)),
      selected: () => selection.current?.cell,
      selectedRows: () => selection.rows.toArray(),
    };
  });

  // ---- Keyboard shortcuts ---------------------------------------------------------------

  useEffect(() => {
    const target: HTMLElement | Window | null = embedded ? rootRef.current : window;
    if (!target) return;
    const onKey = (event: Event) => {
      const e = event as KeyboardEvent;
      const mod = e.ctrlKey || e.metaKey;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        void save();
        return;
      }
      // Help works before a file is open too.
      if (!typing && (e.key === "?" || e.key === "F1")) {
        e.preventDefault();
        setHelp(e.key === "F1" ? "guide" : "shortcuts");
        return;
      }
      if (!fileRef.current) return;
      if (mod && (key === "f" || key === "h")) {
        e.preventDefault();
        setFind({ open: true, replace: key === "h" && !readOnly });
        return;
      }
      if (typing) return;
      if (mod && !e.shiftKey && key === "z") {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if (mod && (key === "y" || (e.shiftKey && key === "z"))) {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (mod && e.shiftKey && (e.key === "+" || e.key === "=" || e.code === "Semicolon")) {
        e.preventDefault();
        const ids = selectedRecordIds();
        insertRowsAt(ids.length > 0 ? ids[ids.length - 1] : null, true);
      } else if (mod && (e.key === "-" || e.code === "Minus")) {
        e.preventDefault();
        deleteRows(selectedRecordIds());
      }
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }, [embedded, save, selectedRecordIds, insertRowsAt, deleteRows, readOnly]);

  // ---- Render -------------------------------------------------------------------------

  const highlights = useMemo(() => {
    if (matches.length === 0) return undefined;
    const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
    const color = mode === "dark" ? "rgba(250, 204, 21, 0.22)" : "rgba(250, 204, 21, 0.35)";
    return matches.slice(0, 2000).flatMap((m) => {
      const y = rowIndex.get(m.recordId);
      return y === undefined ? [] : [{ color, range: { x: m.col, y, width: 1, height: 1 }, style: "no-outline" as const }];
    });
  }, [matches, rows, mode]);

  const labelList = useMemo(() => {
    if (!labelsCol) return [];
    const counts = new Map<string, number>();
    for (const r of doc.records.slice(1)) for (const l of cellLines(cellValue(r, labelsCol.index))) counts.set(l, (counts.get(l) ?? 0) + 1);
    return analysis.labels.map((name) => ({
      name,
      count: counts.get(name) ?? 0,
      color: badgeColors(mode, rules.ruleSet.labelColors?.[name], name),
    }));
  }, [labelsCol, doc.records, analysis.labels, mode, rules.ruleSet.labelColors]);

  const lightboxImages = useMemo(
    () =>
      lightbox?.paths.map((path) => {
        const e = imageStore?.get(path);
        return { path, url: e?.url, status: e?.status ?? "unavailable" };
      }) ?? [],
    [lightbox, imageStore, imageTick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const tree = useMemo(
    () => (entries ? buildTree(props.rootName ?? "", entries.map((e) => e.path).filter(isCsvPath)) : null),
    [entries, props.rootName],
  );

  const activeFilters = [
    ...view.filters.filter((f) => f.text !== "").map((f) => ({ key: `f${f.col}`, label: `${headers[f.col] || `列 ${f.col + 1}`}: ${f.text}`, clear: () => setView((v) => ({ ...v, filters: v.filters.filter((x) => x.col !== f.col) })) })),
    ...view.labels.map((l) => ({ key: `l${l}`, label: `ラベル: ${l}`, clear: () => setView((v) => ({ ...v, labels: v.labels.filter((x) => x !== l) })) })),
    ...(sortInfo ? [{ key: "sort", label: `並べ替え: ${headers[sortInfo.col]} ${sortInfo.desc ? "↓" : "↑"}`, clear: clearSort }] : []),
  ];

  const ui = uiColors(mode);
  const saveLabel = caps?.download ? "ダウンロード" : caps?.commitMessage ? "コミット" : "保存";
  const changeCount = changes.changes.length + (changes.reordered ? 1 : 0);
  const saveState = saving ? "保存中…" : conflict ? "競合あり" : dirty ? "未保存" : "保存済み";

  return (
    <div className="c4t app" data-theme={mode} ref={rootRef} tabIndex={embedded ? -1 : undefined}>
      <header className="toolbar">
        {props.toolbarStart}
        <div className="toolbar-group">
          {caps?.autosave ? (
            <span className={`save-state${dirty || conflict ? " pending" : ""}`} role="status">
              {file ? saveState : ""}
            </span>
          ) : (
            <button
              className={dirty ? "primary" : undefined}
              onClick={() => void save()}
              disabled={!file || readOnly || saving}
              title={`${saveLabel} (Ctrl+S)`}
            >
              <Icon name={caps?.download ? "download" : "save"} />
              <span className="label">{saveLabel}</span>
              {dirty && <span className="badge">{changeCount}</span>}
            </button>
          )}
        </div>
        <div className="toolbar-group">
          <button className="icon-button" onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0} title="元に戻す (Ctrl+Z)" aria-label="元に戻す">
            <Icon name="undo" />
          </button>
          <button className="icon-button" onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0} title="やり直す (Ctrl+Y)" aria-label="やり直す">
            <Icon name="redo" />
          </button>
          {missingOptional.map((name) => (
            <button key={name} onClick={() => addOptionalColumn(name)} disabled={!file} title={`KATATAN形式の ${name} 列を追加`}>
              <Icon name={name === "Images" ? "image" : "tag"} />
              <span className="label">{name}列を追加</span>
            </button>
          ))}
        </div>
        <div className="toolbar-search">
          <Icon name="filter" size={14} />
          <input
            value={view.quick}
            onChange={(e) => setView((v) => ({ ...v, quick: e.target.value }))}
            placeholder="行を絞り込み…"
            aria-label="行を絞り込み"
            disabled={!file}
          />
          {view.quick && (
            <button className="icon-button" onClick={() => setView((v) => ({ ...v, quick: "" }))} aria-label="絞り込みを解除">
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        <div className="toolbar-group right">
          <button className="icon-button" onClick={() => setFind({ open: true, replace: false })} disabled={!file} title="検索と置換 (Ctrl+F)" aria-label="検索と置換">
            <Icon name="search" />
          </button>
          {tree && (
            <button className={`icon-button${showTree ? " on" : ""}`} onClick={() => setShowTree(!showTree)} title="ファイル一覧" aria-label="ファイル一覧の表示切り替え" aria-pressed={showTree}>
              <Icon name="tree" />
            </button>
          )}
          <button className={`icon-button${panel ? " on" : ""}`} onClick={() => setPanel(panel ? null : "issues")} title="サイドパネル" aria-label="サイドパネルの表示切り替え" aria-pressed={!!panel}>
            <Icon name="sidebar" />
          </button>
          {props.onToggleTheme && (
            <button className="icon-button" onClick={props.onToggleTheme} title="テーマ切り替え" aria-label="ライト/ダークを切り替え">
              <Icon name={mode === "dark" ? "sun" : "moon"} />
            </button>
          )}
          <button className="icon-button" onClick={() => setHelp("shortcuts")} title="キーボードショートカット (?)" aria-label="キーボードショートカット">
            <Icon name="keyboard" />
          </button>
          <button className="icon-button" onClick={() => setHelp("guide")} title="ヘルプ (F1)" aria-label="ヘルプ">
            <Icon name="help" />
          </button>
        </div>
      </header>

      {conflict && (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <span>
            保存できませんでした。{conflict.message ?? "ほかの人が先に変更しています。"}
            {conflict.records && conflict.records.length > 0 && `（${conflict.records.map((r) => describeRecord(r.id)).join(", ")}）`}
          </span>
          <button onClick={() => window.confirm("自分の変更を破棄して、最新の内容を読み込みますか？") && void reload()}>最新を読み込む（変更を破棄）</button>
          <button onClick={() => void save(true)}>上書きして保存</button>
          <button onClick={() => setConflict(null)}>閉じる</button>
        </div>
      )}

      {externalChange && !conflict && (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <span>ファイルが外部で変更されました（git pull / checkout など）。未保存の変更があります。</span>
          <button onClick={() => window.confirm("未保存の変更を破棄して、最新の内容を読み込みますか？") && void reload()}>再読み込み（変更を破棄）</button>
          <button onClick={() => setExternalChange(false)}>このまま編集を続ける</button>
        </div>
      )}

      <div className="workspace">
        {tree && showTree && (
          <FileTree tree={tree} activePath={file?.path ?? null} dirty={dirty} onOpen={(p) => void openPath(p)} onRefresh={() => void refreshTree()} />
        )}
        <main className="main">
          {file ? (
            <>
              {find.open && (
                <FindBar
                  rows={rows}
                  colCount={rules.columns.length}
                  headers={headers}
                  replaceMode={find.replace && !readOnly}
                  onReplaceMode={(replace) => setFind({ open: true, replace: replace && !readOnly })}
                  onJump={(m) => jumpTo(m.recordId, m.col)}
                  onReplace={(edits: CellEdit[], label) => apply(label, (d) => setCells(d, edits))}
                  onMatches={setMatches}
                  onClose={() => {
                    setFind({ open: false, replace: false });
                    gridRef.current?.focus();
                  }}
                />
              )}
              {activeFilters.length > 0 && (
                <div className="filter-bar">
                  <span>
                    {rows.length} / {doc.records.length - 1} 行を表示
                  </span>
                  {activeFilters.map((f) => (
                    <span key={f.key} className="filter-chip">
                      {f.label}
                      <button onClick={f.clear} aria-label={`${f.label} を解除`}>
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  ))}
                  <button
                    className="link"
                    onClick={() => {
                      setView(EMPTY_VIEW);
                      setSortInfo(null);
                    }}
                  >
                    すべて解除
                  </button>
                </div>
              )}
              {doc.records.length === 0 ? (
                <div className="empty-file">
                  <p>このファイルは空です。</p>
                  {!readOnly && (
                    <button
                      onClick={() =>
                        apply("ヘッダーを作成", (d) => {
                          // KATATAN files use a BOM and CRLF records.
                          const withLayout = { ...d, layout: { ...d.layout, bom: true, eol: "\r\n", trailingEol: true } };
                          return insertRecords(withLayout, 0, [["No", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes"]]).doc;
                        })
                      }
                    >
                      KATATAN形式のヘッダーを作成
                    </button>
                  )}
                </div>
              ) : (
                <Grid
                  doc={doc}
                  rows={rows}
                  rules={rules}
                  view={viewCtx}
                  widths={widths}
                  mode={mode}
                  selection={selection}
                  onSelectionChange={setSelection}
                  canMoveRows={!filtered && !view.sortOrder}
                  canExtend={!filtered && !readOnly}
                  readOnly={readOnly}
                  readOnlyCols={readOnlyCols}
                  canEditColumns={!fixedColumns}
                  highlights={highlights}
                  apply={apply}
                  onInsertRow={(row, below) => {
                    const record = rows[row];
                    if (record) insertRowsAt(record.id, below);
                  }}
                  onInsertColumn={(at) => void addColumn(at)}
                  onMoveRow={moveRow}
                  onMoveColumn={(from, to) => apply("列を移動", (d) => moveColumn(d, from, to))}
                  onColumnResize={(col, w) => {
                    const header = rules.columns[col]?.header;
                    if (header === undefined) return;
                    setWidthsByHeader((prev) => {
                      const next = { ...prev, [header]: Math.round(w) };
                      if (widthKey) storageSet(widthKey, next);
                      return next;
                    });
                  }}
                  onHeaderMenu={openHeaderMenu}
                  onCellMenu={openCellMenu}
                  onImageFiles={(id, files) => void addImageFiles(id, files)}
                  gridRef={gridRef}
                />
              )}
            </>
          ) : backend && tree ? (
            <div className="welcome">
              <p className="muted">左の一覧からCSVファイルを選んでください。</p>
            </div>
          ) : (
            props.emptyState
          )}
        </main>
        {file && panel && (
          <SidePanel
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            issues={issues}
            variables={analysis.variables}
            labels={labelList}
            activeLabels={view.labels}
            onToggleLabel={(name) =>
              setView((v) => ({
                ...v,
                labelCol: labelsCol?.index ?? null,
                labels: v.labels.includes(name) ? v.labels.filter((l) => l !== name) : [...v.labels, name],
              }))
            }
            changes={changes}
            headers={headers}
            canSave={!!file && !readOnly}
            onSave={() => void save()}
            onJump={jumpTo}
            describeRecord={describeRecord}
            onFilterText={(text) => setView((v) => ({ ...v, quick: text }))}
            rules={rules}
            presetChoice={presetChoice}
            onPreset={setPresetChoice}
            override={override}
            missingOptional={missingOptional}
            onAddOptional={addOptionalColumn}
            hasLabels={!!labelsCol}
            hasVariables={!!features.variables}
          />
        )}
      </div>

      <footer className="status-bar">
        {file ? (
          <>
            <span className="path" title={file.path}>
              {dirty && <span className="dirty-dot" aria-label="未保存" />}
              {file.path}
              {readOnly && <span className="tag">{lfs ? "Git LFS のため読み取り専用" : "読み取り専用"}</span>}
              {!readOnly && caps?.download && <span className="tag">読み取り専用・保存はダウンロード</span>}
              {!readOnly && caps?.autosave && <span className="tag">自動保存</span>}
            </span>
            <span>{rules.ruleSet.name === "katatan" ? "KATATAN" : "汎用CSV"}</span>
            <span>
              {filtered ? `${rows.length} / ` : ""}
              {Math.max(0, doc.records.length - 1)} 行 × {rules.columns.length} 列
            </span>
            <span>{doc.encoding === "utf-8" ? `UTF-8${doc.layout.bom ? " (BOM)" : ""}` : "Shift_JIS"}</span>
            <span>
              {doc.layout.eol === "\r\n" ? "CRLF" : doc.layout.eol === "\r" ? "CR" : "LF"}
              {doc.layout.cellEol !== doc.layout.eol ? ` / セル内 ${doc.layout.cellEol === "\r\n" ? "CRLF" : "LF"}` : ""}
            </span>
            {issues.length > 0 && (
              <button className="status-issues" onClick={() => setPanel("issues")} style={{ color: ui.dirty }}>
                <Icon name="alert" size={12} /> {issues.length}
              </button>
            )}
            <span className="spacer" />
            {state.lastAction && <span className="muted">{state.lastAction}</span>}
          </>
        ) : (
          <span className="muted">見た目のルールはCSVに書き込まれません。保存時は編集した行だけが変わります。</span>
        )}
      </footer>

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog request={prompt} onDone={() => setPrompt(null)} />}
      {help === "shortcuts" && <ShortcutsDialog onClose={() => setHelp(null)} />}
      {help === "guide" && <GuideDialog onClose={() => setHelp(null)} />}
      {lightbox && (
        <Lightbox images={lightboxImages} index={lightbox.index} onIndex={(index) => setLightbox({ ...lightbox, index })} onClose={() => setLightbox(null)} />
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
});
