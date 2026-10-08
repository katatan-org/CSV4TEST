/**
 * Where files come from and where saves go. The editor never touches a file
 * system, a server or credentials itself: the host passes a backend.
 *
 * Paths are "/"-separated and relative to the backend's root. A `version` is an
 * opaque string the backend uses to detect concurrent changes (a modification
 * time, a Git blob SHA, an updatedAt...). The editor only passes it back.
 */
import type { RecordChange } from "../editor/changes";

export interface BackendCapabilities {
  /** Show a file tree (the backend serves several files). */
  tree: boolean;
  /** Images can be added (`addAsset`). */
  images: boolean;
  /** Ask for a message on save (Git commits). */
  commitMessage: boolean;
  /** Save automatically a little after each edit instead of on Ctrl+S. */
  autosave: boolean;
  /** Columns cannot be added, removed, renamed or moved (the host has a fixed schema). */
  fixedColumns: boolean;
  /** Headers of columns whose cells cannot be edited. */
  readOnlyColumns: string[];
  /** Nothing can be edited. */
  readOnly: boolean;
  /** Saving hands the file to the user as a download instead of writing it somewhere. */
  download: boolean;
}

export interface TreeEntry {
  path: string;
  /** Optional here: `read` always returns the version. */
  version?: string;
  size?: number;
  /** Stored in Git LFS: the content is a pointer, so the file is shown read-only. */
  lfs?: boolean;
}

export interface FileContent {
  bytes: Uint8Array;
  version: string;
}

export interface FileChange {
  path: string;
  op: "put" | "delete";
  /** Lossless serialization of the edited document (`put` only). */
  bytes?: Uint8Array<ArrayBuffer>;
  /** The version the edit started from; null for a new file. */
  baseVersion: string | null;
}

export interface RecordChanges {
  path: string;
  changes: RecordChange[];
  /** Ids of the data records (header excluded) in their current order, so moves can be replayed. */
  order: number[];
  /** Column headers in their current order. */
  headers: string[];
}

export interface ChangeSet {
  files: FileChange[];
  /** The same edit expressed per record, for backends that store rows rather than files. */
  records?: RecordChanges;
  /** Commit message, when `commitMessage` is on. */
  message?: string;
  /** Overwrite even if the stored version moved on (after the user chose to). */
  force?: boolean;
}

export type SaveResult =
  | {
      ok: true;
      /** New version per saved path. */
      versions: Record<string, string>;
      /** Values the backend assigned to new records, by record id and column header (e.g. a generated No). */
      assigned?: Record<number, Record<string, string>>;
      /** Shown to the user after saving, e.g. "Committed a1b2c3d". */
      message?: string;
    }
  | {
      ok: false;
      conflict: {
        /** Files someone else changed. */
        paths?: string[];
        /** Records someone else changed, with their current values by header. */
        records?: { id: number; current?: Record<string, string> }[];
        message?: string;
      };
    }
  | { ok: false; error: { code: string; message: string; status?: number } };

export interface VariableDef {
  name: string;
  /** Shown in place of `{{name}}` in the grid. */
  value?: string;
  description?: string;
}

export interface StorageBackend {
  readonly capabilities: BackendCapabilities;
  /** Every file under the root (directories are implied by paths). Needed when `tree` is on. */
  listTree?(): Promise<TreeEntry[]>;
  /** Rejects with a `NotFoundError` (see below) when the file does not exist. */
  read(path: string): Promise<FileContent>;
  save(changeSet: ChangeSet): Promise<SaveResult>;
  /** URL to display an image at `path`, or null when it does not exist. */
  assetUrl?(path: string): Promise<string | null>;
  /**
   * Stores an image in `dir` under an unused name starting with `baseName` and
   * returns its path. When the image becomes part of the next save is up to the
   * backend (written at once, uploaded at once, or staged for the next commit).
   */
  addAsset?(dir: string, baseName: string, file: Blob & { name?: string }): Promise<string>;
  /**
   * Known `{{variable}}`s, e.g. from a shared dictionary. They are offered as completions;
   * a `value` is shown in place of `{{name}}` outside the cell editor. When this is
   * provided, `{{name}}`s not in the list are reported as issues.
   */
  variables?(): Promise<VariableDef[]>;
  /** Reports paths changed outside the editor (git pull, another user). Returns an unsubscribe function. */
  onExternalChange?(listener: (paths: string[]) => void): () => void;
  /** Called when the editor opens a file, so the backend can watch it. */
  watch?(path: string, version: string): void;
  /** Releases timers and object URLs. */
  dispose?(): void;
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`${path} が見つかりません`);
    this.name = "NotFoundError";
  }
}

export const DEFAULT_CAPABILITIES: BackendCapabilities = {
  tree: false,
  images: false,
  commitMessage: false,
  autosave: false,
  fixedColumns: false,
  readOnlyColumns: [],
  readOnly: false,
  download: false,
};

export function capabilities(partial: Partial<BackendCapabilities>): BackendCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...partial };
}

/** Folder part of a path ("" for the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/**
 * Resolves `relative` against the folder `baseDir`, handling "." and "..".
 * Returns null for absolute paths, URLs and paths that escape the root.
 */
export function resolvePath(baseDir: string, relative: string): string | null {
  if (/^[a-z]+:/i.test(relative) || relative.startsWith("/")) return null;
  const out = baseDir ? baseDir.split("/") : [];
  for (const seg of relative.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length > 0 ? out.join("/") : null;
}
