import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellValue, docFromBytes, docFromText, insertColumn, setCells } from "../src/csv/document";
import { parseTsv, toTsv } from "../src/editor/clipboard";
import { buildPattern, findMatches, replaceAll } from "../src/editor/findReplace";
import { editorReducer, initialEditorState } from "../src/editor/history";
import { analyze, nextId } from "../src/rules/analysis";
import { detectPreset, parseRuleOverride, resolveRules } from "../src/rules/detect";
import { inferColumnRule } from "../src/rules/presets/generic";
import { cellLines, hasUnclosedVariable, tokenize } from "../src/rules/tokens";

const katatan = () => docFromBytes(readFileSync(join(__dirname, "fixtures", "katatan.csv")));

describe("preset detection", () => {
  it("detects KATATAN files with or without the optional columns", () => {
    expect(detectPreset(["No", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes"]).name).toBe("katatan");
    expect(
      detectPreset(["No", "Labels", "Test subject", "Preconditions", "Steps", "Expected result", "Notes", "Images"]).name,
    ).toBe("katatan");
    expect(detectPreset(["id", "name"]).name).toBe("generic");
  });

  it("resolves KATATAN column rules", () => {
    const { ruleSet, columns } = resolveRules(katatan());
    expect(ruleSet.name).toBe("katatan");
    expect(columns.map((c) => c.rule.display ?? "text")).toEqual(["id", "text", "text", "steps", "text", "text"]);
    expect(columns[0].rule.pinned).toBe(true);
    expect(columns[5].rule.placeholder).toBe("-");
  });

  it("labels and images columns are recognised after insertion", () => {
    let doc = insertColumn(katatan(), 1, "Labels");
    doc = insertColumn(doc, 7, "Images");
    const { columns } = resolveRules(doc);
    expect(columns[1].rule.display).toBe("labels");
    expect(columns[7].rule.display).toBe("images");
  });

  it(".csvview.json overrides take precedence and can force a preset", () => {
    const override = parseRuleOverride('{"columns":[{"match":"Steps","width":600}],"labelColors":{"Smoke":"teal"}}');
    const { columns, ruleSet } = resolveRules(katatan(), override);
    expect(columns[3].rule.width).toBe(600);
    expect(columns[3].rule.display).toBe("steps");
    expect(ruleSet.labelColors?.Smoke).toBe("teal");
    expect(resolveRules(katatan(), { extends: "generic" }).ruleSet.name).toBe("generic");
    expect(() => parseRuleOverride("[]")).toThrow();
  });

  it("infers generic column rules", () => {
    expect(inferColumnRule("Price", ["1,200", "30", "4.5"]).align).toBe("right");
    expect(inferColumnRule("Date", ["2026-06-17", "2026/6/1"]).font).toBe("mono");
    expect(inferColumnRule("Status", ["OK", "NG", "OK", "OK", "保留"]).badge).toBe("auto");
    expect(inferColumnRule("Memo", ["a\nb"]).wrap).toBe(true);
  });
});

describe("tokens", () => {
  it("finds variables, literals, params, case refs and URLs", () => {
    const tokens = tokenize(
      "Navigate to {{app_url}}/project/{projectId} and type 'E2E Test' (see case-12, https://example.com/x). user's",
      true,
      "case-(\\d+)",
    );
    const kinds = tokens.filter((t) => t.kind !== "plain").map((t) => [t.kind, t.text, t.ref]);
    expect(kinds).toEqual([
      ["var", "{{app_url}}", "app_url"],
      ["param", "{projectId}", undefined],
      ["literal", "'E2E Test'", undefined],
      ["caseRef", "case-12", "12"],
      ["url", "https://example.com/x", undefined],
    ]);
    expect(tokens.map((t) => t.text).join("")).toContain("user's");
  });

  it("does not treat case refs as tokens without a pattern", () => {
    expect(tokenize("case-1", true).every((t) => t.kind === "plain")).toBe(true);
  });

  it("detects unclosed variables", () => {
    expect(hasUnclosedVariable("Click {{a}} then {{b")).toBe(true);
    expect(hasUnclosedVariable("Click {{a}}\n{{b}}")).toBe(false);
  });

  it("splits multi-value cells", () => {
    expect(cellLines("Normal Case\r\n\n Smoke ")).toEqual(["Normal Case", "Smoke"]);
  });
});

describe("analysis", () => {
  it("indexes ids and variables of the KATATAN sample without issues", () => {
    const doc = katatan();
    const a = analyze(doc, resolveRules(doc));
    expect(a.issues).toEqual([]);
    expect(a.idToRecord.get("3")).toBe(doc.records[3].id);
    expect(a.variables.find((v) => v.name === "dialog_confirm_delete_button")?.recordIds).toHaveLength(3);
    expect(nextId(doc, 0)).toBe("10");
  });

  it("flags duplicate ids, dangling case refs and unclosed variables", () => {
    let doc = katatan();
    doc = setCells(doc, [
      { recordId: doc.records[2].id, col: 0, value: "1" },
      { recordId: doc.records[3].id, col: 2, value: "Needs case-42" },
      { recordId: doc.records[4].id, col: 3, value: "Click {{oops" },
    ]);
    const messages = analyze(doc, resolveRules(doc)).issues.map((i) => i.message);
    // Renumbering case-2 also breaks case-8's reference to it.
    expect(messages).toEqual(["No 1 が重複しています", "case-42 は存在しません", "case-2 は存在しません", "{{ が閉じられていません"]);
  });

  it("collects labels", () => {
    let doc = insertColumn(katatan(), 1, "Labels");
    doc = setCells(doc, [
      { recordId: doc.records[1].id, col: 1, value: "Normal Case\nSmoke" },
      { recordId: doc.records[2].id, col: 1, value: "Normal Case" },
    ]);
    expect(analyze(doc, resolveRules(doc)).labels).toEqual(["Normal Case", "Smoke"]);
  });
});

describe("clipboard TSV", () => {
  it("round trips cells with tabs, quotes and newlines", () => {
    const rows = [
      ["1", "multi\nline", 'say "hi"'],
      ["", "tab\there", "plain"],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it("parses Excel output with a trailing newline and unquoted quotes", () => {
    expect(parseTsv('a\t"b\r\nc"\r\n5" disk\tx\r\n')).toEqual([
      ["a", "b\nc"],
      ['5" disk', "x"],
    ]);
  });
});

describe("find and replace", () => {
  it("finds and replaces literal and regex patterns", () => {
    const doc = katatan();
    const lit = { regex: false, caseSensitive: false };
    const p = buildPattern("{{app_board_url}}", lit) as RegExp;
    expect(findMatches(doc.records.slice(1), 6, p, lit).map((m) => m.col)).toEqual([3, 3, 3, 3, 3, 3]);
    const re = { regex: true, caseSensitive: true };
    const p2 = buildPattern("case-(\\d)", re) as RegExp;
    expect(replaceAll("in case-1", p2, "#$1", re)).toBe("in #1");
    expect(replaceAll("a.b", buildPattern(".", lit) as RegExp, "$1", lit)).toBe("a$1b");
    expect(typeof buildPattern("(", re)).toBe("string");
  });
});

describe("history", () => {
  it("undoes and redoes, and saving rebases dirty state", () => {
    const doc = docFromText("a\n1\n");
    const id = doc.records[1].id;
    let s = initialEditorState(doc);
    s = editorReducer(s, { type: "apply", label: "edit", update: (d) => setCells(d, [{ recordId: id, col: 0, value: "2" }]) });
    expect(cellValue(s.doc.records[1], 0)).toBe("2");
    s = editorReducer(s, { type: "undo" });
    expect(cellValue(s.doc.records[1], 0)).toBe("1");
    s = editorReducer(s, { type: "redo" });
    s = editorReducer(s, { type: "saved" });
    s = editorReducer(s, { type: "undo" });
    // After saving "2", going back to "1" is a change relative to the file on disk.
    expect(s.doc.originals.get(id)?.fields[0].value).toBe("2");
  });
});
