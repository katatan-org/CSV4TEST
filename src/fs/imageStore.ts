import { dirOf, joinPath, resolvePath, StorageError, type StorageBackend } from "../storage/types";

export type ImageStatus = "loading" | "ok" | "missing" | "unavailable";

export interface ImageEntry {
  status: ImageStatus;
  img?: HTMLImageElement;
  url?: string;
}

/**
 * Loads images referenced by relative paths in the Images column, and adds new
 * ones to the CSV's assets folder, through the storage backend.
 */
export class ImageStore {
  private cache = new Map<string, ImageEntry>();
  private readonly baseDir: string;

  constructor(
    private readonly backend: StorageBackend,
    csvPath: string,
    private readonly onLoaded: () => void,
  ) {
    this.baseDir = dirOf(csvPath);
  }

  get writable(): boolean {
    const c = this.backend.capabilities;
    return c.images && !c.readOnly && typeof this.backend.addAsset === "function";
  }

  /** Path from the backend root, or null for URLs and paths outside the root. */
  fullPath(path: string): string | null {
    return resolvePath(this.baseDir, path);
  }

  get(path: string): ImageEntry {
    const cached = this.cache.get(path);
    if (cached) return cached;
    if (/^https?:\/\//i.test(path)) return this.loadUrl(path, path);
    const full = this.fullPath(path);
    if (!this.backend.assetUrl || !full) {
      const entry: ImageEntry = { status: full ? "unavailable" : "missing" };
      this.cache.set(path, entry);
      return entry;
    }
    const entry: ImageEntry = { status: "loading" };
    this.cache.set(path, entry);
    this.backend.assetUrl(full).then(
      (url) => {
        if (this.cache.get(path) !== entry) return;
        if (url) this.loadUrl(path, url);
        else {
          this.cache.set(path, { status: "missing" });
          this.onLoaded();
        }
      },
      () => {
        if (this.cache.get(path) !== entry) return;
        this.cache.set(path, { status: "missing" });
        this.onLoaded();
      },
    );
    return entry;
  }

  private loadUrl(path: string, url: string): ImageEntry {
    const img = new Image();
    const entry: ImageEntry = { status: "loading", url };
    this.cache.set(path, entry);
    img.onload = () => {
      if (this.cache.get(path) !== entry) return;
      this.cache.set(path, { status: "ok", img, url });
      this.onLoaded();
    };
    img.onerror = () => {
      if (this.cache.get(path) !== entry) return;
      this.cache.set(path, { status: "missing", url });
      this.onLoaded();
    };
    img.src = url;
    return entry;
  }

  /**
   * Stores an image as `<assetsDir>/<baseName>-<n>.<ext>` next to the CSV and
   * returns the path to write in the cell (relative to the CSV).
   */
  async add(file: Blob & { name?: string }, assetsDir: string, baseName: string): Promise<string> {
    if (!this.writable || !this.backend.addAsset) throw new StorageError("images_unavailable", "Images cannot be added to this file");
    const full = await this.backend.addAsset(joinPath(this.baseDir, assetsDir), baseName, file);
    const relative = this.baseDir && full.startsWith(`${this.baseDir}/`) ? full.slice(this.baseDir.length + 1) : full;
    this.cache.delete(relative);
    return relative;
  }

  /** Forget everything, e.g. after the file was reloaded. */
  clear(): void {
    this.cache.clear();
  }
}

export function assetsDirFor(template: string, csvName: string): string {
  return template.replace(/\{name\}/g, csvName.replace(/\.[^.]+$/, ""));
}
