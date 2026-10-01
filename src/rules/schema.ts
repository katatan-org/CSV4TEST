export const HUES = ["green", "red", "amber", "blue", "purple", "teal", "pink", "orange", "gray"] as const;
export type Hue = (typeof HUES)[number];

/**
 * Colors are named tokens resolved per theme (light/dark) at render time.
 * `<hue>` is a badge/chip color, `<hue>-soft` a cell/row background, `muted` dim text.
 */
export type ColorToken = Hue | `${Hue}-soft` | "muted" | "default";

/** How a cell's text is laid out. */
export type CellDisplay =
  | "text" // wrapped or single-line text with optional token highlighting
  | "steps" // one step per line, numbered when drawn (numbers are not stored)
  | "labels" // one label per line, drawn as badges
  | "images" // one relative image path per line, drawn as thumbnails
  | "id"; // short identifier, vertically centered

export interface ColumnRule {
  /** Header name (case/space-insensitive) or a `/regex/` matched against the header. */
  match: string;
  width?: number;
  pinned?: boolean;
  wrap?: boolean;
  font?: "sans" | "mono";
  bold?: boolean;
  align?: "left" | "center" | "right";
  color?: ColorToken;
  background?: ColorToken;
  display?: CellDisplay;
  /** Display template; `{value}` is replaced by the cell value. Data is never changed. */
  format?: string;
  /** Text drawn dimmed when the cell is empty. */
  placeholder?: string;
  /** Highlight `{{var}}`, `'literal'`, `{param}`, `case-N` and URLs. */
  tokens?: boolean;
  /** Value → color badges. `"auto"` derives a stable color from the value. */
  badge?: Record<string, ColorToken> | "auto";
}

export interface RowRule {
  when: { column: string; equals?: string; regex?: string; empty?: boolean };
  background?: ColorToken;
  color?: ColorToken;
  bold?: boolean;
}

export interface RuleSet {
  name: string;
  /** Preset this rule set builds on (used by `.csvview.json`). */
  extends?: string;
  detect?: { requiredHeaders: string[] };
  columns: ColumnRule[];
  rows?: RowRule[];
  /** Fixed colors for known labels in `display: "labels"` columns. Others get a stable hashed color. */
  labelColors?: Record<string, ColorToken>;
  /** Derive column rules from the data for columns no rule matches. */
  infer?: boolean;
  features?: {
    /** Numeric id column: new rows get max + 1, duplicates are flagged. */
    idColumn?: string;
    /** References between rows, e.g. `case-3` → the row whose id column is 3. */
    caseRef?: { pattern: string; idColumn: string };
    /** `{{name}}` variables: completion, index panel and unclosed-brace warnings. */
    variables?: boolean;
    /** Column holding image paths relative to the CSV; new images go to `assetsDir`. */
    images?: { column: string; assetsDir: string };
    /** Columns the format defines but a file may omit; offered as "add column". */
    optionalColumns?: { name: string; after: string }[];
  };
}

/** A column of the open file with the rule that applies to it. */
export interface ResolvedColumn {
  index: number;
  header: string;
  rule: ColumnRule;
}

export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

export function headerMatches(match: string, header: string): boolean {
  const re = /^\/(.*)\/([a-z]*)$/.exec(match);
  if (re) {
    try {
      return new RegExp(re[1], re[2] || "i").test(header);
    } catch {
      return false;
    }
  }
  return normalizeHeader(match) === normalizeHeader(header);
}
