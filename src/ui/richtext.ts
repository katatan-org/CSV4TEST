import type { Token, TokenKind } from "../rules/tokens";

/** Measures the width of `text` in CSS pixels using `font` (a CSS font shorthand). */
export type Measure = (text: string, font: string) => number;

export interface TextStyle {
  font: string;
  boldFont: string;
  monoFont: string;
  lineHeight: number;
  /** Horizontal padding inside chips (variables, literals, params). */
  chipPad: number;
  /** Gap between the step number and the text. */
  prefixGap: number;
  /** Extra space between paragraphs. */
  paragraphGap: number;
}

export interface Paragraph {
  tokens: Token[];
  /** Drawn in a hanging-indent gutter, e.g. "3." for steps. */
  prefix?: string;
  bold?: boolean;
  /** Draw dimmed (placeholders). */
  dim?: boolean;
}

export interface Run {
  text: string;
  kind: TokenKind | "prefix";
  x: number;
  width: number;
  font: string;
  ref?: string;
  dim?: boolean;
}

export interface Line {
  y: number;
  runs: Run[];
}

export interface Layout {
  lines: Line[];
  height: number;
  /** Width of the prefix gutter (0 when no paragraph has a prefix). */
  indent: number;
}

const CHIP_KINDS = new Set<TokenKind>(["var", "literal", "param"]);
export const isChip = (kind: Run["kind"]) => CHIP_KINDS.has(kind as TokenKind);

// Breakable units: whitespace, single CJK characters, or runs of other characters.
const PIECE_RE = /\s+|[⺀-鿿가-힯豈-﫿＀-￯]|[^\s⺀-鿿가-힯豈-﫿＀-￯]+/g;

interface Piece {
  text: string;
  kind: TokenKind;
  ref?: string;
  font: string;
  width: number;
  space: boolean;
  /** Chips are kept whole when possible. */
  chip: boolean;
}

/**
 * Lays out paragraphs into wrapped lines. `maxWidth` of Infinity disables wrapping.
 * Pure: all measuring goes through `measure`, so it runs in tests without a canvas.
 */
export function layoutText(paragraphs: Paragraph[], maxWidth: number, style: TextStyle, measure: Measure): Layout {
  const prefixes = paragraphs.filter((p) => p.prefix);
  const indent =
    prefixes.length > 0 ? Math.max(...prefixes.map((p) => measure(p.prefix!, style.font))) + style.prefixGap : 0;
  const avail = Math.max(16, maxWidth - indent);

  const lines: Line[] = [];
  let y = 0;
  paragraphs.forEach((para, pi) => {
    if (pi > 0) y += style.paragraphGap;
    const baseFont = para.bold ? style.boldFont : style.font;
    const pieces = toPieces(para.tokens, baseFont, style, measure);

    let runs: Run[] = [];
    let x = 0;
    const flush = () => {
      // Drop trailing whitespace on the line.
      while (runs.length > 0 && !isChip(runs[runs.length - 1].kind) && runs[runs.length - 1].kind !== "prefix") {
        const last = runs[runs.length - 1];
        const trimmed = last.text.trimEnd();
        if (trimmed === last.text) break;
        if (trimmed === "") {
          runs.pop();
          continue;
        }
        last.text = trimmed;
        last.width = measure(trimmed, last.font);
        break;
      }
      lines.push({ y, runs });
      y += style.lineHeight;
      runs = [];
      x = 0;
    };
    const push = (p: Piece, text: string, width: number) => {
      const last = runs[runs.length - 1];
      if (last && !p.chip && last.kind === p.kind && last.font === p.font && !isChip(last.kind)) {
        last.text += text;
        last.width += width;
      } else {
        runs.push({ text, kind: p.kind, x: indent + x, width, font: p.font, ref: p.ref, dim: para.dim });
      }
      x += width;
    };

    if (para.prefix) {
      runs.push({ text: para.prefix, kind: "prefix", x: 0, width: measure(para.prefix, style.font), font: style.font });
    }

    for (const p of pieces) {
      if (p.space && x === 0) continue;
      if (x + p.width <= avail || maxWidth === Infinity) {
        push(p, p.text, p.width);
        continue;
      }
      if (p.space) {
        flush();
        continue;
      }
      if (x > 0 && p.width <= avail) {
        flush();
        push(p, p.text, p.width);
        continue;
      }
      // Wider than a whole line: break by characters.
      let chunk = "";
      let chunkW = 0;
      for (const ch of p.text) {
        const w = measure(ch, p.font);
        const pad = p.chip ? style.chipPad * 2 : 0;
        if (x + chunkW + w + pad > avail && (chunk !== "" || x > 0)) {
          if (chunk !== "") push(p, chunk, chunkW + pad);
          flush();
          chunk = "";
          chunkW = 0;
        }
        chunk += ch;
        chunkW += w;
      }
      if (chunk !== "") push(p, chunk, chunkW + (p.chip ? style.chipPad * 2 : 0));
    }
    flush();
  });
  return { lines, height: y, indent };
}

function toPieces(tokens: Token[], baseFont: string, style: TextStyle, measure: Measure): Piece[] {
  const out: Piece[] = [];
  for (const t of tokens) {
    if (CHIP_KINDS.has(t.kind)) {
      out.push({
        text: t.text,
        kind: t.kind,
        ref: t.ref,
        font: style.monoFont,
        width: measure(t.text, style.monoFont) + style.chipPad * 2,
        space: false,
        chip: true,
      });
      continue;
    }
    for (const m of t.text.matchAll(PIECE_RE)) {
      const text = m[0];
      const space = /^\s+$/.test(text);
      out.push({ text, kind: t.kind, ref: t.ref, font: baseFont, width: measure(text, baseFont), space, chip: false });
    }
  }
  return out;
}

/** The run under a point (relative to the text origin), if any. */
export function hitTest(layout: Layout, x: number, y: number, lineHeight: number): Run | undefined {
  for (const line of layout.lines) {
    if (y < line.y || y >= line.y + lineHeight) continue;
    return line.runs.find((r) => x >= r.x && x < r.x + r.width);
  }
  return undefined;
}
