import type { ColumnRule, RuleSet } from "../schema";

/** Any CSV: column rules are inferred from the data. */
export const genericPreset: RuleSet = {
  name: "generic",
  columns: [],
  infer: true,
};

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;
const DATE = /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
const URL = /^https?:\/\/\S+$/;

/** Derives a display rule for one column from a sample of its values. */
export function inferColumnRule(header: string, values: string[]): ColumnRule {
  const filled = values.filter((v) => v.trim() !== "");
  const rule: ColumnRule = { match: header };
  if (filled.length === 0) return { ...rule, width: clampWidth(header.length * 9 + 40) };

  const ratio = (re: RegExp) => filled.filter((v) => re.test(v.trim())).length / filled.length;
  const maxLen = Math.max(header.length, ...filled.map((v) => longestLine(v)));
  const multiline = filled.some((v) => v.includes("\n"));
  const avgLen = filled.reduce((n, v) => n + v.length, 0) / filled.length;

  if (ratio(NUMBER) >= 0.9) return { ...rule, align: "right", font: "mono", width: clampWidth(maxLen * 9 + 24) };
  if (ratio(DATE) >= 0.9) return { ...rule, font: "mono", width: clampWidth(maxLen * 8 + 24) };
  if (ratio(URL) >= 0.9) return { ...rule, tokens: true, width: 260, wrap: true };

  const distinct = new Set(filled.map((v) => v.trim()));
  if (filled.length >= 4 && distinct.size <= 8 && distinct.size < filled.length && maxLen <= 24 && !multiline) {
    return { ...rule, badge: "auto", width: clampWidth(maxLen * 8 + 40) };
  }

  if (multiline || avgLen > 40) return { ...rule, wrap: true, tokens: true, width: clampWidth(Math.max(240, Math.min(maxLen, 48) * 8)) };
  return { ...rule, tokens: true, width: clampWidth(maxLen * 8 + 32) };
}

function longestLine(v: string): number {
  let max = 0;
  for (const line of v.split(/\r\n|\r|\n/)) {
    // East Asian characters are roughly twice as wide as Latin ones.
    let w = 0;
    for (const ch of line) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    if (w > max) max = w;
  }
  return max;
}

function clampWidth(w: number): number {
  return Math.round(Math.max(64, Math.min(w, 360)));
}
