/**
 * The standalone app: picks a storage backend (a folder, a single file, an
 * upload or the sample) and hands it to the editor. Everything that belongs to
 * the page rather than the editor lives here: the start screen, drag & drop
 * onto the window, the page title, the unload prompt and the theme toggle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor, type EditorHandle } from "./Editor";
import { downloadBytes, pickFileByInput } from "./fs/fallback";
import { isCsvName, pickFile, pickFolder, supportsFsAccess } from "./fs/fileAccess";
import { createI18n, errorText, isLocale, matchLocale, type Locale, type Messages } from "./i18n";
import { HELP } from "./i18n/help";
import { FsAccessBackend, FsFileBackend } from "./storage/fsAccess";
import { MemoryBackend } from "./storage/memory";
import type { ChangeSet, StorageBackend } from "./storage/types";
import { Icon } from "./ui/icons";
import type { ThemeMode } from "./ui/theme";

const SAMPLE_URL = "sample/KATATAN_CSV_FORMAT.csv";

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

/** The UI language: the saved choice, else the browser's language. */
function useLocale(): [Locale, () => void] {
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("csv4test:locale") ?? "null");
      if (isLocale(saved)) return saved;
    } catch {
      /* fall back to the browser's language */
    }
    return matchLocale(navigator.language);
  });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const toggle = () =>
    setLocale((l) => {
      const next = l === "ja" ? "en" : "ja";
      try {
        localStorage.setItem("csv4test:locale", JSON.stringify(next));
      } catch {
        /* preference is just not remembered */
      }
      return next;
    });
  return [locale, toggle];
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
  const [locale, toggleLocale] = useLocale();
  const { m } = useMemo(() => createI18n(locale), [locale]);
  const mRef = useRef(m);
  mRef.current = m;
  const [opened, setOpened] = useState<Opened | null>(null);
  const [dirty, setDirty] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<EditorHandle>(null);

  const confirmDiscard = useCallback(async () => !editorRef.current || (await editorRef.current.confirmDiscard()), []);

  const open = useCallback((next: Opened) => {
    setOpened((prev) => {
      prev?.backend.dispose?.();
      return next;
    });
  }, []);

  const showError = useCallback((e: unknown) => {
    if ((e as Error).name === "AbortError") return;
    setNotice(errorText(e, mRef.current));
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const openFolderHandle = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      if (!(await confirmDiscard())) return;
      open({ backend: new FsAccessBackend(dir), rootName: dir.name, openFirst: true });
    },
    [confirmDiscard, open],
  );

  const openFileHandle = useCallback(
    async (handle: FileSystemFileHandle) => {
      if (!(await confirmDiscard())) return;
      open({ backend: new FsFileBackend(handle), file: handle.name });
    },
    [confirmDiscard, open],
  );

  const openUpload = useCallback(
    async (f: File) => {
      if (!(await confirmDiscard())) return;
      open({ backend: downloadBackend(f.name, new Uint8Array(await f.arrayBuffer())), file: f.name });
    },
    [confirmDiscard, open],
  );

  const openFolder = useCallback(async () => {
    if (!supportsFsAccess) {
      showError(new Error(m.noFolderSupport));
      return;
    }
    try {
      await openFolderHandle(await pickFolder());
    } catch (e) {
      showError(e);
    }
  }, [openFolderHandle, showError, m]);

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
    if (!(await confirmDiscard())) return;
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
        else showError(new Error(mRef.current.dropUnsupported));
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
          title={supportsFsAccess ? m.openFolderTitle : m.noFolderSupport}
        >
          <Icon name="folder" />
          <span className="label">{m.openFolder}</span>
        </button>
        <button onClick={() => void openSingleFile()} title={m.openFileTitle}>
          <Icon name="file" />
          <span className="label">{m.fileButton}</span>
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
        locale={locale}
        onToggleTheme={toggleMode}
        onToggleLocale={toggleLocale}
        toolbarStart={toolbarStart}
        emptyState={<Welcome m={m} locale={locale} onFolder={openFolder} onFile={openSingleFile} onSample={openSample} />}
        onDirtyChange={setDirty}
        onFileChange={setPath}
      />
      {dragOver && <div className="drop-overlay">{m.dropOverlay}</div>}
      {notice && (
        <div className="toasts" role="status" aria-live="polite">
          <div className="toast error">{notice}</div>
        </div>
      )}
    </div>
  );
}

function Welcome({
  m,
  locale,
  onFolder,
  onFile,
  onSample,
}: {
  m: Messages;
  locale: Locale;
  onFolder: () => void;
  onFile: () => void;
  onSample: () => void;
}) {
  return (
    <div className="welcome">
      <h1>{m.welcomeTitle}</h1>
      <p className="lead">{m.welcomeLead}</p>
      <div className="welcome-actions">
        <button
          className={supportsFsAccess ? "primary large" : "large unavailable"}
          onClick={onFolder}
          aria-disabled={!supportsFsAccess}
          title={supportsFsAccess ? undefined : m.noFolderSupport}
        >
          <Icon name="folder" size={18} />
          {m.openFolder}
          <small>{supportsFsAccess ? m.welcomeFolderNote : m.welcomeFolderUnavailable}</small>
        </button>
        <button className="large" onClick={onFile}>
          <Icon name="file" size={18} />
          {m.openFile}
          <small>{supportsFsAccess ? m.welcomeFileNote : m.welcomeFileNoteDownload}</small>
        </button>
        <button className="large" onClick={onSample}>
          <Icon name="external" size={18} />
          {m.openSample}
          <small>{m.welcomeSampleNote}</small>
        </button>
      </div>
      <ul className="welcome-points">
        {HELP[locale].welcomePoints.map((point, i) => (
          <li key={i}>{point}</li>
        ))}
      </ul>
      <p className="muted">{m.welcomeDrop}</p>
    </div>
  );
}
