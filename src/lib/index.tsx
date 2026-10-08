/**
 * Library entry: mounts the editor into any element, so pages built with
 * another framework (KATATAN is Svelte) can embed it. React and the grid are
 * bundled; the host does not need them.
 *
 *   const editor = mount(el, { backend, file: "tests/login.csv", theme: "light" });
 *   await editor.save();
 *   editor.unmount();
 */
import { createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor, type EditorHandle, type EditorProps } from "../Editor";
import gridStyles from "@glideapps/glide-data-grid/dist/index.css?inline";
import styles from "../styles.css?inline";
import type { ThemeMode } from "../ui/theme";

export type { EditorHandle } from "../Editor";
export { FsAccessBackend, FsFileBackend } from "../storage/fsAccess";
export { MemoryBackend, type MemoryBackendOptions } from "../storage/memory";
export * from "../storage/types";
export type { RecordChange, CellChange } from "../editor/changes";

export interface MountOptions {
  backend: EditorProps["backend"];
  /** File to open (path from the backend root). Without it, the tree is shown when the backend has one. */
  file?: string;
  /** Name shown at the top of the file tree. */
  rootName?: string;
  readOnly?: boolean;
  theme?: ThemeMode;
  /** CSS variable overrides, e.g. { "--accent": "#0f766e" } (see EditorProps.themeVars). */
  themeVars?: Record<string, string>;
  onDirtyChange?(dirty: boolean): void;
  onFileChange?(path: string | null): void;
  onSaved?: EditorProps["onSaved"];
  onError?: EditorProps["onError"];
}

export interface EditorInstance {
  isDirty(): boolean;
  /** Saves now; resolves to false when nothing was saved (cancelled, conflict, error). */
  save(): Promise<boolean>;
  open(path: string): Promise<void>;
  currentPath(): string | null;
  /** Changes options after mounting, e.g. the theme or read-only. Passing a new backend reloads. */
  update(options: Partial<MountOptions>): void;
  unmount(): void;
}

const STYLE_ID = "csv4test-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${gridStyles}\n${styles}`;
  document.head.appendChild(style);
}

export function mount(element: HTMLElement, options: MountOptions): EditorInstance {
  injectStyles();
  const root = createRoot(element);
  const handle = createRef<EditorHandle>();
  let current = options;

  const render = () =>
    root.render(
      <StrictMode>
        <Editor
          ref={handle}
          embedded
          backend={current.backend}
          file={current.file}
          rootName={current.rootName}
          readOnly={current.readOnly}
          theme={current.theme ?? "light"}
          themeVars={current.themeVars}
          onDirtyChange={current.onDirtyChange}
          onFileChange={current.onFileChange}
          onSaved={current.onSaved}
          onError={current.onError}
        />
      </StrictMode>,
    );
  render();

  return {
    isDirty: () => handle.current?.isDirty() ?? false,
    save: () => handle.current?.save() ?? Promise.resolve(false),
    open: (path) => handle.current?.open(path) ?? Promise.resolve(),
    currentPath: () => handle.current?.currentPath() ?? null,
    update(partial) {
      current = { ...current, ...partial };
      render();
    },
    unmount() {
      root.unmount();
    },
  };
}
