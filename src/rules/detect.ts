import { cellValue, columnCount, type CsvDoc } from "../csv/document";
import { genericPreset, inferColumnRule } from "./presets/generic";
import { katatanPreset } from "./presets/katatan";
import { headerMatches, normalizeHeader, type ColumnRule, type ResolvedColumn, type RuleSet } from "./schema";

export const PRESETS: RuleSet[] = [katatanPreset, genericPreset];

export function presetByName(name: string): RuleSet | undefined {
  return PRESETS.find((p) => p.name === name);
}

/** First preset whose required headers are all present; falls back to `generic`. */
export function detectPreset(headers: string[]): RuleSet {
  const present = new Set(headers.map(normalizeHeader));
  for (const preset of PRESETS) {
    const required = preset.detect?.requiredHeaders;
    if (required && required.every((h) => present.has(normalizeHeader(h)))) return preset;
  }
  return genericPreset;
}

/** Contents of a `.csvview.json`: a partial rule set, optionally naming the preset it extends. */
export type RuleOverride = Partial<RuleSet>;

export function parseRuleOverride(json: string): RuleOverride {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".csvview.json must contain a JSON object");
  }
  const o = value as RuleOverride;
  if (o.columns !== undefined && !Array.isArray(o.columns)) throw new Error('"columns" must be an array');
  if (o.rows !== undefined && !Array.isArray(o.rows)) throw new Error('"rows" must be an array');
  return o;
}

/** Override rules take precedence over the base preset. */
export function mergeRuleSets(base: RuleSet, override: RuleOverride): RuleSet {
  return {
    ...base,
    name: override.name ?? base.name,
    detect: override.detect ?? base.detect,
    columns: [...(override.columns ?? []), ...base.columns],
    rows: [...(override.rows ?? []), ...(base.rows ?? [])],
    labelColors: { ...base.labelColors, ...override.labelColors },
    infer: override.infer ?? base.infer,
    features: { ...base.features, ...override.features },
  };
}

export interface ResolvedRules {
  ruleSet: RuleSet;
  columns: ResolvedColumn[];
}

const INFER_SAMPLE = 300;

export function headersOf(doc: CsvDoc): string[] {
  const n = columnCount(doc);
  return Array.from({ length: n }, (_, i) => cellValue(doc.records[0], i));
}

/**
 * Picks the rule set for `doc` (an explicit preset name, the override's `extends`,
 * or detection) and resolves one rule per column.
 */
export function resolveRules(doc: CsvDoc, override?: RuleOverride, presetName?: string): ResolvedRules {
  const headers = headersOf(doc);
  const chosen = presetName ?? override?.extends;
  const base = (chosen && presetByName(chosen)) || detectPreset(headers);
  const ruleSet = override ? mergeRuleSets(base, override) : base;

  const sample = doc.records.slice(1, 1 + INFER_SAMPLE);
  const columns = headers.map((header, index): ResolvedColumn => {
    const matching = ruleSet.columns.filter((r) => headerMatches(r.match, header));
    let rule: ColumnRule;
    if (matching.length > 0) {
      // Later (lower priority) rules first so earlier ones win.
      rule = Object.assign({}, ...matching.reverse()) as ColumnRule;
    } else if (ruleSet.infer) {
      rule = inferColumnRule(header, sample.map((r) => cellValue(r, index)));
    } else {
      rule = { match: header };
    }
    return { index, header, rule };
  });
  return { ruleSet, columns };
}

export function findColumn(columns: ResolvedColumn[], name: string | undefined): ResolvedColumn | undefined {
  if (!name) return undefined;
  return columns.find((c) => headerMatches(name, c.header));
}
