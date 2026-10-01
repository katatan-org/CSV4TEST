export type TokenKind = "plain" | "var" | "literal" | "param" | "caseRef" | "url";

export interface Token {
  kind: TokenKind;
  text: string;
  /** For `caseRef`: the referenced id. For `var`: the variable name. */
  ref?: string;
}

const BASE_TOKEN_RE = String.raw`(\{\{[^{}\n]*\}\})|(https?:\/\/[^\s'"<>]+)|((?<![\w'])'[^'\n]+'(?![\w]))|((?<!\{)\{[A-Za-z_][\w]*\}(?!\}))`;
export const DEFAULT_CASE_REF = String.raw`case-(\d+)`;
const tokenRes = new Map<string, RegExp>();

function tokenRe(caseRef: string | undefined): RegExp {
  const key = caseRef ?? "";
  let re = tokenRes.get(key);
  if (!re) {
    // The case-ref pattern's first capture group is the referenced id.
    re = new RegExp(caseRef ? `${BASE_TOKEN_RE}|((?<![\\w-])${caseRef.replace(/\((?!\?)/, "(?<id>")}(?![\\w]))` : BASE_TOKEN_RE, "g");
    tokenRes.set(key, re);
  }
  return re;
}

/**
 * Splits text into plain runs and highlightable tokens.
 * `caseRef` is a pattern like `case-(\d+)` whose first group is the referenced id.
 */
export function tokenize(text: string, enabled = true, caseRef?: string): Token[] {
  if (!enabled || text === "") return [{ kind: "plain", text }];
  const out: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(tokenRe(caseRef))) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "plain", text: text.slice(last, start) });
    if (m[1]) out.push({ kind: "var", text: m[1], ref: m[1].slice(2, -2).trim() });
    else if (m[2]) {
      // Trailing punctuation usually belongs to the sentence, not the URL.
      const url = m[2].replace(/[.,;:!?)\]]+$/, "");
      out.push({ kind: "url", text: url });
      if (url.length < m[2].length) out.push({ kind: "plain", text: m[2].slice(url.length) });
    }
    else if (m[3]) out.push({ kind: "literal", text: m[3] });
    else if (m[4]) out.push({ kind: "param", text: m[4] });
    else out.push({ kind: "caseRef", text: m[5], ref: m.groups?.id ?? m[5] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}

/** All `{{name}}` occurrences in a value. */
export function variablesIn(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/\{\{([^{}\n]*)\}\}/g)) names.push(m[1].trim());
  return names;
}

/** True when a `{{` has no matching `}}` on the same line. */
export function hasUnclosedVariable(text: string): boolean {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line.replace(/\{\{[^{}]*\}\}/g, "");
    if (stripped.includes("{{")) return true;
  }
  return false;
}

/** Splits a multi-value cell (labels, image paths) into its non-empty lines. */
export function cellLines(value: string): string[] {
  return value
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
