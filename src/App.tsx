import { CompactSelection, type DataEditorRef, type GridSelection, type Rectangle } from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { columnMapping, computeChanges } from "./editor/changes";
import type { Match } from "./editor/findReplace";
import { editorReducer, initialEditorState } from "./editor/history";
import { computeViewRows, EMPTY_VIEW, isViewFiltered, sortSnapshot, type ViewOptions } from "./editor/viewRows";
import { downloadBytes, pickFileByInput, pickImagesByInput } from "./fs/fallback";
import {
  findOverride,
  isCsvName,
  lastModifiedOf,
  pickFile,
  pickFolder,
  readHandle,
  scanTree,
  supportsFsAccess,
  writeHandle,
  type FileLocation,
  type TreeNode,
} from "./fs/fileAccess";
import { assetsDirFor, ImageStore } from "./fs/imageStore";
import { analyze, nextId, referencedImages, type Issue } from "./rules/analysis";
import { findColumn, headersOf, parseRuleOverride, resolveRules, type RuleOverride } from "./rules/detect";
import { cellLines } from "./rules/tokens";
import { HelpDialog, Lightbox, PromptDialog, type PromptRequest } from "./ui/Dialogs";
import { FileTree } from "./ui/FileTree";
import { FindBar } from "./ui/FindBar";
import { emptySelection, Grid, selectionRect } from "./ui/Grid";
import { Icon } from "./ui/icons";
import { Menu, type MenuItem } from "./ui/Menu";
import { SidePanel, type PanelTab } from "./ui/SidePanel";
import { badgeColors, uiColors, type ThemeMode } from "./ui/theme";
import { LayoutCache, type ViewContext } from "./ui/view";

interface OpenFile {
  location: FileLocation;
  lastModified: number;
  /** Changes on every (re)load so derived state resets. */
  loadId: number;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

type MenuState = { x: number; y: number; items: MenuItem[] };

const EMPTY_DOC = docFromText("");
const SAMPLE_URL = "sample/KATATAN_CSV_FORMAT.csv";

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

function useThemeMode(): [ThemeMode, () => void] {
  const system = () => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [mode, setMode] = useState<ThemeMode>(() => storageGet<ThemeMode | null>("csv4test:theme", null) ?? system());
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  const toggle = () =>
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      storageSet("csv4test:theme", next);
      return next;
    });
  return [mode, toggle];
}

let loadCounter = 0;
let toastCounter = 0;

