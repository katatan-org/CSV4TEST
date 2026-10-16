/**
 * Backends over the File System Access API (Chrome / Edge): a folder such as a
 * Git working tree, or a single file. Files are written in place.
 */
import { ensurePermission, getDir, getFile, readHandle, writeHandle } from "../fs/fileAccess";
import {
  capabilities,
  NotFoundError,
  StorageError,
  type BackendCapabilities,
  type ChangeSet,
  type FileContent,
  type SaveResult,
  type StorageBackend,
  type TreeEntry,
} from "./types";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);
const MAX_DEPTH = 8;
const POLL_MS = 2000;

/** Polls the modification time of opened files and reports the ones that changed. */
class ChangePoller {
  private versions = new Map<string, string>();
  private listeners = new Set<(paths: string[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Set while the editor writes, so its own saves are not reported. */
  paused = false;

  constructor(private readonly versionOf: (path: string) => Promise<string | null>) {}

  track(path: string, version: string) {
    this.versions.set(path, version);
  }

  subscribe(listener: (paths: string[]) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), POLL_MS);
      window.addEventListener("focus", this.onFocus);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private onFocus = () => void this.check();

  private async check() {
    if (this.busy || this.paused || document.visibilityState !== "visible") return;
    this.busy = true;
    try {
      const changed: string[] = [];
      for (const [path, version] of this.versions) {
        let now: string | null;
        try {
          now = await this.versionOf(path);
        } catch {
          continue; // The file may be missing for a moment during a git operation.
        }
        if (now !== null && now !== version) {
          this.versions.set(path, now);
          changed.push(path);
        }
      }
      if (changed.length > 0 && !this.paused) for (const l of this.listeners) l(changed);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("focus", this.onFocus);
  }
}

function splitPath(path: string): { dir: string[]; name: string } {
  const segs = path.split("/").filter(Boolean);
  return { dir: segs.slice(0, -1), name: segs[segs.length - 1] ?? "" };
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

export function imageExtension(file: Blob & { name?: string }): string {
  return EXT_BY_TYPE[file.type] ?? file.name?.split(".").pop()?.toLowerCase() ?? "png";
}

/** A folder opened with `showDirectoryPicker` (or dropped onto the page). */
export class FsAccessBackend implements StorageBackend {
  readonly capabilities: BackendCapabilities = capabilities({ tree: true, images: true });
  private readonly poller = new ChangePoller((path) => this.versionOf(path));
  private readonly urls = new Map<string, string>();

  constructor(readonly root: FileSystemDirectoryHandle) {}

  get name(): string {
    return this.root.name;
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle | null> {
    const { dir, name } = splitPath(path);
    const folder = await getDir(this.root, dir, create);
    if (!folder || !name) return null;
    if (create) return folder.getFileHandle(name, { create: true });
    return getFile(folder, name);
  }

  private async versionOf(path: string): Promise<string | null> {
    const handle = await this.fileHandle(path);
    return handle ? String((await handle.getFile()).lastModified) : null;
  }

  async listTree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      if (depth >= MAX_DEPTH) return;
      for await (const entry of dir.values()) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          await walk(entry as FileSystemDirectoryHandle, path, depth + 1);
        } else {
          out.push({ path });
        }
      }
    };
    await walk(this.root, "", 0);
    return out.sort((a, b) => a.path.localeCompare(b.path, "ja", { numeric: true }));
  }

  async read(path: string): Promise<FileContent> {
    const handle = await this.fileHandle(path);
    if (!handle) throw new NotFoundError(path);
    const { bytes, lastModified } = await readHandle(handle);
    return { bytes, version: String(lastModified) };
  }

  watch(path: string, version: string) {
    this.poller.track(path, version);
  }

  onExternalChange(listener: (paths: string[]) => void): () => void {
    return this.poller.subscribe(listener);
  }

