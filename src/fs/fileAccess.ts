/**
 * Low-level File System Access API helpers (Chrome / Edge). The backends in
 * storage/fsAccess.ts build on these; other browsers fall back to upload +
 * download (see fallback.ts).
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

export async function ensurePermission(handle: FileSystemHandle, mode: "read" | "readwrite"): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode })) === "granted") return true;
  return (await handle.requestPermission({ mode })) === "granted";
}

export async function readHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; lastModified: number }> {
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified };
}

/** Overwrites the file and returns its new modification time. */
export async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  if (!(await ensurePermission(handle, "readwrite"))) throw new Error("書き込みが許可されませんでした");
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return (await handle.getFile()).lastModified;
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
