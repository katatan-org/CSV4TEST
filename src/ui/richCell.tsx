import { GridCellKind, type CustomCell, type CustomRenderer, type ProvideEditorComponent } from "@glideapps/glide-data-grid";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { BADGE_FONT, PAD_X, PAD_Y, TEXT_STYLE, badgeToken, type CellLayout } from "./cellLayout";
import { hitTest, isChip, type Layout, type Run } from "./richtext";
import { badgeColors, textColor, uiColors } from "./theme";
import type { ViewContext } from "./view";

export interface RichCellData {
  readonly kind: "rich-cell";
  readonly value: string;
  readonly recordId: number;
  readonly col: number;
  readonly dirty: boolean;
}
export type RichCell = CustomCell<RichCellData>;

export function richCell(data: RichCellData, bg?: string): RichCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: true,
    copyData: data.value,
    data,
    themeOverride: bg ? { bgCell: bg } : undefined,
  };
}

export const isRichCell = (c: { kind: GridCellKind; data?: unknown }): c is RichCell =>
  c.kind === GridCellKind.Custom && (c.data as RichCellData | undefined)?.kind === "rich-cell";

type ViewRef = MutableRefObject<ViewContext>;

/** Top-left of the text block inside the cell (text is vertically centered for id columns). */
function textOrigin(layout: CellLayout, cellHeight: number): number {
  if (layout.kind === "text" && layout.center) return Math.max(PAD_Y, (cellHeight - layout.height) / 2);
  return PAD_Y;
}

type Hit =
  | { kind: "run"; run: Run }
  | { kind: "thumb"; path: string }
  | { kind: "add" };

function hitCell(layout: CellLayout, x: number, y: number, cellHeight: number): Hit | undefined {
  const lx = x - PAD_X;
  const ly = y - textOrigin(layout, cellHeight);
  if (layout.kind === "text") {
    const run = hitTest(layout.layout, lx, ly, TEXT_STYLE.lineHeight);
    return run ? { kind: "run", run } : undefined;
  }
  if (layout.kind === "images") {
    const inBox = (b: { x: number; y: number; w: number; h: number }) => lx >= b.x && lx < b.x + b.w && ly >= b.y && ly < b.y + b.h;
    const thumb = layout.thumbs.find(inBox);
    if (thumb) return { kind: "thumb", path: thumb.path };
    if (layout.add && inBox(layout.add)) return { kind: "add" };
  }
  return undefined;
}

function isLinkRun(run: Run, view: ViewContext): boolean {
  return run.kind === "url" || (run.kind === "caseRef" && !!run.ref && view.idToRecord.has(run.ref));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  ox: number,
  oy: number,
  view: ViewContext,
  baseColor: string,
  align: "left" | "center" | "right",
  innerWidth: number,
) {
  const ui = uiColors(view.mode);
  const lh = TEXT_STYLE.lineHeight;
  ctx.textBaseline = "middle";
  for (const line of layout.lines) {
    const mid = oy + line.y + lh / 2;
    let shift = 0;
    if (align !== "left" && line.runs.length > 0) {
      const last = line.runs[line.runs.length - 1];
      const lineWidth = last.x + last.width;
      shift = align === "center" ? (innerWidth - lineWidth) / 2 : innerWidth - lineWidth;
    }
    for (const run of line.runs) {
      const x = ox + run.x + shift;
      ctx.font = run.font;
      if (run.kind === "prefix") {
        ctx.fillStyle = ui.textMuted;
        ctx.fillText(run.text, ox + layout.indent - TEXT_STYLE.prefixGap - run.width, mid);
        continue;
      }
      if (isChip(run.kind)) {
        const chip = ui.chip[run.kind as "var" | "literal" | "param"];
        ctx.fillStyle = chip.bg;
        roundRect(ctx, x, mid - lh / 2 + 2, run.width, lh - 4, 4);
        ctx.fill();
        ctx.fillStyle = chip.fg;
        ctx.fillText(run.text, x + TEXT_STYLE.chipPad, mid + 0.5);
        continue;
      }
      if (run.kind === "caseRef" || run.kind === "url") {
        const broken = run.kind === "caseRef" && !(run.ref && view.idToRecord.has(run.ref));
        ctx.fillStyle = broken ? ui.linkBroken : ui.link;
        ctx.fillText(run.text, x, mid);
        ctx.fillRect(x, mid + 8, run.width, 1);
        continue;
      }
      ctx.fillStyle = run.dim ? ui.textMuted : baseColor;
      ctx.fillText(run.text, x, mid);
    }
  }
}

