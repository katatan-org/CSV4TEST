import type { CsvRecord } from "../csv/types";
import type { ImageStore } from "../fs/imageStore";
import type { ColorToken, ResolvedColumn, RuleSet } from "../rules/schema";
import { layoutCell, type CellLayout } from "./cellLayout";
import type { Measure } from "./richtext";
import type { ThemeMode } from "./theme";

/**
 * Everything the canvas renderer and the cell editor need besides the cell
 * itself. Held in a ref so Glide's renderers (created once) always see the
 * latest state.
 */
export interface ViewContext {
  mode: ThemeMode;
  columns: ResolvedColumn[];
  features: NonNullable<RuleSet["features"]>;
  labelColors: Record<string, ColorToken>;
  idToRecord: Map<string, number>;
  originals: ReadonlyMap<number, CsvRecord>;
  /** Current column → loaded column (see columnMapping). */
  columnMap: (number | null)[];
  images: ImageStore | null;
  variables: string[];
  labels: string[];
  layouts: LayoutCache;
  onJump(ref: string): void;
  onOpenImage(recordId: number, path: string): void;
  onAddImage(recordId: number): void;
  /** Shows a hover hint for the grid (e.g. `{{name}}` behind a value), or clears it. */
  onHint(text: string | null): void;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, Map<string, number>>();

/** Canvas text measurement with a per-font cache. */
export const measureText: Measure = (text, font) => {
  let byFont = widthCache.get(font);
  if (!byFont) {
    byFont = new Map();
    widthCache.set(font, byFont);
  }
  let w = byFont.get(text);
  if (w === undefined) {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    if (!measureCtx) return text.length * 7;
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
    if (byFont.size > 50_000) byFont.clear();
    byFont.set(text, w);
  }
  return w;
};

/**
 * Cell layouts keyed by column, width and value. A new cache is created when
 * rules change; widths are part of the key, so resizing just adds entries.
 */
export class LayoutCache {
  private map = new Map<string, CellLayout>();

  constructor(
    private readonly columns: ResolvedColumn[],
    private readonly caseRef: string | undefined,
    private readonly canAddImages: boolean,
    private readonly variableValues?: ReadonlyMap<string, string>,
  ) {}

  get(col: number, width: number, value: string): CellLayout | undefined {
    const column = this.columns[col];
    if (!column) return undefined;
    const key = `${col}\u0000${Math.round(width)}\u0000${value}`;
    let layout = this.map.get(key);
    if (!layout) {
      layout = layoutCell(
        value,
        { column, width, caseRef: this.caseRef, canAddImages: this.canAddImages, variableValues: this.variableValues },
        measureText,
      );
      if (this.map.size > 100_000) this.map.clear();
      this.map.set(key, layout);
    }
    return layout;
  }
}
