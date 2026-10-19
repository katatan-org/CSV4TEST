import { CompactSelection, type DataEditorRef, type GridSelection, type Rectangle, type Theme } from "@glideapps/glide-data-grid";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { createI18n, errorText, I18nProvider, type Locale, type Messages } from "./i18n";
import { assetsDirFor, ImageStore } from "./fs/imageStore";
import { analyze, nextId, referencedImages, type Issue } from "./rules/analysis";
import { findColumn, headersOf, parseRuleOverride, resolveRules, type RuleOverride } from "./rules/detect";
import { cellLines } from "./rules/tokens";
import { NotFoundError, dirOf, joinPath, type SaveResult, type StorageBackend, type TreeEntry, type VariableDef } from "./storage/types";
import { ConfirmDialog, GuideDialog, Lightbox, PromptDialog, ShortcutsDialog, type ConfirmRequest, type PromptRequest } from "./ui/Dialogs";
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
   * CSS variable overrides for the host's design tokens, e.g. { "--accent": "#0f766e", "--font": "..." }.
   * `--accent` and `--font` also apply to the grid canvas.
   */
  themeVars?: Record<string, string>;
  /** UI language (default "ja"). */
  locale?: Locale;
  /** Overrides for single UI messages of the locale's catalog. */
  messages?: Partial<Messages>;
  /**
   * Names shown for column headers, by header (case and spaces ignored), e.g.
   * { "Test Subject": "テスト項目名" }. Only the display changes; the CSV keeps its headers.
   */
  columnLabels?: Record<string, string>;
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
  /** Shows a language switch in the toolbar (standalone app). */
  onToggleLocale?(): void;
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
  /** Asks before throwing away unsaved changes. Resolves to true when there are none or the user agrees. */
  confirmDiscard(): Promise<boolean>;
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
  const locale = props.locale ?? "ja";
  const i18n = useMemo(() => createI18n(locale, props.messages), [locale, props.messages]);
  const { m } = i18n;
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
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [help, setHelp] = useState<"shortcuts" | "guide" | null>(null);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Long-running work shown in the toolbar (e.g. adding images), or null. */
  const [activity, setActivity] = useState<string | null>(null);
  /** Briefly true after a save succeeded, so the save button can confirm it in place. */
  const [justSaved, setJustSaved] = useState(false);
  const justSavedTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(justSavedTimer.current), []);
  const [externalChange, setExternalChange] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [widthsByHeader, setWidthsByHeader] = useState<Record<string, number>>({});
  const [imageIssues, setImageIssues] = useState<Issue[]>([]);
  const [imageTick, setImageTick] = useState(0);
  /** Variables from the backend; null when it has none (then any `{{name}}` is fine). */
  const [backendVariables, setBackendVariables] = useState<VariableDef[] | null>(null);
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
  const mRef = useRef(m);
  mRef.current = m;
  const themeVarsRef = useRef(props.themeVars);
  themeVarsRef.current = props.themeVars;

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

  const confirm = useCallback(
    (title: string, message: string, confirmLabel?: string) =>
      new Promise<boolean>((resolve) =>
        setConfirmReq((prev) => {
          prev?.resolve(false);
          return { title, message, confirmLabel, resolve };
        }),
      ),
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
  const columnLabels = useMemo(
    () => new Map(Object.entries(props.columnLabels ?? {}).map(([header, label]) => [normalizeHeader(header), label])),
    [props.columnLabels],
  );
  /** The name shown for a column: the host's label for its header, the header, or "Column N" when it is empty. */
  const columnLabel = useCallback(
    (header: string, col: number) => columnLabels.get(normalizeHeader(header)) ?? (header !== "" ? header : col >= 0 ? m.columnN({ n: col + 1 }) : m.emptyValue),
    [columnLabels, m],
  );
  const headerLabels = useMemo(() => headers.map((h, i) => columnLabel(h, i)), [headers, columnLabel]);
  const knownVariables = useMemo(() => (backendVariables ? new Set(backendVariables.map((v) => v.name)) : undefined), [backendVariables]);
  const variableValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of backendVariables ?? []) if (v.value !== undefined) map.set(v.name, v.value);
    return map;
  }, [backendVariables]);
  const definedVariables = useMemo(
    () => (backendVariables ? new Map(backendVariables.map((v) => [v.name, v.value])) : undefined),
    [backendVariables],
  );
  const analysis = useMemo(() => analyze(doc, rules, { knownVariables, messages: m }), [doc, rules, knownVariables, m]);
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
    () => new LayoutCache(rules.columns, features.caseRef?.pattern, imagesWritable, features.variables ? variableValues : undefined),
    [rules.columns, features.caseRef?.pattern, imagesWritable, features.variables, variableValues],
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
            issues.push({ severity: "warning", recordId: r.id, col: imagesCol.index, message: m.imageNotFound({ path: p }) });
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
          if (!referenced.has(relative)) issues.push({ severity: "warning", message: m.imageUnreferenced({ path: relative }) });
        }
      }
      setImageIssues(issues);
    }, 600);
    return () => clearTimeout(t);
  }, [doc.records, imageStore, imagesCol, file, entries, imageTick, features.images?.assetsDir, m]);

  const issues = useMemo(() => [...analysis.issues, ...imageIssues], [analysis.issues, imageIssues]);

  // ---- Editing ------------------------------------------------------------------------

  /**
   * Every edit goes through here, so read-only files, read-only columns and a
   * fixed column layout are enforced in one place whatever the UI path.
   */
  const apply = useCallback(
    (label: string, update: (d: CsvDoc) => CsvDoc) => {
      if (readOnly) {
        toast(m.readOnlyFile, "error");
        return;
      }
      if (readOnlyCols.size > 0 || fixedColumns) {
        const before = stateRef.current.doc;
        const after = update(before);
        if (after === before) return;
        if (fixedColumns && (columnCount(after) !== columnCount(before) || (after.records[0] && before.records[0] && after.records[0] !== before.records[0]))) {
          toast(m.fixedColumns, "error");
          return;
        }
        if (readOnlyCols.size > 0) {
          const prev = new Map(before.records.map((r) => [r.id, r]));
          const touched = after.records.some((r) => {
            const old = prev.get(r.id);
            return old !== undefined && old !== r && [...readOnlyCols].some((c) => cellValue(old, c) !== cellValue(r, c));
          });
          if (touched) {
            const names = [...readOnlyCols].map((c) => columnLabel(rules.columns[c]?.header ?? "", c)).join(m.listSeparator);
            toast(m.readOnlyColumns({ columns: names }), "error");
            return;
          }
        }
      }
      dispatch({ type: "apply", label, update });
    },
    [readOnly, readOnlyCols, fixedColumns, rules.columns, toast, m, columnLabel],
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
      return index > 0 ? m.rowN({ n: index }) : m.deletedRecord;
    },
    [doc.records, idCol, rules.columns, m],
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
      apply(m.insertRows({ count }), (d) => {
        const at = anchorRecordId === null ? d.records.length : d.records.findIndex((r) => r.id === anchorRecordId) + (below ? 1 : 0);
        const blank = Array.from({ length: count }, () => Array<string>(columnCount(d)).fill(""));
        return insertRecords(d, Math.max(1, at), prepareNewRows(d, blank)).doc;
      });
    },
    [apply, prepareNewRows, m],
  );

  const duplicateRows = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      apply(m.duplicateRows({ count: ids.length }), (d) => {
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
    [apply, idCol, prepareNewRows, m],
  );

  const deleteRows = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      apply(m.deleteRows({ count: ids.length }), (d) => deleteRecords(d, ids));
      setSelection(emptySelection);
    },
    [apply, m],
  );

  const moveRow = useCallback(
    (from: number, to: number) => {
      const record = rows[from];
      if (!record || filtered || view.sortOrder) return;
      apply(m.moveRow, (d) => moveRecords(d, [record.id], to + 1));
      // Glide leaves the row number it was dragged from selected; follow the moved row instead.
      setSelection({ ...emptySelection, rows: CompactSelection.fromSingleSelection(to) });
    },
    [rows, filtered, view.sortOrder, apply, m],
  );

  const addColumn = useCallback(
    async (at: number) => {
      const name = await ask(m.insertColumnTitle, m.columnNameLabel, "", m.insertConfirm);
      if (name === null) return;
      apply(m.insertColumnAction({ name }), (d) => insertColumn(d, at, name));
    },
    [ask, apply, m],
  );

  const addOptionalColumn = useCallback(
    (name: string) => {
      const def = features.optionalColumns?.find((c) => c.name === name);
      const after = findColumn(rules.columns, def?.after);
      apply(m.addOptionalColumn({ name }), (d) => insertColumn(d, after ? after.index + 1 : columnCount(d), name));
    },
    [features.optionalColumns, rules.columns, apply, m],
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
      const text = await ask(m.filterTitle({ column: headerLabels[col] }), m.filterLabel, current, m.filterConfirm);
      if (text === null) return;
      setView((v) => ({ ...v, filters: [...v.filters.filter((f) => f.col !== col), { col, text }] }));
    },
    [view.filters, headerLabels, ask, m],
  );

  const openHeaderMenu = useCallback(
    (col: number, bounds: Rectangle) => {
      const name = headerLabels[col];
      const hasFilter = view.filters.some((f) => f.col === col && f.text !== "");
      const canEditColumns = !readOnly && !fixedColumns;
      setMenu({
        x: bounds.x,
        y: bounds.y + bounds.height,
        items: [
          { label: m.sortAsc, onClick: () => sortBy(col, false), checked: sortInfo?.col === col && !sortInfo.desc },
          { label: m.sortDesc, onClick: () => sortBy(col, true), checked: sortInfo?.col === col && sortInfo.desc },
          { label: m.sortClear, onClick: clearSort, disabled: !sortInfo },
          "separator",
          { label: hasFilter ? m.filterEdit : m.filterByColumn, onClick: () => void filterColumn(col), checked: hasFilter },
          ...(hasFilter
            ? [{ label: m.filterClearColumn, onClick: () => setView((v) => ({ ...v, filters: v.filters.filter((f) => f.col !== col) })) }]
            : []),
          ...(canEditColumns
            ? ([
                "separator",
                { label: `${m.insertColumnLeft}…`, onClick: () => void addColumn(col) },
                { label: `${m.insertColumnRight}…`, onClick: () => void addColumn(col + 1) },
                {
                  label: `${m.renameColumn}…`,
                  onClick: async () => {
                    const v = await ask(m.renameColumn, m.newColumnName, headers[col], m.renameConfirm);
                    if (v !== null && headerRecord) apply(m.renameColumn, (d) => setCells(d, [{ recordId: d.records[0].id, col, value: v }]));
                  },
                },
                "separator",
                {
                  label: m.deleteColumn({ name }),
                  danger: true,
                  onClick: async () => {
                    if (await confirm(m.deleteColumn({ name }), m.confirmDeleteColumn({ name }), m.deleteConfirm)) apply(m.deleteColumn({ name }), (d) => deleteColumn(d, col));
                  },
                },
              ] as MenuItem[])
            : []),
        ],
      });
    },
    [headers, headerLabels, view.filters, sortInfo, sortBy, clearSort, filterColumn, addColumn, ask, apply, headerRecord, readOnly, fixedColumns, m],
  );

  const openCellMenu = useCallback(
    (row: number, col: number, x: number, y: number) => {
      const record = rows[row];
      if (!record) return;
      const inSelection = selectedRecordIds().includes(record.id);
      if (!inSelection) selectCell(col, row);
      const ids = inSelection ? selectedRecordIds() : [record.id];
      const n = ids.length;
      const copy: MenuItem = { label: m.copy, shortcut: "Ctrl+C", onClick: () => document.execCommand("copy") };
      setMenu({
        x,
        y,
        items: readOnly
          ? [copy]
          : [
              { label: m.insertRowAbove, onClick: () => insertRowsAt(ids[0], false, 1) },
              { label: m.insertRowBelow, shortcut: "Ctrl+Shift++", onClick: () => insertRowsAt(ids[n - 1], true, 1) },
              { label: m.duplicateRows({ count: n }), onClick: () => duplicateRows(ids) },
              "separator",
              copy,
              { label: m.cut, shortcut: "Ctrl+X", onClick: () => document.execCommand("cut") },
              {
                label: m.paste,
                shortcut: "Ctrl+V",
                onClick: () => toast(m.pasteFromMenu),
              },
              "separator",
              { label: m.deleteRows({ count: n }), shortcut: "Ctrl+-", danger: true, onClick: () => deleteRows(ids) },
            ],
      });
    },
    [rows, selectedRecordIds, selectCell, insertRowsAt, duplicateRows, deleteRows, toast, readOnly, m],
  );

  // ---- Images -------------------------------------------------------------------------

  const addImageFiles = useCallback(
    async (recordId: number, files: File[]) => {
      if (!imageStore || !imagesWritable || !imagesCol || !file) {
        toast(
          readOnly ? m.readOnlyFile : caps?.tree ? m.errorImagesUnavailable : m.imagesNeedFolder,
          "error",
        );
        return;
      }
      const record = doc.records.find((r) => r.id === recordId);
      if (!record) return;
      const assetsDir = assetsDirFor(features.images?.assetsDir ?? "{name}.assets", file.name);
      const id = idCol ? cellValue(record, idCol.index).trim() : "";
      const base = id ? `case-${id}` : `row-${doc.records.indexOf(record)}`;
      setActivity(m.addingImages({ count: files.length }));
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await imageStore.add(f, assetsDir, base));
        const dir = dirOf(file.path);
        setEntries((prev) => (prev ? [...prev, ...paths.map((p) => ({ path: joinPath(dir, p) }))] : prev));
        apply(m.addImagesAction({ count: paths.length }), (d) => {
          const current = d.records.find((r) => r.id === recordId);
          const lines = cellLines(cellValue(current, imagesCol.index));
          return setCells(d, [{ recordId, col: imagesCol.index, value: [...lines, ...paths].join("\n") }]);
        });
        toast(m.imagesSaved({ paths: paths.join(m.listSeparator) }));
      } catch (e) {
        toast(m.addImageFailed({ detail: errorText(e, m) }), "error");
      } finally {
        setActivity(null);
      }
    },
    [imageStore, imagesWritable, imagesCol, file, doc.records, features.images?.assetsDir, idCol, apply, toast, readOnly, caps, m],
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
    return [...names, ...(backendVariables ?? []).map((v) => v.name).filter((v) => !names.includes(v))];
  }, [analysis.variables, backendVariables]);

  const viewCtx: ViewContext = {
    mode,
    m,
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
    // Called while the canvas draws, so it sets the attribute directly instead of React state.
    onHint: (text) => {
      const el = rootRef.current?.querySelector<HTMLElement>(".grid-container");
      if (el && el.title !== (text ?? "")) el.title = text ?? "";
    },
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
        toast(m.loadFailed({ detail: errorText(e, m) }), "error");
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
    [toast, setFile, findOverride, m],
  );

  const confirmDiscard = useCallback(
    async () => !isDirty(stateRef.current.doc) || (await confirm(m.discardTitle, m.confirmDiscard, m.discardAndContinue)),
    [confirm, m],
  );

  const openPath = useCallback(
    async (path: string, force = false) => {
      const b = backendRef.current;
      if (!b) return;
      if (!force && fileRef.current?.path === path) return;
      if (!force && !(await confirmDiscard())) return;
      try {
        const { bytes, version } = await b.read(path);
        await loadDoc(path, bytes, version);
      } catch (e) {
        toast(m.openFailed({ detail: errorText(e, m) }), "error");
      }
    },
    [confirmDiscard, loadDoc, toast, m],
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
    setBackendVariables(null);
    if (!backend) return;
    let cancelled = false;
    void (async () => {
      let list: TreeEntry[] | null = null;
      if (backend.capabilities.tree && backend.listTree) {
        try {
          list = await backend.listTree();
        } catch (e) {
          toast(mRef.current.listFailed({ detail: errorText(e, mRef.current) }), "error");
        }
        if (cancelled) return;
        setEntries(list);
        entriesRef.current = list;
      }
      const initial = props.file ?? (props.openFirst && list ? firstCsv(buildTree("", list.map((e) => e.path).filter(isCsvPath))) : null);
      if (initial) await openPath(initial, true);
      else if (props.openFirst && list) toast(mRef.current.noCsvInFolder);
    })();
    void backend.variables?.().then(
      (vars) => !cancelled && setBackendVariables(vars),
      () => undefined,
    );
    const unsubscribe = backend.onExternalChange?.((paths) => {
      const f = fileRef.current;
      if (!f || !paths.includes(f.path) || savingRef.current) return;
      if (!isDirty(stateRef.current.doc)) {
        void reload().then(() => toast(mRef.current.reloadedExternal));
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
      if (modified.length > 0) {
        parts.push(m.commitUpdated({ records: modified.slice(0, 5).map((c) => label(c.record.id)).join(m.listSeparator), more: modified.length > 5 }));
      }
      if (added.length > 0) parts.push(m.commitAdded({ count: added.length }));
      if (removed.length > 0) parts.push(m.commitRemoved({ count: removed.length }));
      if (summary.reordered) parts.push(m.commitReordered);
      return m.commitMessage({ file: name, parts: parts.length > 0 ? parts : [m.commitFallback] });
    },
    [describeRecord, m],
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
        const answer = await ask(m.commitTitle, m.commitMessageLabel, defaultMessage(computeChanges(snapshot), f.name), m.commit);
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
          dispatch({ type: "saved", doc: snapshot, assigned, label: m.saved });
          const version = result.versions[f.path] ?? f.version;
          setFile((cur) => (cur && cur.path === f.path ? { ...cur, version } : cur));
          b.watch?.(f.path, version);
          setExternalChange(false);
          setConflict(null);
          window.clearTimeout(justSavedTimer.current);
          setJustSaved(true);
          justSavedTimer.current = window.setTimeout(() => setJustSaved(false), 2000);
          if (!b.capabilities.autosave) {
            toast(result.message ?? (b.capabilities.download ? m.downloaded({ name: f.name }) : m.savedPath({ path: f.path })));
          }
          props.onSaved?.(result);
          return true;
        }
        if ("conflict" in result) {
          setConflict(result.conflict);
          return false;
        }
        const detail = result.error.code === "permission_denied" ? m.errorPermissionDenied : result.error.message;
        toast(m.saveFailed({ detail }), "error");
        props.onError?.(result.error);
        return false;
      } catch (e) {
        const message = (e as Error).message;
        toast(m.saveFailed({ detail: errorText(e, m) }), "error");
        props.onError?.({ code: "exception", message });
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [readOnly, ask, defaultMessage, recordChanges, setFile, toast, props.onSaved, props.onError, m], // eslint-disable-line react-hooks/exhaustive-deps
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
      confirmDiscard,
    }),
    [openPath, confirmDiscard],
  );

  // コールバックの戻り値を cleanup として返さないよう、ブロックにする（Svelte の dispatch は boolean を返す）
  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    props.onFileChange?.(file?.path ?? null);
  }, [file?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    storageSet("csv4test:panel", panel);
  }, [panel]);

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
    for (const [k, v] of Object.entries(themeVarsRef.current ?? {})) portal.style.setProperty(k, v);
  }, [mode, props.themeVars]);

  // Test seam for E2E: on the dev server, or in a host page that opts in by setting
  // `window.__CSV4TEST_TEST_HOOKS__ = true` before mounting (e.g. a Playwright init script).
  // The grid is drawn on a canvas, so tests need it to find cells and read the document.
  useEffect(() => {
    const optedIn = (window as unknown as { __CSV4TEST_TEST_HOOKS__?: boolean }).__CSV4TEST_TEST_HOOKS__ === true;
    if (!import.meta.env.DEV && !optedIn) return;
    const w = window as unknown as { __csv4test?: Record<string, unknown> };
    w.__csv4test = {
      ...w.__csv4test,
      getBounds: (col: number, row: number) => gridRef.current?.getBounds(col, row),
      scrollTo: (col: number, row: number) => gridRef.current?.scrollTo(col, row),
      text: () => stateRef.current.doc.records.map((r) => r.fields.map((f) => f.value)),
      selected: () => selection.current?.cell,
      selectedRows: () => selection.rows.toArray(),
      /** Adds images to the data row at `row` (0-based), as dropping files on its Images cell does. */
      addImages: (row: number, files: File[]) => {
        const record = stateRef.current.doc.records[row + 1];
        return record ? addImageFiles(record.id, files) : Promise.resolve();
      },
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
      // A dialog takes the keyboard, as window.confirm used to.
      if (el?.closest?.(".modal")) return;
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
        dispatch({ type: "undo", label: m.undo });
      } else if (mod && (key === "y" || (e.shiftKey && key === "z"))) {
        e.preventDefault();
        dispatch({ type: "redo", label: m.redo });
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
  }, [embedded, save, selectedRecordIds, insertRowsAt, deleteRows, readOnly, m]);

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
    () => (entries ? buildTree(props.rootName || m.defaultRootName, entries.map((e) => e.path).filter(isCsvPath)) : null),
    [entries, props.rootName, m],
  );

  const activeFilters = [
    ...view.filters.filter((f) => f.text !== "").map((f) => ({ key: `f${f.col}`, label: `${headerLabels[f.col] ?? m.columnN({ n: f.col + 1 })}: ${f.text}`, clear: () => setView((v) => ({ ...v, filters: v.filters.filter((x) => x.col !== f.col) })) })),
    ...view.labels.map((l) => ({ key: `l${l}`, label: m.labelChip({ label: l }), clear: () => setView((v) => ({ ...v, labels: v.labels.filter((x) => x !== l) })) })),
    ...(sortInfo ? [{ key: "sort", label: m.sortChip({ column: headerLabels[sortInfo.col] ?? "", arrow: sortInfo.desc ? "↓" : "↑" }), clear: clearSort }] : []),
  ];

  const ui = uiColors(mode);
  const themeVars = props.themeVars;
  const canvasTheme = useMemo<Partial<Theme> | undefined>(() => {
    if (!themeVars) return undefined;
    const t: Partial<Theme> = {};
    if (themeVars["--accent"]) {
      t.accentColor = themeVars["--accent"];
      t.bgBubbleSelected = themeVars["--accent"];
    }
    if (themeVars["--font"]) t.fontFamily = themeVars["--font"];
    return t;
  }, [themeVars]);
  const saveLabel = caps?.download ? m.download : caps?.commitMessage ? m.commit : m.save;
  // The save button shows its own progress and result, so a slow commit is never silent.
  const saveButtonLabel = saving
    ? caps?.commitMessage ? m.committing : m.saving
    : justSaved && !dirty
      ? caps?.commitMessage ? m.committed : m.saved
      : saveLabel;
  const saveButtonIcon = saving ? "spinner" : justSaved && !dirty ? "check" : caps?.download ? "download" : "save";
  const changeCount = changes.changes.length + (changes.reordered ? 1 : 0);
  const saveState = saving ? m.saving : conflict ? m.stateConflict : dirty ? m.unsaved : m.stateSaved;

  return (
    <I18nProvider value={i18n}>
      <div className="c4t c4t-root" data-theme={mode} lang={locale} ref={rootRef} tabIndex={embedded ? -1 : undefined} style={themeVars as CSSProperties | undefined}>
        <div className="app">
          <header className="toolbar">
            {props.toolbarStart}
            <div className="toolbar-group">
              {caps?.autosave ? (
                <span className={`save-state${dirty || conflict ? " pending" : ""}`} role="status">
                  {file ? saveState : ""}
                </span>
              ) : (
                <button
                  className={`save-button${dirty && !saving ? " primary" : ""}${justSaved && !dirty && !saving ? " done" : ""}`}
                  onClick={() => void save()}
                  disabled={!file || readOnly || saving}
                  aria-busy={saving}
                  title={`${saveLabel} (Ctrl+S)`}
                >
                  <Icon name={saveButtonIcon} className={saving ? "spin" : undefined} />
                  <span className="label" role="status">{saveButtonLabel}</span>
                  {dirty && !saving && <span className="badge">{i18n.number(changeCount)}</span>}
                </button>
              )}
              {activity && (
                <span className="activity" role="status">
                  <Icon name="spinner" className="spin" />
                  {activity}
                </span>
              )}
            </div>
            <div className="toolbar-group">
              <button className="icon-button" onClick={() => dispatch({ type: "undo", label: m.undo })} disabled={state.past.length === 0} title={`${m.undo} (Ctrl+Z)`} aria-label={m.undo}>
                <Icon name="undo" />
              </button>
              <button className="icon-button" onClick={() => dispatch({ type: "redo", label: m.redo })} disabled={state.future.length === 0} title={`${m.redo} (Ctrl+Y)`} aria-label={m.redo}>
                <Icon name="redo" />
              </button>
              {missingOptional.map((name) => (
                <button key={name} onClick={() => addOptionalColumn(name)} disabled={!file} title={m.addOptionalColumnTitle({ name })}>
                  <Icon name={name === "Images" ? "image" : "tag"} />
                  <span className="label">{m.addOptionalColumn({ name })}</span>
                </button>
              ))}
            </div>
            <div className="toolbar-search">
              <Icon name="filter" size={14} />
              <input
                value={view.quick}
                onChange={(e) => setView((v) => ({ ...v, quick: e.target.value }))}
                placeholder={m.quickFilterPlaceholder}
                aria-label={m.quickFilter}
                disabled={!file}
              />
              {view.quick && (
                <button className="icon-button" onClick={() => setView((v) => ({ ...v, quick: "" }))} aria-label={m.clearQuickFilter}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <div className="toolbar-group right">
              <button className="icon-button" onClick={() => setFind({ open: true, replace: false })} disabled={!file} title={`${m.findReplace} (Ctrl+F)`} aria-label={m.findReplace}>
                <Icon name="search" />
              </button>
              {tree && (
                <button className={`icon-button${showTree ? " on" : ""}`} onClick={() => setShowTree(!showTree)} title={m.fileList} aria-label={m.toggleFileList} aria-pressed={showTree}>
                  <Icon name="tree" />
                </button>
              )}
              <button className={`icon-button${panel ? " on" : ""}`} onClick={() => setPanel(panel ? null : "issues")} title={m.sidePanel} aria-label={m.toggleSidePanel} aria-pressed={!!panel}>
                <Icon name="sidebar" />
              </button>
              {props.onToggleTheme && (
                <button className="icon-button" onClick={props.onToggleTheme} title={m.toggleThemeTitle} aria-label={m.toggleTheme}>
                  <Icon name={mode === "dark" ? "sun" : "moon"} />
                </button>
              )}
              {props.onToggleLocale && (
                <button className="locale-button" onClick={props.onToggleLocale} title={m.switchLanguageTitle} aria-label={m.switchLanguageTitle} lang={locale === "ja" ? "en" : "ja"}>
                  <Icon name="globe" size={15} />
                  <span className="label">{m.switchLanguage}</span>
                </button>
              )}
              <button className="icon-button" onClick={() => setHelp("shortcuts")} title={`${m.keyboardShortcuts} (?)`} aria-label={m.keyboardShortcuts}>
                <Icon name="keyboard" />
              </button>
              <button className="icon-button" onClick={() => setHelp("guide")} title={`${m.help} (F1)`} aria-label={m.help}>
                <Icon name="help" />
              </button>
            </div>
          </header>

          {conflict && (
            <div className="banner warn" role="alert">
              <Icon name="alert" />
              <span>
                {m.saveFailedBanner}
                {conflict.message ?? (conflict.code === "modified_externally" ? m.conflictModifiedExternally : m.conflictDefault)}
                {conflict.records &&
                  conflict.records.length > 0 &&
                  m.conflictRecords({ records: conflict.records.map((r) => describeRecord(r.id)).join(m.listSeparator) })}
              </span>
              <button onClick={async () => (await confirm(m.reloadTitle, m.confirmReloadDiscardMine, m.discardAndReload)) && void reload()}>{m.reloadLatest}</button>
              <button onClick={() => void save(true)}>{m.overwrite}</button>
              <button onClick={() => setConflict(null)}>{m.close}</button>
            </div>
          )}

          {externalChange && !conflict && (
            <div className="banner warn" role="alert">
              <Icon name="alert" />
              <span>{m.externalChanged}</span>
              <button onClick={async () => (await confirm(m.reloadTitle, m.confirmReloadDiscardUnsaved, m.discardAndReload)) && void reload()}>{m.reloadDiscard}</button>
              <button onClick={() => setExternalChange(false)}>{m.keepEditing}</button>
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
                      headers={headerLabels}
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
                      <span>{m.shownRows({ shown: rows.length, total: doc.records.length - 1 })}</span>
                      {activeFilters.map((f) => (
                        <span key={f.key} className="filter-chip">
                          {f.label}
                          <button onClick={f.clear} aria-label={m.clearChip({ label: f.label })}>
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
                        {m.clearAll}
                      </button>
                    </div>
                  )}
                  {doc.records.length === 0 ? (
                    <div className="empty-file">
                      <p>{m.emptyFile}</p>
                      {!readOnly && (
                        <button
                          onClick={() =>
                            apply(m.createHeaderAction, (d) => {
                              // KATATAN files use a BOM and CRLF records.
                              const withLayout = { ...d, layout: { ...d.layout, bom: true, eol: "\r\n", trailingEol: true } };
                              return insertRecords(withLayout, 0, [["No", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes"]]).doc;
                            })
                          }
                        >
                          {m.createKatatanHeader}
                        </button>
                      )}
                    </div>
                  ) : (
                    <Grid
                      doc={doc}
                      rows={rows}
                      rules={rules}
                      titles={headerLabels}
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
                      themeOverride={canvasTheme}
                      apply={apply}
                      onInsertRow={(row, below) => {
                        const record = rows[row];
                        if (record) insertRowsAt(record.id, below);
                      }}
                      onInsertColumn={(at) => void addColumn(at)}
                      onMoveRow={moveRow}
                      onMoveColumn={(from, to) => apply(m.moveColumn, (d) => moveColumn(d, from, to))}
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
                  <p className="muted">{m.chooseFile}</p>
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
                definedVariables={definedVariables}
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
                headers={headerLabels}
                columnLabel={columnLabel}
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
                  {dirty && <span className="dirty-dot" aria-label={m.unsaved} />}
                  {file.path}
                  {readOnly && <span className="tag">{lfs ? m.readOnlyLfs : m.readOnly}</span>}
                  {!readOnly && caps?.download && <span className="tag">{m.readOnlyDownload}</span>}
                  {!readOnly && caps?.autosave && <span className="tag">{m.autosave}</span>}
                </span>
                <span>{rules.ruleSet.name === "katatan" ? m.presetKatatan : m.presetGeneric}</span>
                <span>{m.size({ rows: Math.max(0, doc.records.length - 1), columns: rules.columns.length, shown: filtered ? rows.length : undefined })}</span>
                <span>{doc.encoding === "utf-8" ? `UTF-8${doc.layout.bom ? " (BOM)" : ""}` : "Shift_JIS"}</span>
                <span>
                  {doc.layout.eol === "\r\n" ? "CRLF" : doc.layout.eol === "\r" ? "CR" : "LF"}
                  {doc.layout.cellEol !== doc.layout.eol ? m.inCellEol({ eol: doc.layout.cellEol === "\r\n" ? "CRLF" : "LF" }) : ""}
                </span>
                {issues.length > 0 && (
                  <button className="status-issues" onClick={() => setPanel("issues")} style={{ color: ui.dirty }}>
                    <Icon name="alert" size={12} /> {i18n.number(issues.length)}
                  </button>
                )}
                <span className="spacer" />
                {state.lastAction && <span className="muted">{state.lastAction}</span>}
              </>
            ) : (
              <span className="muted">{m.footerNote}</span>
            )}
          </footer>

          {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
          {prompt && <PromptDialog request={prompt} onDone={() => setPrompt(null)} />}
          {confirmReq && <ConfirmDialog request={confirmReq} onDone={() => setConfirmReq(null)} />}
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
      </div>
    </I18nProvider>
  );
});
