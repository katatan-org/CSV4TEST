/**
 * A backend that keeps files in memory. Used for the bundled sample, for files
 * opened by upload (saved as a download), and in tests.
 */
import { imageExtension } from "./fsAccess";
import {
  capabilities as makeCapabilities,
  NotFoundError,
  type BackendCapabilities,
  type ChangeSet,
  type FileContent,
  type SaveResult,
  type StorageBackend,
  type TreeEntry,
  type VariableDef,
} from "./types";

export interface MemoryBackendOptions {
  files?: Record<string, Uint8Array | string>;
  capabilities?: Partial<BackendCapabilities>;
  /** Called after the files are updated, e.g. to download them. */
  onSave?: (changeSet: ChangeSet) => void | Promise<void>;
  /** Defined `{{variable}}`s (left out: the backend has none). */
  variables?: VariableDef[];
}

export class MemoryBackend implements StorageBackend {
  readonly capabilities: BackendCapabilities;
  private readonly files = new Map<string, { bytes: Uint8Array; version: string }>();
  private readonly urls = new Map<string, string>();
  private readonly listeners = new Set<(paths: string[]) => void>();
  private counter = 0;
  readonly variables?: () => Promise<VariableDef[]>;
  /** Every change set saved so far, oldest first (handy in tests). */
  readonly saved: ChangeSet[] = [];

  constructor(private readonly options: MemoryBackendOptions = {}) {
    this.capabilities = makeCapabilities({ tree: true, images: true, ...options.capabilities });
    for (const [path, content] of Object.entries(options.files ?? {})) this.put(path, content);
    const { variables } = options;
    if (variables) this.variables = async () => variables;
  }

  private nextVersion(): string {
    return `m${++this.counter}`;
  }

  /** Replaces a file as if someone else changed it, and notifies listeners. */
  put(path: string, content: Uint8Array | string, notify = false): string {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const version = this.nextVersion();
    this.files.set(path, { bytes, version });
    if (notify) for (const l of this.listeners) l([path]);
    return version;
  }

  get(path: string): Uint8Array | undefined {
    return this.files.get(path)?.bytes;
  }

  async listTree(): Promise<TreeEntry[]> {
    return [...this.files.entries()]
      .map(([path, f]) => ({ path, version: f.version, size: f.bytes.length }))
      .sort((a, b) => a.path.localeCompare(b.path, "ja", { numeric: true }));
  }

  async read(path: string): Promise<FileContent> {
    const f = this.files.get(path);
    if (!f) throw new NotFoundError(path);
    return { bytes: f.bytes, version: f.version };
  }

  async save(changeSet: ChangeSet): Promise<SaveResult> {
    if (!changeSet.force) {
      const moved = changeSet.files.filter((f) => f.baseVersion !== null && this.files.get(f.path)?.version !== f.baseVersion).map((f) => f.path);
      if (moved.length > 0) return { ok: false, conflict: { paths: moved } };
    }
    const versions: Record<string, string> = {};
    for (const f of changeSet.files) {
      if (f.op === "delete") this.files.delete(f.path);
      else if (f.bytes) versions[f.path] = this.put(f.path, f.bytes);
    }
    this.saved.push(changeSet);
    await this.options.onSave?.(changeSet);
    return { ok: true, versions };
  }

  async assetUrl(path: string): Promise<string | null> {
    const f = this.files.get(path);
    if (!f) return null;
    const key = `${path}@${f.version}`;
    let url = this.urls.get(key);
    if (!url) {
      url = URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>]));
      this.urls.set(key, url);
    }
    return url;
  }

  async addAsset(dir: string, baseName: string, file: Blob & { name?: string }): Promise<string> {
    const ext = imageExtension(file);
    const prefix = dir ? `${dir}/` : "";
    let n = 1;
    while (this.files.has(`${prefix}${baseName}-${n}.${ext}`)) n++;
    const path = `${prefix}${baseName}-${n}.${ext}`;
    this.put(path, new Uint8Array(await file.arrayBuffer()));
    return path;
  }

  onExternalChange(listener: (paths: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
