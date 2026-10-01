/**
 * File System Access API wrapper. Chrome / Edge can open a folder (e.g. a Git
 * working tree) and save CSV files in place; other browsers fall back to
 * upload + download (see fallback.ts).
 */

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: { description?: string; accept: Record<string, string[]> }[];
      id?: string;
    }) => Promise<FileSystemFileHandle[]>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

export const supportsFsAccess = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

export const CSV_EXTENSIONS = [".csv", ".tsv"];
export const OVERRIDE_FILE = ".csvview.json";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);
const MAX_DEPTH = 8;

export interface TreeNode {
  name: string;
  /** Path from the root folder, "/"-separated. */
  path: string;
  kind: "dir" | "file";
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  children?: TreeNode[];
}

/** Where an open CSV lives. Every handle is null when the file came from an upload or URL. */
export interface FileLocation {
  name: string;
  path: string;
  handle: FileSystemFileHandle | null;
  root: FileSystemDirectoryHandle | null;
  /** Folder path of the CSV relative to `root`. */
  dirSegments: string[];
}

export function isCsvName(name: string): boolean {
  const lower = name.toLowerCase();
  return CSV_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) throw new Error("このブラウザはフォルダを開く機能に対応していません");
  return window.showDirectoryPicker({ mode: "readwrite", id: "csv4test" });
}

export async function pickFile(): Promise<FileSystemFileHandle> {
  if (!window.showOpenFilePicker) throw new Error("このブラウザはファイルを開く機能に対応していません");
  const [handle] = await window.showOpenFilePicker({
    id: "csv4test",
    types: [{ description: "CSV", accept: { "text/csv": [".csv"], "text/tab-separated-values": [".tsv"] } }],
  });
  return handle;
}

/** Recursively lists CSV files. Hidden folders and common build folders are skipped. */
export async function scanTree(root: FileSystemDirectoryHandle): Promise<TreeNode> {
  async function walk(dir: FileSystemDirectoryHandle, path: string, depth: number): Promise<TreeNode> {
    const children: TreeNode[] = [];
    if (depth < MAX_DEPTH) {
      for await (const entry of dir.values()) {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || entry.name.endsWith(".assets")) continue;
          const node = await walk(entry as FileSystemDirectoryHandle, childPath, depth + 1);
          if (node.children && node.children.length > 0) children.push(node);
        } else if (isCsvName(entry.name)) {
          children.push({ name: entry.name, path: childPath, kind: "file", handle: entry });
        }
      }
    }
    children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "ja", { numeric: true }) : a.kind === "dir" ? -1 : 1));
    return { name: dir.name, path, kind: "dir", handle: dir, children };
  }
  return walk(root, "", 0);
}

export async function ensurePermission(handle: FileSystemHandle, mode: "read" | "readwrite"): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode })) === "granted") return true;
  return (await handle.requestPermission({ mode })) === "granted";
}

export async function readHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; lastModified: number }> {
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified };
}

export async function lastModifiedOf(handle: FileSystemFileHandle): Promise<number> {
  return (await handle.getFile()).lastModified;
}

/** Overwrites the file and returns its new modification time. */
export async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  if (!(await ensurePermission(handle, "readwrite"))) throw new Error("書き込みが許可されませんでした");
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return lastModifiedOf(handle);
}

/** Resolves a folder under `root`. Returns null when a segment is missing (unless `create`). */
export async function getDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create = false,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  for (const seg of segments) {
    try {
      dir = await dir.getDirectoryHandle(seg, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

export async function getFile(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch {
    return null;
  }
}

/** The nearest `.csvview.json` from the CSV's folder up to the root folder. */
export async function findOverride(
  root: FileSystemDirectoryHandle,
  dirSegments: string[],
): Promise<{ text: string; path: string } | null> {
  for (let i = dirSegments.length; i >= 0; i--) {
    const segs = dirSegments.slice(0, i);
    const dir = await getDir(root, segs);
    if (!dir) continue;
    const file = await getFile(dir, OVERRIDE_FILE);
    if (file) return { text: await (await file.getFile()).text(), path: [...segs, OVERRIDE_FILE].join("/") };
  }
  return null;
}

/**
 * Joins a "/"-separated path relative to `baseSegments`, resolving "." and "..".
 * Returns null if the path escapes the root or is absolute / a URL.
 */
export function resolveRelative(baseSegments: string[], path: string): string[] | null {
  if (/^[a-z]+:/i.test(path) || path.startsWith("/")) return null;
  const out = [...baseSegments];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length > 0 ? out : null;
}
