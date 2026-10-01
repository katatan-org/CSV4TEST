import { cellValue, type CsvDoc } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { findColumn, type ResolvedRules } from "./detect";
import { cellLines, hasUnclosedVariable, tokenize, variablesIn } from "./tokens";

export interface Issue {
  severity: "warning" | "error";
  recordId?: number;
  col?: number;
  message: string;
}

export interface VariableUse {
  name: string;
  count: number;
  recordIds: number[];
}

export interface Analysis {
  issues: Issue[];
  variables: VariableUse[];
  /** id column value → record id, for `case-N` jumps. */
  idToRecord: Map<string, number>;
  /** Every label used in the labels column, in first-seen order. */
  labels: string[];
}

/** Content checks driven by the rule set's features. Pure and synchronous. */
export function analyze(doc: CsvDoc, rules: ResolvedRules): Analysis {
  const { features = {} } = rules.ruleSet;
  const rows = doc.records.slice(1);
  const issues: Issue[] = [];
  const idToRecord = new Map<string, number>();

  const idCol = findColumn(rules.columns, features.idColumn);
  if (idCol) {
    for (const r of rows) {
      const id = cellValue(r, idCol.index).trim();
      if (id === "") {
        issues.push({ severity: "warning", recordId: r.id, col: idCol.index, message: `${idCol.header} が空です` });
        continue;
      }
      if (!/^\d+$/.test(id)) {
        issues.push({ severity: "warning", recordId: r.id, col: idCol.index, message: `${idCol.header} が数値ではありません: ${id}` });
      }
      if (idToRecord.has(id)) {
        issues.push({ severity: "error", recordId: r.id, col: idCol.index, message: `${idCol.header} ${id} が重複しています` });
      } else {
        idToRecord.set(id, r.id);
      }
    }
  }

  const caseRef = features.caseRef?.pattern;
  const textCols = rules.columns.filter((c) => c.rule.tokens);
  if (caseRef && idCol) {
    for (const r of rows) {
      for (const c of textCols) {
        for (const t of tokenize(cellValue(r, c.index), true, caseRef)) {
          if (t.kind === "caseRef" && t.ref && !idToRecord.has(t.ref)) {
            issues.push({ severity: "warning", recordId: r.id, col: c.index, message: `${t.text} は存在しません` });
          }
        }
      }
    }
  }

  const variables = new Map<string, VariableUse>();
  if (features.variables) {
    for (const r of rows) {
      for (const c of textCols) {
        const v = cellValue(r, c.index);
        if (hasUnclosedVariable(v)) {
          issues.push({ severity: "warning", recordId: r.id, col: c.index, message: "{{ が閉じられていません" });
        }
        for (const name of variablesIn(v)) {
          const use = variables.get(name) ?? { name, count: 0, recordIds: [] };
          use.count++;
          if (use.recordIds[use.recordIds.length - 1] !== r.id) use.recordIds.push(r.id);
          variables.set(name, use);
        }
      }
    }
  }

  const labels: string[] = [];
  const labelCol = rules.columns.find((c) => c.rule.display === "labels");
  if (labelCol) {
    const seen = new Set<string>();
    for (const r of rows) {
      for (const l of cellLines(cellValue(r, labelCol.index))) {
        if (!seen.has(l)) {
          seen.add(l);
          labels.push(l);
        }
      }
    }
  }

  return {
    issues,
    variables: [...variables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    idToRecord,
    labels,
  };
}

/** Value for the id column of a new row: max numeric id + 1. Existing ids are never renumbered. */
export function nextId(doc: CsvDoc, idColIndex: number): string {
  let max = 0;
  for (const r of doc.records.slice(1)) {
    const n = Number.parseInt(cellValue(r, idColIndex), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

/** Image paths referenced by any row of the images column. */
export function referencedImages(records: CsvRecord[], imagesCol: number): Set<string> {
  const set = new Set<string>();
  for (const r of records.slice(1)) for (const p of cellLines(cellValue(r, imagesCol))) set.add(p);
  return set;
}
