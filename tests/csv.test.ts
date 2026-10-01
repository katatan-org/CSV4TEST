import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cellValue,
  deleteRecords,
  docFromBytes,
  docFromText,
  docToBytes,
  docToText,
  insertColumn,
  insertRecords,
  isDirty,
  moveColumn,
  moveRecords,
  setCells,
} from "../src/csv/document";
import { encodeText } from "../src/csv/encoding";
import { parseCsv } from "../src/csv/parser";
import { serializeCsv } from "../src/csv/serializer";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));

const EDGE_CASES: Record<string, string> = {
  empty: "",
  singleLineNoEol: "a,b,c",
  lf: "a,b\n1,2\n",
  crlf: "a,b\r\n1,2\r\n",
  cr: "a,b\r1,2\r",
  mixedRecordEols: "a,b\r\n1,2\n3,4\r\n",
  quotedEverything: '"a","b"\r\n"1","2"\r\n',
  escapedQuotes: 'a,b\n"say ""hi""",x\n',
  embeddedNewlines: 'a,b\r\n"line1\nline2\r\nline3",x\r\n',
  blankLines: "a,b\n\n1,2\n\n",
  trailingDelimiter: "a,b,\n1,2,\n",
  raggedRows: "a,b,c\n1\n1,2,3,4\n",
  spaces: " a , b \n 1 , 2 \n",
  unterminatedQuote: 'a,b\n"open,1\n2,3',
  junkAfterQuote: 'a,b\n"x"y,1\n',
  bomOnly: "﻿",
  bomCrlf: "﻿No,Name\r\n1,foo",
  multipleTrailingNewlines: "a\n\n\n",
  tsv: "a\tb\n1\t\"x\ty\"\n",
  semicolon: "a;b\n1;2\n",
  unicode: "名前,説明\n テスト,\"改行\nあり\"\n😀,👍\n",
};

describe("lossless round trip", () => {
  for (const [name, text] of Object.entries(EDGE_CASES)) {
    it(name, () => {
      expect(serializeCsv(parseCsv(text))).toBe(text);
    });
  }

  it("KATATAN sample is byte-identical (BOM, CRLF records, LF in cells, no final newline)", async () => {
    const bytes = fixture("katatan.csv");
    const doc = docFromBytes(bytes);
    expect(doc.layout.bom).toBe(true);
    expect(doc.layout.eol).toBe("\r\n");
    expect(doc.layout.cellEol).toBe("\n");
    expect(doc.layout.trailingEol).toBe(false);
    expect(doc.records).toHaveLength(10);
    expect(Buffer.from(await docToBytes(doc)).equals(bytes)).toBe(true);
  });

  it("Shift_JIS is detected and written back unchanged", async () => {
    const text = "番号,手順\r\n1,\"画面を開く\nボタンを押す\"\r\n";
    const bytes = await encodeText(text, "shift_jis");
    const doc = docFromBytes(bytes);
    expect(doc.encoding).toBe("shift_jis");
    expect(cellValue(doc.records[1], 1)).toBe("画面を開く\nボタンを押す");
    expect(Buffer.from(await docToBytes(doc)).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("parsing", () => {
  it("parses KATATAN columns and multi-line steps", () => {
    const doc = docFromBytes(fixture("katatan.csv"));
    expect(doc.records[0].fields.map((f) => f.value)).toEqual([
      "No",
      "Test Subject",
      "Preconditions",
      "Steps",
      "Expected Result",
      "Notes",
    ]);
    const steps = cellValue(doc.records[1], 3).split("\n");
    expect(steps).toHaveLength(5);
    expect(steps[2]).toBe("Click {{dashboard_create_project_button}}");
  });

  it("detects delimiters", () => {
    expect(parseCsv(EDGE_CASES.tsv).layout.delimiter).toBe("\t");
    expect(parseCsv(EDGE_CASES.semicolon).layout.delimiter).toBe(";");
    expect(parseCsv('"a,b";c\n').layout.delimiter).toBe(";");
  });
});

describe("editing keeps diffs minimal", () => {
  const katatan = () => docFromBytes(fixture("katatan.csv"));

  it("editing one cell changes only that record", () => {
    const doc = katatan();
    const before = docToText(doc).split("\r\n");
    const edited = setCells(doc, [{ recordId: doc.records[3].id, col: 1, value: "Changed subject" }]);
    const after = docToText(edited).split("\r\n");
    expect(after).toHaveLength(before.length);
    const changed = after.map((line, i) => (line === before[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changed).toEqual([3]);
    expect(isDirty(edited)).toBe(true);
  });

  it("new newlines in a cell use the file's in-cell style (LF), records stay CRLF", () => {
    const doc = katatan();
    const rec = doc.records[1];
    const edited = setCells(doc, [{ recordId: rec.id, col: 3, value: cellValue(rec, 3) + "\r\nWait 1 second" }]);
    const text = docToText(edited);
    expect(text).toContain("{{dialog_create_submit_button}}\nWait 1 second\"");
    expect(text.split("\r\n")).toHaveLength(docToText(doc).split("\r\n").length);
  });

  it("restoring the original value restores the raw text and clears dirty state", () => {
    const doc = katatan();
    const rec = doc.records[2];
    const a = setCells(doc, [{ recordId: rec.id, col: 1, value: "tmp" }]);
    const b = setCells(a, [{ recordId: rec.id, col: 1, value: cellValue(rec, 1) }]);
    expect(b.records[2]).toBe(rec);
    expect(isDirty(b)).toBe(false);
  });

  it("appending a record after a file without a final newline", () => {
    const doc = katatan();
    const { doc: added } = insertRecords(doc, doc.records.length, [["10", "New case"]]);
    const text = docToText(added);
    expect(text.endsWith('the project list",\r\n10,New case,,,,')).toBe(true);
  });

  it("insert, delete and move records", () => {
    const doc = docFromText("h\n1\n2\n3\n");
    const ids = doc.records.map((r) => r.id);
    expect(docToText(moveRecords(doc, [ids[3]], 1))).toBe("h\n3\n1\n2\n");
    expect(docToText(deleteRecords(doc, [ids[2]]))).toBe("h\n1\n3\n");
    expect(docToText(insertRecords(doc, 2, [["x"]]).doc)).toBe("h\n1\nx\n2\n3\n");
  });

  it("insert column keeps each field's quoting with the field", () => {
    const doc = docFromText('No,Steps\r\n1,"a\nb"\r\n');
    const out = docToText(insertColumn(doc, 1, "Labels"));
    expect(out).toBe('No,Labels,Steps\r\n1,,"a\nb"\r\n');
    expect(docToText(moveColumn(docFromText(out), 2, 0))).toBe('Steps,No,Labels\r\n"a\nb",1,\r\n');
  });

  it("git diff reports exactly one changed line for a one-cell edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csv4test-"));
    const file = join(dir, "cases.csv");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    writeFileSync(file, fixture("katatan.csv"));
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");

    const doc = docFromBytes(readFileSync(file));
    const rec = doc.records[5];
    writeFileSync(file, await docToBytes(setCells(doc, [{ recordId: rec.id, col: 2, value: "Edited precondition" }])));

    expect(git("diff", "--numstat").trim()).toBe("1\t1\tcases.csv");
  });
});