export function createRichRenderer(viewRef: ViewRef): CustomRenderer<RichCell> {
  const editor = makeEditor(viewRef);
  return {
    kind: GridCellKind.Custom,
    isMatch: (c): c is RichCell => (c.data as RichCellData | undefined)?.kind === "rich-cell",
    needsHover: true,
    needsHoverPosition: true,
    draw: (args, cell) => {
      const view = viewRef.current;
      const { ctx, rect, theme } = args;
      const { col, value, dirty } = cell.data;
      const column = view.columns[col];
      const layout = view.layouts.get(col, rect.width, value);
      if (!column || !layout) return;
      const ui = uiColors(view.mode);

      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();

      const ox = rect.x + PAD_X;
      const oy = rect.y + textOrigin(layout, rect.height);
      const innerWidth = rect.width - PAD_X * 2;

      if (layout.kind === "text") {
        const base = textColor(view.mode, column.rule.color) ?? theme.textDark;
        drawTextLayout(ctx, layout.layout, ox, oy, view, base, column.rule.align ?? "left", innerWidth);
      } else if (layout.kind === "labels") {
        ctx.font = BADGE_FONT;
        ctx.textBaseline = "middle";
        for (const b of layout.badges) {
          const token = column.rule.display === "labels" ? view.labelColors[b.text] : badgeToken(column, b.text);
          const c = badgeColors(view.mode, token, b.text);
          ctx.fillStyle = c.bg;
          roundRect(ctx, ox + b.x, oy + b.y, b.w, b.h, 4);
          ctx.fill();
          ctx.fillStyle = c.fg;
          ctx.fillText(b.text, ox + b.x + 7, oy + b.y + b.h / 2 + 0.5, b.w - 12);
        }
      } else {
        drawImages(ctx, layout, ox, oy, view, cell.data, args.hoverX !== undefined ? hitCell(layout, args.hoverX, args.hoverY ?? 0, rect.height) : undefined);
      }

      if (dirty) {
        ctx.fillStyle = ui.dirty;
        ctx.beginPath();
        ctx.moveTo(rect.x, rect.y);
        ctx.lineTo(rect.x + 8, rect.y);
        ctx.lineTo(rect.x, rect.y + 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      if (args.hoverX !== undefined) {
        const hit = hitCell(layout, args.hoverX, args.hoverY ?? 0, rect.height);
        const pointer = hit && (hit.kind !== "run" || isLinkRun(hit.run, view));
        args.overrideCursor?.(pointer ? "pointer" : undefined);
        // A chip showing a variable's value: hint the `{{name}}` behind it.
        const resolved = hit?.kind === "run" && hit.run.kind === "var" && hit.run.ref !== undefined && !hit.run.text.startsWith("{{");
        view.onHint(resolved ? `{{${hit.run.ref}}}` : null);
      }
    },
    onClick: (args) => {
      const view = viewRef.current;
      const { col, value, recordId } = args.cell.data;
      const layout = view.layouts.get(col, args.bounds.width, value);
      if (!layout) return undefined;
      const hit = hitCell(layout, args.posX, args.posY, args.bounds.height);
      if (!hit) return undefined;
      if (hit.kind === "thumb") {
        args.preventDefault();
        view.onOpenImage(recordId, hit.path);
      } else if (hit.kind === "add") {
        args.preventDefault();
        view.onAddImage(recordId);
      } else if (hit.run.kind === "caseRef" && hit.run.ref && view.idToRecord.has(hit.run.ref)) {
        args.preventDefault();
        view.onJump(hit.run.ref);
      } else if (hit.run.kind === "url") {
        args.preventDefault();
        window.open(hit.run.text, "_blank", "noopener,noreferrer");
      }
      return undefined;
    },
    provideEditor: () => ({ editor, disablePadding: true }),
    onPaste: (val, data) => ({ ...data, value: val }),
  };
}

function drawImages(
  ctx: CanvasRenderingContext2D,
  layout: Extract<CellLayout, { kind: "images" }>,
  ox: number,
  oy: number,
  view: ViewContext,
  _data: RichCellData,
  hover: Hit | undefined,
) {
  const ui = uiColors(view.mode);
  ctx.textBaseline = "middle";
  for (const t of layout.thumbs) {
    const x = ox + t.x;
    const y = oy + t.y;
    const entry = view.images?.get(t.path) ?? { status: "unavailable" as const };
    ctx.fillStyle = ui.bgAlt;
    roundRect(ctx, x, y, t.w, t.h, 6);
    ctx.fill();
    if (entry.status === "ok" && entry.img) {
      const img = entry.img;
      const scale = Math.min((t.w - 8) / img.naturalWidth, (t.h - 8) / img.naturalHeight, 1);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, x + 4, y + (t.h - h) / 2, w, h);
    } else {
      ctx.font = TEXT_STYLE.font;
      ctx.fillStyle = entry.status === "missing" ? ui.linkBroken : ui.textMuted;
      const label = entry.status === "loading" ? "読み込み中…" : entry.status === "missing" ? "見つかりません" : "フォルダを開くと表示";
      ctx.fillText(label, x + 8, y + t.h / 2 - 9, t.w - 16);
      ctx.font = TEXT_STYLE.monoFont;
      ctx.fillText(t.path, x + 8, y + t.h / 2 + 10, t.w - 16);
    }
    ctx.strokeStyle = hover?.kind === "thumb" && hover.path === t.path ? ui.accent : ui.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, t.w - 1, t.h - 1, 6);
    ctx.stroke();
  }
  if (layout.add) {
    const a = layout.add;
    const hot = hover?.kind === "add";
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = hot ? ui.accent : ui.textMuted;
    roundRect(ctx, ox + a.x + 0.5, oy + a.y + 0.5, a.w - 1, a.h - 1, 5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `12px ${TEXT_STYLE.font.split("px ")[1]}`;
    ctx.fillStyle = hot ? ui.accent : ui.textMuted;
    ctx.fillText("＋ 画像を追加", ox + a.x + 10, oy + a.y + a.h / 2 + 0.5);
  }
}

interface Completion {
  items: string[];
  index: number;
  /** Text range replaced when an item is accepted. */
  from: number;
  to: number;
  kind: "var" | "label";
}

const MAX_ITEMS = 8;

function makeEditor(viewRef: ViewRef): ProvideEditorComponent<RichCell> {
  return function CellEditor({ value: cell, onChange, onFinishedEditing, initialValue, target }) {
    const view = viewRef.current;
    const column = view.columns[cell.data.col];
    const [text, setText] = useState(initialValue ?? cell.data.value);
    const [caret, setCaret] = useState<number | null>(null);
    const [completion, setCompletion] = useState<Completion | null>(null);
    const ref = useRef<HTMLTextAreaElement>(null);

    useLayoutEffect(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      // Offer existing labels right away in an empty labels cell.
      if (column?.rule.display === "labels" && ta.value.trim() === "") setCompletion(findCompletion(ta.value, end));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useLayoutEffect(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = `${Math.min(Math.max(ta.scrollHeight, target.height), 420)}px`;
    }, [text, target.height]);

    useEffect(() => {
      if (caret !== null && ref.current) {
        ref.current.setSelectionRange(caret, caret);
        setCaret(null);
      }
    }, [caret]);

    const cellWith = (v: string): RichCell => ({ ...cell, copyData: v, data: { ...cell.data, value: v } });

    const update = (v: string, pos: number) => {
      setText(v);
      onChange(cellWith(v));
      setCompletion(findCompletion(v, pos));
    };

    const findCompletion = (v: string, pos: number): Completion | null => {
      const before = v.slice(0, pos);
      if (view.features.variables) {
        const m = /\{\{([\w.-]*)$/.exec(before);
        if (m) {
          const q = m[1].toLowerCase();
          const items = view.variables.filter((n) => n.toLowerCase().includes(q) && n !== m[1]).slice(0, MAX_ITEMS);
          const closeAt = v.startsWith("}}", pos) ? pos + 2 : pos;
          return items.length > 0 ? { items, index: 0, from: pos - m[1].length, to: closeAt, kind: "var" } : null;
        }
      }
      if (column?.rule.display === "labels") {
        const lineStart = before.lastIndexOf("\n") + 1;
        let lineEnd = v.indexOf("\n", pos);
        if (lineEnd < 0) lineEnd = v.length;
        const q = v.slice(lineStart, lineEnd).trim().toLowerCase();
        const used = new Set(v.split("\n").map((s) => s.trim()));
        const items = view.labels.filter((l) => !used.has(l) && l.toLowerCase().includes(q)).slice(0, MAX_ITEMS);
        return items.length > 0 ? { items, index: 0, from: lineStart, to: lineEnd, kind: "label" } : null;
      }
      return null;
    };

    const accept = (c: Completion) => {
      const item = c.items[c.index];
      const insert = c.kind === "var" ? `${item}}}` : item;
      const v = text.slice(0, c.from) + insert + text.slice(c.to);
      const pos = c.from + insert.length;
      setText(v);
      onChange(cellWith(v));
      setCompletion(null);
      setCaret(pos);
    };

    const insertNewline = () => {
      const ta = ref.current!;
      const start = ta.selectionStart;
      const v = text.slice(0, start) + "\n" + text.slice(ta.selectionEnd);
      update(v, start + 1);
      setCaret(start + 1);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (completion) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          stop();
          const d = e.key === "ArrowDown" ? 1 : -1;
          setCompletion({ ...completion, index: (completion.index + d + completion.items.length) % completion.items.length });
          return;
        }
        if ((e.key === "Enter" && !e.altKey && !e.shiftKey) || e.key === "Tab") {
          stop();
          accept(completion);
          return;
        }
        if (e.key === "Escape") {
          stop();
          setCompletion(null);
          return;
        }
      }
      if (e.key === "Enter" && (e.altKey || e.shiftKey)) {
        stop();
        insertNewline();
      } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        stop();
        onFinishedEditing(cellWith(text), [0, e.ctrlKey || e.metaKey ? 0 : 1]);
      } else if (e.key === "Tab") {
        stop();
        onFinishedEditing(cellWith(text), [e.shiftKey ? -1 : 1, 0]);
      } else if (e.key === "Escape") {
        stop();
        onFinishedEditing(undefined, [0, 0]);
      }
    };

    const width = Math.max(target.width, column?.rule.wrap ? 320 : 200);
    const hint = useMemo(
      () => (column?.rule.display === "labels" ? "1行に1ラベル" : column?.rule.display === "images" ? "1行に1パス" : null),
      [column],
    );

    return (
      <div className="cell-editor" style={{ width }}>
        <textarea
          ref={ref}
          value={text}
          spellCheck={false}
          className={column?.rule.font === "mono" ? "mono" : undefined}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onClick={(e) => setCompletion(findCompletion(text, e.currentTarget.selectionStart))}
        />
        <div className="cell-editor-hint">
          <span>Enter 確定</span>
          <span>Alt+Enter 改行</span>
          <span>Esc 取消</span>
          {view.features.variables && <span>{"{{"} で変数補完</span>}
          {hint && <span>{hint}</span>}
        </div>
        {completion && (
          <ul className="completion" role="listbox">
            {completion.items.map((item, i) => (
              <li
                key={item}
                role="option"
                aria-selected={i === completion.index}
                className={i === completion.index ? "active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept({ ...completion, index: i });
                }}
              >
                {completion.kind === "var" ? `{{${item}}}` : item}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };
}
