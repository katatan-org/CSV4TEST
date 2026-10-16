import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docFromBytes, setCells } from "../src/csv/document";
import { CATALOGS, createI18n, en, errorText, ja, matchLocale } from "../src/i18n";
import { HELP } from "../src/i18n/help";
import { analyze } from "../src/rules/analysis";
import { resolveRules } from "../src/rules/detect";
import { NotFoundError, StorageError } from "../src/storage/types";

const katatan = () => docFromBytes(readFileSync(join(__dirname, "fixtures", "katatan.csv")));

describe("message catalogs", () => {
  it("have the same keys, of the same kind, in every language", () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(ja).sort());
      for (const [key, value] of Object.entries(catalog)) expect([key, typeof value]).toEqual([key, typeof ja[key as keyof typeof ja]]);
    }
  });

  it("have the same help sections and as many shortcuts in every language", () => {
    for (const help of Object.values(HELP)) {
      expect(help.guide.map((g) => g.id)).toEqual(HELP.ja.guide.map((g) => g.id));
      expect(help.shortcuts).toHaveLength(HELP.ja.shortcuts.length);
      expect(help.welcomePoints).toHaveLength(HELP.ja.welcomePoints.length);
    }
  });

  it("format numbers and plurals for the language", () => {
    expect(ja.size({ rows: 1234, columns: 6 })).toBe("1,234 行 × 6 列");
    expect(ja.size({ rows: 9, columns: 6, shown: 3 })).toBe("3 / 9 行 × 6 列");
    expect(en.size({ rows: 1, columns: 6 })).toBe("1 row × 6 columns");
    expect(en.size({ rows: 1234, columns: 1, shown: 3 })).toBe("3 / 1,234 rows × 1 column");
    expect(createI18n("en").number(12345)).toBe("12,345");
  });

  it("build commit messages in each language", () => {
    expect(ja.commitMessage({ file: "a.csv", parts: [ja.commitUpdated({ records: "case-1", more: false }), ja.commitAdded({ count: 2 })] })).toBe(
      "a.csv: case-1 を更新、2行を追加",
    );
    expect(en.commitMessage({ file: "a.csv", parts: [en.commitAdded({ count: 2 }), en.commitReordered] })).toBe("a.csv: Add 2 rows, reorder rows");
  });
});

describe("createI18n", () => {
  it("overrides single messages, as strings or functions, and ignores undefined", () => {
    const { m } = createI18n("en", { save: "Store", savedPath: ({ path }) => `${path} stored`, cancel: undefined });
    expect(m.save).toBe("Store");
    expect(m.savedPath({ path: "a.csv" })).toBe("a.csv stored");
    expect(m.cancel).toBe("Cancel");
    expect(m.undo).toBe("Undo");
  });

  it("picks the language from a browser language tag", () => {
    expect(matchLocale("ja-JP")).toBe("ja");
    expect(matchLocale("ja")).toBe("ja");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("fr-FR")).toBe("en");
    expect(matchLocale(undefined)).toBe("en");
  });
});

describe("translated text", () => {
  it("reports issues in the language of the messages passed to analyze", () => {
    let doc = katatan();
    doc = setCells(doc, [
      { recordId: doc.records[2].id, col: 0, value: "1" },
      { recordId: doc.records[4].id, col: 3, value: "Click {{oops" },
    ]);
    const messages = analyze(doc, resolveRules(doc), { messages: en }).issues.map((i) => i.message);
    expect(messages).toEqual(["No 1 is duplicated", "case-2 does not exist", "case-2 does not exist", "{{ is not closed"]);
  });

  it("translates errors from the built-in storage and keeps other messages", () => {
    expect(errorText(new NotFoundError("a/b.csv"), en)).toBe("a/b.csv was not found");
    expect(errorText(new NotFoundError("a/b.csv"), ja)).toBe("a/b.csv が見つかりません");
    expect(errorText(new StorageError("permission_denied", "x"), ja)).toBe("書き込みが許可されませんでした");
    expect(errorText(new Error("boom"), ja)).toBe("boom");
  });
});