export function App() {
  const [mode, toggleMode] = useThemeMode();
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
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
  const [help, setHelp] = useState(false);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [externalChange, setExternalChange] = useState(false);
  const [widthsByHeader, setWidthsByHeader] = useState<Record<string, number>>({});
  const [imageIssues, setImageIssues] = useState<Issue[]>([]);
  const [imageTick, setImageTick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const gridRef = useRef<DataEditorRef>(null);
  const savingRef = useRef(false);

  const doc = state.doc;
  const dirty = useMemo(() => isDirty(doc), [doc]);

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

  const apply = useCallback((label: string, update: (d: CsvDoc) => CsvDoc) => dispatch({ type: "apply", label, update }), []);

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

  const widthKey = file ? `csv4test:widths:${file.location.path}` : null;
  useEffect(() => {
    setWidthsByHeader(widthKey ? storageGet<Record<string, number>>(widthKey, {}) : {});
  }, [widthKey]);
  const widths = useMemo(
    () => rules.columns.map((c) => widthsByHeader[c.header] ?? c.rule.width ?? 160),
    [rules.columns, widthsByHeader],
  );

  const imageStore = useMemo(() => {
    if (!file) return null;
    let queued = false;
    return new ImageStore(file.location, () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setImageTick((t) => t + 1);
      });
    });
  }, [file]);
  useEffect(() => () => imageStore?.clear(), [imageStore]);

  const layouts = useMemo(
    () => new LayoutCache(rules.columns, features.caseRef?.pattern, !!imageStore?.writable),
    [rules.columns, features.caseRef?.pattern, imageStore],
  );

  // Redraw image cells when thumbnails finish loading.
  useEffect(() => {
    if (!imagesCol || imageTick === 0) return;
    gridRef.current?.updateCells(rows.map((_, row) => ({ cell: [imagesCol.index, row] as const })));
  }, [imageTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Missing / unreferenced images (async, debounced).
  useEffect(() => {
    if (!imageStore?.writable || !imagesCol || !file) {
      setImageIssues([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const issues: Issue[] = [];
      for (const r of doc.records.slice(1)) {
        for (const p of cellLines(cellValue(r, imagesCol.index))) {
          if (/^https?:/i.test(p)) continue;
          if (!(await imageStore.resolve(p))) {
            issues.push({ severity: "warning", recordId: r.id, col: imagesCol.index, message: `画像が見つかりません: ${p}` });
          }
        }
      }
      const assetsDir = assetsDirFor(features.images?.assetsDir ?? "{name}.assets", file.location.name);
      const referenced = referencedImages(doc.records, imagesCol.index);
      for (const p of await imageStore.listAssets(assetsDir)) {
        if (!referenced.has(p)) issues.push({ severity: "warning", message: `どの行からも参照されていない画像: ${p}` });
      }
      if (!cancelled) setImageIssues(issues);
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [doc.records, imageStore, imagesCol, file, features.images?.assetsDir]);

  const issues = useMemo(() => [...analysis.issues, ...imageIssues], [analysis.issues, imageIssues]);

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
      if (!idCol) return newRows;
      let next = Number(nextId(d, idCol.index));
      return newRows.map((r) => {
        if (r[idCol.index]?.trim()) return r;
        const copy = r.slice();
        copy[idCol.index] = String(next++);
        return copy;
      });
    },
    [idCol],
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

  const appendRow = useCallback(() => insertRowsAt(null, true), [insertRowsAt]);

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
    () => (features.optionalColumns ?? []).filter((c) => !findColumn(rules.columns, c.name)).map((c) => c.name),
    [features.optionalColumns, rules.columns],
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
        ],
      });
    },
    [headers, view.filters, sortInfo, sortBy, clearSort, filterColumn, addColumn, ask, apply, headerRecord],
  );

  const openCellMenu = useCallback(
    (row: number, col: number, x: number, y: number) => {
      const record = rows[row];
      if (!record) return;
      const inSelection = selectedRecordIds().includes(record.id);
      if (!inSelection) selectCell(col, row);
      const ids = inSelection ? selectedRecordIds() : [record.id];
      const n = ids.length;
      setMenu({
        x,
        y,
        items: [
          { label: "上に行を挿入", onClick: () => insertRowsAt(ids[0], false, 1) },
          { label: "下に行を挿入", shortcut: "Ctrl+Shift++", onClick: () => insertRowsAt(ids[n - 1], true, 1) },
          { label: n > 1 ? `${n}行を複製` : "行を複製", onClick: () => duplicateRows(ids) },
          "separator",
          { label: "コピー", shortcut: "Ctrl+C", onClick: () => document.execCommand("copy") },
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
    [rows, selectedRecordIds, selectCell, insertRowsAt, duplicateRows, deleteRows, toast],
  );

  // ---- Images -------------------------------------------------------------------------

  const addImageFiles = useCallback(
    async (recordId: number, files: File[]) => {
      if (!imageStore?.writable || !imagesCol || !file) {
        toast("画像を追加するには、CSVのあるフォルダを「フォルダを開く」で開いてください", "error");
        return;
      }
      const record = doc.records.find((r) => r.id === recordId);
      if (!record) return;
      const assetsDir = assetsDirFor(features.images?.assetsDir ?? "{name}.assets", file.location.name);
      const id = idCol ? cellValue(record, idCol.index).trim() : "";
      const base = id ? `case-${id}` : `row-${doc.records.indexOf(record)}`;
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await imageStore.add(f, assetsDir, base));
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
    [imageStore, imagesCol, file, doc.records, features.images?.assetsDir, idCol, apply, toast],
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

  const viewCtx: ViewContext = {
    mode,
    columns: rules.columns,
    features,
    labelColors: rules.ruleSet.labelColors ?? {},
    idToRecord: analysis.idToRecord,
    originals: doc.originals,
    columnMap,
    images: imageStore,
    variables: analysis.variables.map((v) => v.name),
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

  const confirmDiscard = useCallback(
    () => !isDirty(state.doc) || window.confirm("保存していない変更があります。破棄して続けますか？"),
    [state.doc],
  );

  const loadDoc = useCallback(
    async (location: FileLocation, bytes: Uint8Array, lastModified: number, rootHandle: FileSystemDirectoryHandle | null) => {
      let next: CsvDoc;
      try {
        next = docFromBytes(bytes, location.name.toLowerCase().endsWith(".tsv") ? "\t" : undefined);
      } catch (e) {
        toast(`読み込めませんでした: ${(e as Error).message}`, "error");
        return;
      }
      dispatch({ type: "load", doc: next });
      setFile({ location, lastModified, loadId: ++loadCounter });
      setView(EMPTY_VIEW);
      setSortInfo(null);
      setSelection(emptySelection);
      setExternalChange(false);
      setLightbox(null);

      if (rootHandle) {
        try {
          const found = await findOverride(rootHandle, location.dirSegments);
          setOverride(found ? { rules: parseRuleOverride(found.text), path: found.path } : {});
        } catch (e) {
          setOverride({ error: (e as Error).message });
        }
      } else {
        setOverride({});
      }
    },
    [toast],
  );

  const openTreeNode = useCallback(
    async (node: TreeNode) => {
      if (node.kind !== "file" || !root) return;
      if (file?.location.path === node.path) return;
      if (!confirmDiscard()) return;
      const handle = node.handle as FileSystemFileHandle;
      try {
        const { bytes, lastModified } = await readHandle(handle);
        const segs = node.path.split("/");
        await loadDoc({ name: node.name, path: node.path, handle, root, dirSegments: segs.slice(0, -1) }, bytes, lastModified, root);
      } catch (e) {
        toast(`開けませんでした: ${(e as Error).message}`, "error");
      }
    },
    [root, file, confirmDiscard, loadDoc, toast],
  );

  const openFolderHandle = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      if (!confirmDiscard()) return;
      const t = await scanTree(dir);
      setRoot(dir);
      setTree(t);
      setShowTree(true);
      // Open the first CSV right away.
      const first = (function findFirst(n: TreeNode): TreeNode | null {
        for (const c of n.children ?? []) {
          if (c.kind === "file") return c;
          const f = findFirst(c);
          if (f) return f;
        }
        return null;
      })(t);
      if (first) {
        const handle = first.handle as FileSystemFileHandle;
        const { bytes, lastModified } = await readHandle(handle);
        await loadDoc(
          { name: first.name, path: first.path, handle, root: dir, dirSegments: first.path.split("/").slice(0, -1) },
          bytes,
          lastModified,
          dir,
        );
      } else {
        toast("このフォルダにはCSVファイルがありません");
      }
    },
    [confirmDiscard, loadDoc, toast],
  );

  const openFolder = useCallback(async () => {
    try {
      await openFolderHandle(await pickFolder());
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, "error");
    }
  }, [openFolderHandle, toast]);

  const openFileHandle = useCallback(
    async (handle: FileSystemFileHandle) => {
      if (!confirmDiscard()) return;
      const { bytes, lastModified } = await readHandle(handle);
      setRoot(null);
      setTree(null);
      await loadDoc({ name: handle.name, path: handle.name, handle, root: null, dirSegments: [] }, bytes, lastModified, null);
    },
    [confirmDiscard, loadDoc],
  );

  const openSingleFile = useCallback(async () => {
    try {
      if (supportsFsAccess) {
        await openFileHandle(await pickFile());
      } else {
        const f = await pickFileByInput();
        if (!f || !confirmDiscard()) return;
        setRoot(null);
        setTree(null);
        await loadDoc({ name: f.name, path: f.name, handle: null, root: null, dirSegments: [] }, new Uint8Array(await f.arrayBuffer()), f.lastModified, null);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, "error");
    }
  }, [openFileHandle, confirmDiscard, loadDoc, toast]);

  const openSample = useCallback(async () => {
    if (!confirmDiscard()) return;
    const res = await fetch(SAMPLE_URL);
    const bytes = new Uint8Array(await res.arrayBuffer());
    setRoot(null);
    setTree(null);
    await loadDoc({ name: "KATATAN_CSV_FORMAT.csv", path: "sample/KATATAN_CSV_FORMAT.csv", handle: null, root: null, dirSegments: [] }, bytes, 0, null);
  }, [confirmDiscard, loadDoc]);

  const refreshTree = useCallback(async () => {
    if (root) setTree(await scanTree(root));
  }, [root]);

  const reloadFromDisk = useCallback(async () => {
    if (!file?.location.handle) return;
    const { bytes, lastModified } = await readHandle(file.location.handle);
    await loadDoc(file.location, bytes, lastModified, file.location.root);
  }, [file, loadDoc]);

  const save = useCallback(async () => {
    if (!file || savingRef.current) return;
    const bytes = await docToBytes(state.doc);
    if (!file.location.handle) {
      downloadBytes(file.location.name, bytes);
      dispatch({ type: "saved" });
      toast(`${file.location.name} をダウンロードしました`);
      return;
    }
    savingRef.current = true;
    try {
      const current = await lastModifiedOf(file.location.handle);
      if (current !== file.lastModified && !window.confirm("ファイルが外部で変更されています（git checkout など）。上書きしますか？")) return;
      const lastModified = await writeHandle(file.location.handle, bytes);
      setFile((f) => (f ? { ...f, lastModified } : f));
      dispatch({ type: "saved" });
      setExternalChange(false);
      toast(`${file.location.path} を保存しました`);
    } catch (e) {
      toast(`保存できませんでした: ${(e as Error).message}`, "error");
    } finally {
      savingRef.current = false;
    }
  }, [file, state.doc, toast]);

  // Detect changes made outside the app (git pull / checkout, other editors).
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const handle = file?.location.handle;
    if (!handle) return;
    let stopped = false;
    const check = async () => {
      if (stopped || savingRef.current || document.visibilityState !== "visible") return;
      try {
        const lm = await lastModifiedOf(handle);
        if (stopped || savingRef.current || lm === file.lastModified) return;
        if (!isDirty(stateRef.current.doc)) {
          await reloadFromDisk();
          toast("ファイルが外部で変更されたため、再読み込みしました");
        } else {
          setExternalChange(true);
        }
      } catch {
        /* file may be temporarily missing during a git operation */
      }
    };
    const timer = setInterval(check, 2000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [file, reloadFromDisk, toast]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty(stateRef.current.doc)) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    document.title = file ? `${dirty ? "● " : ""}${file.location.name} — CSV4TEST` : "CSV4TEST";
  }, [file, dirty]);

  useEffect(() => storageSet("csv4test:panel", panel), [panel]);

  // Test seam for E2E (dev server only): folder pickers cannot be automated.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __csv4test: unknown }).__csv4test = {
      openFolderHandle,
      getBounds: (col: number, row: number) => gridRef.current?.getBounds(col, row),
      scrollTo: (col: number, row: number) => gridRef.current?.scrollTo(col, row),
      text: () => stateRef.current.doc.records.map((r) => r.fields.map((f) => f.value)),
      selected: () => selection.current?.cell,
    };
  });

  // ---- Drag & drop a file or folder onto the window --------------------------------------

  useEffect(() => {
    const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      setDragOver(false);
      if (!isFileDrag(e) || !e.dataTransfer) return;
      // Image drops onto the grid are handled by the grid itself.
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0 && files.every((f) => f.type.startsWith("image/"))) return;
      e.preventDefault();
      const item = e.dataTransfer.items[0];
      const handle = item?.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
      try {
        if (handle?.kind === "directory") await openFolderHandle(handle as FileSystemDirectoryHandle);
        else if (handle?.kind === "file" && isCsvName(handle.name)) await openFileHandle(handle as FileSystemFileHandle);
        else if (files[0] && isCsvName(files[0].name)) {
          if (!confirmDiscard()) return;
          const f = files[0];
          setRoot(null);
          setTree(null);
          await loadDoc({ name: f.name, path: f.name, handle: null, root: null, dirSegments: [] }, new Uint8Array(await f.arrayBuffer()), f.lastModified, null);
        } else toast("CSV / TSV ファイルかフォルダをドロップしてください", "error");
      } catch (err) {
        toast((err as Error).message, "error");
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [openFolderHandle, openFileHandle, confirmDiscard, loadDoc, toast]);

  // ---- Keyboard shortcuts ---------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && key === "o") {
        e.preventDefault();
        void (supportsFsAccess ? openFolder() : openSingleFile());
        return;
      }
      if (!file) return;
      if (mod && (key === "f" || key === "h")) {
        e.preventDefault();
        setFind({ open: true, replace: key === "h" });
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
      } else if (e.key === "?" || e.key === "F1") {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, save, openFolder, openSingleFile, selectedRecordIds, insertRowsAt, deleteRows]);

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

  const activeFilters = [
    ...view.filters.filter((f) => f.text !== "").map((f) => ({ key: `f${f.col}`, label: `${headers[f.col] || `列 ${f.col + 1}`}: ${f.text}`, clear: () => setView((v) => ({ ...v, filters: v.filters.filter((x) => x.col !== f.col) })) })),
    ...view.labels.map((l) => ({ key: `l${l}`, label: `ラベル: ${l}`, clear: () => setView((v) => ({ ...v, labels: v.labels.filter((x) => x !== l) })) })),
    ...(sortInfo ? [{ key: "sort", label: `並べ替え: ${headers[sortInfo.col]} ${sortInfo.desc ? "↓" : "↑"}`, clear: clearSort }] : []),
  ];

  const ui = uiColors(mode);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            CSV
          </span>
          <span>CSV4TEST</span>
        </div>
        <div className="toolbar-group">
          {supportsFsAccess && (
            <button onClick={() => void openFolder()} title="フォルダを開く (Ctrl+O)">
              <Icon name="folder" />
              <span className="label">フォルダを開く</span>
            </button>
          )}
          <button onClick={() => void openSingleFile()} title="ファイルを開く">
            <Icon name="file" />
            <span className="label">ファイル</span>
          </button>
          <button className={dirty ? "primary" : undefined} onClick={() => void save()} disabled={!file} title="保存 (Ctrl+S)">
            <Icon name={file && !file.location.handle ? "download" : "save"} />
            <span className="label">{file && !file.location.handle ? "ダウンロード" : "保存"}</span>
            {dirty && <span className="badge">{changes.changes.length + (changes.reordered ? 1 : 0)}</span>}
          </button>
        </div>
        <div className="toolbar-group">
          <button className="icon-button" onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0} title="元に戻す (Ctrl+Z)" aria-label="元に戻す">
            <Icon name="undo" />
          </button>
          <button className="icon-button" onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0} title="やり直す (Ctrl+Y)" aria-label="やり直す">
            <Icon name="redo" />
          </button>
          <button onClick={appendRow} disabled={!file} title="末尾に行を追加">
            <Icon name="plus" />
            <span className="label">行を追加</span>
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
          <button className="icon-button" onClick={toggleMode} title="テーマ切り替え" aria-label="ライト/ダークを切り替え">
            <Icon name={mode === "dark" ? "sun" : "moon"} />
          </button>
          <button className="icon-button" onClick={() => setHelp(true)} title="ショートカット (?)" aria-label="ヘルプ">
            <Icon name="help" />
          </button>
        </div>
      </header>

      {externalChange && (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <span>ファイルが外部で変更されました（git pull / checkout など）。未保存の変更があります。</span>
          <button onClick={() => window.confirm("未保存の変更を破棄して、ディスクの内容を読み込みますか？") && void reloadFromDisk()}>再読み込み（変更を破棄）</button>
          <button onClick={() => setExternalChange(false)}>このまま編集を続ける</button>
        </div>
      )}

      <div className="workspace">
        {tree && showTree && (
          <FileTree tree={tree} activePath={file?.location.path ?? null} dirty={dirty} onOpen={(n) => void openTreeNode(n)} onRefresh={() => void refreshTree()} />
        )}
        <main className="main">
          {file ? (
            <>
              {find.open && (
                <FindBar
                  rows={rows}
                  colCount={rules.columns.length}
                  headers={headers}
                  replaceMode={find.replace}
                  onReplaceMode={(replace) => setFind({ open: true, replace })}
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
                  highlights={highlights}
                  apply={apply}
                  prepareNewRows={prepareNewRows}
                  onAppendRow={appendRow}
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
          ) : (
            <Welcome onFolder={openFolder} onFile={openSingleFile} onSample={openSample} />
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
            canSave={!!file}
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
            <span className="path" title={file.location.path}>
              {dirty && <span className="dirty-dot" aria-label="未保存" />}
              {file.location.path}
              {!file.location.handle && <span className="tag">読み取り専用・保存はダウンロード</span>}
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
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {lightbox && (
        <Lightbox images={lightboxImages} index={lightbox.index} onIndex={(index) => setLightbox({ ...lightbox, index })} onClose={() => setLightbox(null)} />
      )}
      {dragOver && <div className="drop-overlay">CSVファイルかフォルダをドロップして開く</div>}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Welcome({ onFolder, onFile, onSample }: { onFolder: () => void; onFile: () => void; onSample: () => void }) {
  return (
    <div className="welcome">
      <h1>テストケースCSVを、読みやすく編集する</h1>
      <p className="lead">
        CSVを開くと、列ごとのルールに沿って自動で整形して表示します。見た目の情報はCSVに書き込まないので、Gitの差分は編集した行だけになります。
      </p>
      <div className="welcome-actions">
        {supportsFsAccess ? (
          <button className="primary large" onClick={onFolder}>
            <Icon name="folder" size={18} />
            フォルダを開く
            <small>Gitリポジトリのフォルダを開き、その場で保存します</small>
          </button>
        ) : (
          <p className="note">このブラウザではフォルダを直接開けません。Chrome / Edge では、フォルダを開いてその場で保存できます。</p>
        )}
        <button className="large" onClick={onFile}>
          <Icon name="file" size={18} />
          ファイルを開く
          <small>{supportsFsAccess ? "CSVを1つだけ開きます（画像の追加はできません）" : "編集後はダウンロードで保存します"}</small>
        </button>
        <button className="large" onClick={onSample}>
          <Icon name="external" size={18} />
          サンプルを開く
          <small>KATATAN形式のサンプルで試す</small>
        </button>
      </div>
      <ul className="welcome-points">
        <li>
          <strong>KATATAN形式</strong>を自動で判定し、手順に番号を付け、<code>{"{{変数}}"}</code>・<code>'入力値'</code>・<code>case-N</code> を強調します
        </li>
        <li>
          Excelのように範囲選択・コピー＆ペースト・フィル・Undoができます。Excelとのコピー＆ペーストでセル内改行も保たれます
        </li>
        <li>改行コード（CRLF/LF）・BOM・クォート・文字コードは元のまま保存します</li>
      </ul>
      <p className="muted">CSVファイルやフォルダは、この画面にドラッグ＆ドロップしても開けます。</p>
    </div>
  );
}
