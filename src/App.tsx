/**
 * The standalone app: picks a storage backend (a folder, a single file, an
 * upload or the sample) and hands it to the editor. Everything that belongs to
 * the page rather than the editor lives here: the start screen, drag & drop
 * onto the window, the page title, the unload prompt and the theme toggle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Editor, type EditorHandle } from "./Editor";
import { downloadBytes, pickFileByInput } from "./fs/fallback";
import { isCsvName, pickFile, pickFolder, supportsFsAccess } from "./fs/fileAccess";
import { FsAccessBackend, FsFileBackend } from "./storage/fsAccess";
import { MemoryBackend } from "./storage/memory";
import type { ChangeSet, StorageBackend } from "./storage/types";
import { Icon } from "./ui/icons";
import type { ThemeMode } from "./ui/theme";

const SAMPLE_URL = "sample/KATATAN_CSV_FORMAT.csv";
const NO_FOLDER_SUPPORT = "このブラウザではフォルダを開けません。Chrome / Edge で使えます（違いは F1 のヘルプ「ブラウザによる違い」を参照）";

interface Opened {
  backend: StorageBackend;
  file?: string;
  rootName?: string;
  openFirst?: boolean;
}

function useThemeMode(): [ThemeMode, () => void] {
  const system = (): ThemeMode => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("csv4test:theme");
      return saved ? (JSON.parse(saved) as ThemeMode) : system();
    } catch {
      return system();
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  const toggle = () =>
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("csv4test:theme", JSON.stringify(next));
      } catch {
        /* preference is just not remembered */
      }
      return next;
    });
  return [mode, toggle];
}

/** A file held in memory; saving downloads it. */
function downloadBackend(path: string, bytes: Uint8Array): MemoryBackend {
  return new MemoryBackend({
    files: { [path]: bytes },
    capabilities: { tree: false, images: false, download: true },
    onSave: (changeSet: ChangeSet) => {
      for (const f of changeSet.files) if (f.bytes) downloadBytes(f.path.slice(f.path.lastIndexOf("/") + 1), f.bytes);
    },
  });
}

export function App() {
  const [mode, toggleMode] = useThemeMode();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [dirty, setDirty] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<EditorHandle>(null);

  const confirmDiscard = useCallback(
    () => !editorRef.current?.isDirty() || window.confirm("保存していない変更があります。破棄して続けますか？"),
    [],
  );

  const open = useCallback((next: Opened) => {
    setOpened((prev) => {
      prev?.backend.dispose?.();
      return next;
    });
  }, []);

  const showError = useCallback((e: unknown) => {
    if ((e as Error).name === "AbortError") return;
    setNotice((e as Error).message);
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const openFolderHandle = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      if (!confirmDiscard()) return;
      open({ backend: new FsAccessBackend(dir), rootName: dir.name, openFirst: true });
    },
    [confirmDiscard, open],
  );

  const openFileHandle = useCallback(
    async (handle: FileSystemFileHandle) => {
      if (!confirmDiscard()) return;
      open({ backend: new FsFileBackend(handle), file: handle.name });
    },
    [confirmDiscard, open],
  );

  const openUpload = useCallback(
    async (f: File) => {
      if (!confirmDiscard()) return;
      open({ backend: downloadBackend(f.name, new Uint8Array(await f.arrayBuffer())), file: f.name });
    },
    [confirmDiscard, open],
  );

  const openFolder = useCallback(async () => {
    if (!supportsFsAccess) {
      showError(new Error(NO_FOLDER_SUPPORT));
      return;
    }
    try {
      await openFolderHandle(await pickFolder());
    } catch (e) {
      showError(e);
    }
  }, [openFolderHandle, showError]);

  const openSingleFile = useCallback(async () => {
    try {
      if (supportsFsAccess) {
        await openFileHandle(await pickFile());
      } else {
        const f = await pickFileByInput();
        if (f) await openUpload(f);
      }
    } catch (e) {
      showError(e);
    }
  }, [openFileHandle, openUpload, showError]);

  const openSample = useCallback(async () => {
    if (!confirmDiscard()) return;
    const res = await fetch(SAMPLE_URL);
    open({ backend: downloadBackend(SAMPLE_URL, new Uint8Array(await res.arrayBuffer())), file: SAMPLE_URL });
  }, [confirmDiscard, open]);

  useEffect(() => () => opened?.backend.dispose?.(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const name = path?.slice(path.lastIndexOf("/") + 1);
    document.title = name ? `${dirty ? "● " : ""}${name} — CSV4TEST` : "CSV4TEST";
  }, [path, dirty]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editorRef.current?.isDirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void (supportsFsAccess ? openFolder() : openSingleFile());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFolder, openSingleFile]);

  // Test seam for E2E (dev server only): folder pickers cannot be automated.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __csv4test?: Record<string, unknown> };
    w.__csv4test = { ...w.__csv4test, openFolderHandle };
  });

  // Drag & drop a file or folder onto the window.
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
        else if (files[0] && isCsvName(files[0].name)) await openUpload(files[0]);
        else showError(new Error("CSV / TSV ファイルかフォルダをドロップしてください"));
      } catch (err) {
        showError(err);
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
  }, [openFolderHandle, openFileHandle, openUpload, showError]);

  const toolbarStart = (
    <>
      <div className="brand">
        <span className="logo" aria-hidden="true">
          CSV
        </span>
        <span>CSV4TEST</span>
      </div>
      <div className="toolbar-group">
        <button
          onClick={() => void openFolder()}
          aria-disabled={!supportsFsAccess}
          className={supportsFsAccess ? undefined : "unavailable"}
          title={supportsFsAccess ? "フォルダを開く (Ctrl+O)" : NO_FOLDER_SUPPORT}
        >
          <Icon name="folder" />
          <span className="label">フォルダを開く</span>
        </button>
        <button onClick={() => void openSingleFile()} title="ファイルを開く">
          <Icon name="file" />
          <span className="label">ファイル</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="c4t c4t-shell" data-theme={mode}>
      <Editor
        ref={editorRef}
        backend={opened?.backend ?? null}
        file={opened?.file}
        rootName={opened?.rootName}
        openFirst={opened?.openFirst}
        theme={mode}
        onToggleTheme={toggleMode}
        toolbarStart={toolbarStart}
        emptyState={<Welcome onFolder={openFolder} onFile={openSingleFile} onSample={openSample} />}
        onDirtyChange={setDirty}
        onFileChange={setPath}
      />
      {dragOver && <div className="drop-overlay">CSVファイルかフォルダをドロップして開く</div>}
      {notice && (
        <div className="toasts" role="status" aria-live="polite">
          <div className="toast error">{notice}</div>
        </div>
      )}
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
        <button
          className={supportsFsAccess ? "primary large" : "large unavailable"}
          onClick={onFolder}
          aria-disabled={!supportsFsAccess}
          title={supportsFsAccess ? undefined : NO_FOLDER_SUPPORT}
        >
          <Icon name="folder" size={18} />
          フォルダを開く
          <small>
            {supportsFsAccess ? "Gitリポジトリのフォルダを開き、その場で保存します" : "このブラウザでは使えません（Chrome / Edge で使えます）"}
          </small>
        </button>
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
