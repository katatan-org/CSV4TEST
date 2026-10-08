import type { ColorToken, ResolvedColumn } from "../rules/schema";
import { cellLines, tokenize, type Token } from "../rules/tokens";
import { layoutText, type Layout, type Measure, type Paragraph, type TextStyle } from "./richtext";
import { FONT_MONO, FONT_SANS } from "./theme";

export const PAD_X = 10;
export const PAD_Y = 8;
export const MIN_ROW_HEIGHT = 36;
export const MAX_ROW_HEIGHT = 1200;
export const BADGE_H = 20;
export const BADGE_GAP = 5;
export const THUMB_H = 84;
export const THUMB_GAP = 6;
export const ADD_BUTTON_H = 26;

export const TEXT_STYLE: TextStyle = {
  font: `13px ${FONT_SANS}`,
  boldFont: `600 13px ${FONT_SANS}`,
  monoFont: `12px ${FONT_MONO}`,
  lineHeight: 21,
  chipPad: 3,
  prefixGap: 6,
  paragraphGap: 3,
};
export const BADGE_FONT = `500 11.5px ${FONT_SANS}`;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CellLayout =
  | { kind: "text"; layout: Layout; height: number; center: boolean }
  | { kind: "labels"; badges: (Box & { text: string })[]; height: number }
  | { kind: "images"; thumbs: (Box & { path: string })[]; add: Box | null; height: number };

export interface LayoutOptions {
  column: ResolvedColumn;
  width: number;
  caseRef?: string;
  /** Values shown in place of `{{name}}` chips. */
  variableValues?: ReadonlyMap<string, string>;
  /** Images can only be added when the CSV's folder is writable. */
  canAddImages: boolean;
}

/** Positions are relative to the cell's content box (inside PAD_X / PAD_Y). */
export function layoutCell(value: string, opts: LayoutOptions, measure: Measure): CellLayout {
  const { rule } = opts.column;
  const inner = Math.max(20, opts.width - PAD_X * 2);

  if (rule.display === "labels" || (rule.badge && value.trim() !== "")) {
    const badges = cellLines(value).map((text, i) => {
      const w = Math.min(inner, measure(text, BADGE_FONT) + 14);
      return { text, x: 0, y: i * (BADGE_H + BADGE_GAP), w, h: BADGE_H };
    });
    return { kind: "labels", badges, height: Math.max(BADGE_H, badges.length * (BADGE_H + BADGE_GAP) - BADGE_GAP) };
  }

  if (rule.display === "images") {
    const paths = cellLines(value);
    const thumbs = paths.map((path, i) => ({ path, x: 0, y: i * (THUMB_H + THUMB_GAP), w: inner, h: THUMB_H }));
    const top = paths.length * (THUMB_H + THUMB_GAP);
    const add = opts.canAddImages ? { x: 0, y: top, w: inner, h: ADD_BUTTON_H } : null;
    const height = add ? top + ADD_BUTTON_H : Math.max(TEXT_STYLE.lineHeight, top - THUMB_GAP);
    return { kind: "images", thumbs, add, height };
  }

  const paragraphs = toParagraphs(value, opts.column, opts.caseRef, opts.variableValues);
  const wrap = rule.wrap ?? false;
  const layout = layoutText(wrap ? paragraphs : paragraphs.slice(0, 1), wrap ? inner : Infinity, TEXT_STYLE, measure);
  return { kind: "text", layout, height: layout.height, center: rule.display === "id" };
}

function toParagraphs(
  value: string,
  column: ResolvedColumn,
  caseRef: string | undefined,
  variableValues: ReadonlyMap<string, string> | undefined,
): Paragraph[] {
  const { rule } = column;
  const bold = rule.bold;
  if (value === "") {
    return rule.placeholder ? [{ tokens: [{ kind: "plain", text: rule.placeholder }], dim: true }] : [{ tokens: [] }];
  }
  const shown = rule.format ? rule.format.replace(/\{value\}/g, value) : value;
  const lines = shown.split(/\r\n|\r|\n/);
  const tokens = rule.tokens ?? false;
  const tokenizeLine = (line: string) => resolveVariables(tokenize(line, tokens, caseRef), variableValues);

  if (rule.display === "steps") {
    let n = 0;
    return lines.map((line) => ({
      tokens: tokenizeLine(line),
      prefix: line.trim() === "" ? undefined : `${++n}.`,
      bold,
    }));
  }
  return lines.map((line) => ({ tokens: tokenizeLine(line), bold }));
}

/**
 * Shows a defined variable's value in its chip; `ref` keeps the name. An empty value
 * would leave an empty chip, so `{{name}}` stays then.
 */
function resolveVariables(tokens: Token[], values: ReadonlyMap<string, string> | undefined): Token[] {
  if (!values || values.size === 0) return tokens;
  return tokens.map((t) => {
    const value = t.kind === "var" && t.ref !== undefined ? values.get(t.ref) : undefined;
    return value ? { ...t, text: value.replace(/\r\n|\r|\n/g, " ") } : t;
  });
}

export function cellHeight(layout: CellLayout): number {
  return layout.height + PAD_Y * 2;
}

/** Color for a value in a `badge` column. */
export function badgeToken(column: ResolvedColumn, value: string): ColorToken | undefined {
  const badge = column.rule.badge;
  if (!badge || badge === "auto") return undefined;
  return badge[value.trim()];
}
