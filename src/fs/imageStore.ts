import { getDir, getFile, resolveRelative, type FileLocation } from "./fileAccess";

export type ImageStatus = "loading" | "ok" | "missing" | "unavailable";

export interface ImageEntry {
  status: ImageStatus;
  img?: HTMLImageElement;
  url?: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/**
 * Loads images referenced by relative paths in the Images column and writes
 * new ones into the CSV's assets folder. Needs the folder the CSV is in, so it
 * only works when a folder was opened.
 */
export class ImageStore {
  private cache = new Map<string, ImageEntry>();

  constructor(
    private readonly location: FileLocation,
    private readonly onLoaded: () => void,
  ) {}

  get writable(): boolean {
    return this.location.root !== null;
  }

  get(path: string): ImageEntry {
    const cached = this.cache.get(path);
    if (cached) return cached;
    if (/^https?:\/\//i.test(path)) return this.loadUrl(path, path);
    if (!this.location.root) {
      const entry: ImageEntry = { status: "unavailable" };
      this.cache.set(path, entry);
      return entry;
    }
    const entry: ImageEntry = { status: "loading" };
    this.cache.set(path, entry);
    void this.resolve(path).then(async (file) => {
      if (!file) {
        this.cache.set(path, { status: "missing" });
        this.onLoaded();
        return;
      }
      this.loadUrl(path, URL.createObjectURL(file));
    });
    return entry;
  }

  private loadUrl(path: string, url: string): ImageEntry {
    const img = new Image();
    const entry: ImageEntry = { status: "loading", url };
    this.cache.set(path, entry);
    img.onload = () => {
      this.cache.set(path, { status: "ok", img, url });
      this.onLoaded();
    };
    img.onerror = () => {
      this.cache.set(path, { status: "missing", url });
      this.onLoaded();
    };
    img.src = url;
    return entry;
  }

  async resolve(path: string): Promise<File | null> {
    const { root, dirSegments } = this.location;
    if (!root) return null;
    const segs = resolveRelative(dirSegments, path);
    if (!segs) return null;
    const dir = await getDir(root, segs.slice(0, -1));
    const handle = dir && (await getFile(dir, segs[segs.length - 1]));
    return handle ? handle.getFile() : null;
  }

  /**
   * Copies an image into `<assetsDir>/<baseName>-<n>.<ext>` next to the CSV and
   * returns the path to store in the cell (relative to the CSV).
   */
  async add(file: Blob & { name?: string }, assetsDir: string, baseName: string): Promise<string> {
    const { root, dirSegments } = this.location;
    if (!root) throw new Error("画像を追加するにはフォルダを開いてください");
    const dir = await getDir(root, [...dirSegments, assetsDir], true);
    if (!dir) throw new Error(`${assetsDir} を作成できませんでした`);

    const ext = EXT_BY_TYPE[file.type] ?? file.name?.split(".").pop()?.toLowerCase() ?? "png";
    let n = 1;
    let name = `${baseName}-${n}.${ext}`;
    while (await getFile(dir, name)) name = `${baseName}-${++n}.${ext}`;

    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return `${assetsDir}/${name}`;
  }

  /** Every file in the assets folder, as paths relative to the CSV. */
  async listAssets(assetsDir: string): Promise<string[]> {
    const { root, dirSegments } = this.location;
    if (!root) return [];
    const dir = await getDir(root, [...dirSegments, assetsDir]);
    if (!dir) return [];
    const out: string[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && !entry.name.startsWith(".")) out.push(`${assetsDir}/${entry.name}`);
    }
    return out.sort();
  }

  /** Forget everything (e.g. after the file was reloaded) and free object URLs. */
  clear(): void {
    for (const e of this.cache.values()) if (e.url?.startsWith("blob:")) URL.revokeObjectURL(e.url);
    this.cache.clear();
  }
}

export function assetsDirFor(template: string, csvName: string): string {
  return template.replace(/\{name\}/g, csvName.replace(/\.[^.]+$/, ""));
}