  async save(changeSet: ChangeSet): Promise<SaveResult> {
    if (!(await ensurePermission(this.root, "readwrite"))) {
      return { ok: false, error: { code: "permission_denied", message: "Permission to write was not granted" } };
    }
    this.poller.paused = true;
    try {
      if (!changeSet.force) {
        const moved: string[] = [];
        for (const f of changeSet.files) {
          const now = await this.versionOf(f.path);
          if (f.baseVersion !== null && now !== null && now !== f.baseVersion) moved.push(f.path);
        }
        if (moved.length > 0) {
          return { ok: false, conflict: { paths: moved, code: "modified_externally" } };
        }
      }
      const versions: Record<string, string> = {};
      for (const f of changeSet.files) {
        if (f.op === "delete") {
          const { dir, name } = splitPath(f.path);
          const folder = await getDir(this.root, dir);
          await folder?.removeEntry(name);
          continue;
        }
        const handle = await this.fileHandle(f.path, true);
        if (!handle || !f.bytes) continue;
        const version = String(await writeHandle(handle, f.bytes));
        versions[f.path] = version;
        this.poller.track(f.path, version);
      }
      return { ok: true, versions };
    } catch (e) {
      return { ok: false, error: { code: "write_failed", message: (e as Error).message } };
    } finally {
      this.poller.paused = false;
    }
  }

  async assetUrl(path: string): Promise<string | null> {
    const handle = await this.fileHandle(path);
    if (!handle) return null;
    const file = await handle.getFile();
    const key = `${path}@${file.lastModified}`;
    let url = this.urls.get(key);
    if (!url) {
      url = URL.createObjectURL(file);
      this.urls.set(key, url);
    }
    return url;
  }

  async addAsset(dir: string, baseName: string, file: Blob & { name?: string }): Promise<string> {
    if (!(await ensurePermission(this.root, "readwrite"))) throw new StorageError("permission_denied", "Permission to write was not granted");
    const folder = await getDir(this.root, dir ? dir.split("/") : [], true);
    if (!folder) throw new StorageError("create_folder_failed", `Could not create ${dir}`, { path: dir });
    const ext = imageExtension(file);
    let n = 1;
    let name = `${baseName}-${n}.${ext}`;
    while (await getFile(folder, name)) name = `${baseName}-${++n}.${ext}`;
    const handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return dir ? `${dir}/${name}` : name;
  }

  dispose() {
    this.poller.stop();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

/** One file opened with `showOpenFilePicker`: saved in place, but no folder for images or `.csvview.json`. */
export class FsFileBackend implements StorageBackend {
  readonly capabilities: BackendCapabilities = capabilities({});
  private readonly poller = new ChangePoller(async (path) =>
    path === this.handle.name ? String((await this.handle.getFile()).lastModified) : null,
  );

  constructor(readonly handle: FileSystemFileHandle) {}

  get name(): string {
    return this.handle.name;
  }

  async read(path: string): Promise<FileContent> {
    if (path !== this.handle.name) throw new NotFoundError(path);
    const { bytes, lastModified } = await readHandle(this.handle);
    return { bytes, version: String(lastModified) };
  }

  watch(path: string, version: string) {
    this.poller.track(path, version);
  }

  onExternalChange(listener: (paths: string[]) => void): () => void {
    return this.poller.subscribe(listener);
  }

  async save(changeSet: ChangeSet): Promise<SaveResult> {
    const f = changeSet.files.find((x) => x.path === this.handle.name && x.op === "put");
    if (!f?.bytes) return { ok: true, versions: {} };
    this.poller.paused = true;
    try {
      const now = String((await this.handle.getFile()).lastModified);
      if (!changeSet.force && f.baseVersion !== null && now !== f.baseVersion) {
        return { ok: false, conflict: { paths: [f.path], code: "modified_externally" } };
      }
      const version = String(await writeHandle(this.handle, f.bytes));
      this.poller.track(f.path, version);
      return { ok: true, versions: { [f.path]: version } };
    } catch (e) {
      return { ok: false, error: { code: "write_failed", message: (e as Error).message } };
    } finally {
      this.poller.paused = false;
    }
  }

  dispose() {
    this.poller.stop();
  }
}
