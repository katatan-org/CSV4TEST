import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteColumn, deleteRecords, docFromBytes, docFromText, docToText, insertColumn, insertRecords, moveRecords, setCells } from "../src/csv/document";
import { columnMapping, computeChanges, isCellDirty } from "../src/editor/changes";
import { computeViewRows, editViewCells, EMPTY_VIEW, rowsAddedBy, sortSnapshot } from "../src/editor/viewRows";
import { resolveRules } from "../src/rules/detect";
import { tokenize } from "../src/rules/tokens";
import { layoutCell } from "../src/ui/cellLayout";
import { hitTest, layoutText, type TextStyle } from "../src/ui/richtext";

const measure = (text: string) => text.length * 7;
const style: TextStyle = {
  font: "f",
  boldFont: "b",
  monoFont: "m",
  lineHeight: 20,
  chipPad: 3,
  prefixGap: 6,
  paragraphGap: 0,
};
const lineTexts = (l: ReturnType<typeof layoutText>) => l.lines.map((line) => line.runs.map((r) => r.text).join("|"));

describe("rich text layout", () => {
  it("wraps words and keeps chips whole", () => {
    const l = layoutText([{ tokens: tokenize("Click {{submit_button}} now please", true) }], 140, style, measure);
    expect(lineTexts(l)).toEqual(["Click", "{{submit_button}}", "now please"]);
    expect(l.height).toBe(60);
  });

  it("breaks long words and CJK text by character", () => {
    const l = layoutText([{ tokens: tokenize("あいうえおかきくけこ", false) }], 35, style, measure);
    expect(lineTexts(l)).toEqual(["あいうえお", "かきくけこ"]);
    const long = layoutText([{ tokens: tokenize("abcdefghij", false) }], 35, style, measure);
    expect(lineTexts(long)).toEqual(["abcde", "fghij"]);
  });

  it("numbers steps with a hanging indent and finds runs under the pointer", () => {
    const l = layoutText(
      [
        { tokens: tokenize("Open", true), prefix: "1." },
        { tokens: tokenize("see case-3", true, "case-(\\d+)"), prefix: "10." },
      ],
      400,
      style,
      measure,
    );
    expect(l.indent).toBe(3 * 7 + 6);
    expect(l.lines[0].runs[1].x).toBe(l.indent);
    const ref = l.lines[1].runs.find((r) => r.kind === "caseRef")!;
    expect(hitTest(l, ref.x + 1, 25, 20)?.ref).toBe("3");
    expect(hitTest(l, 0.5, 100, 20)).toBeUndefined();
  });
});

describe("cell layout", () => {
  const doc = insertColumn(insertColumn(docFromBytes(readFileSync(join(__dirname, "fixtures", "katatan.csv"))), 1, "Labels"), 7, "Images");
  const { columns } = resolveRules(doc);

  it("lays out labels as one badge per line and images with an add button", () => {
    const labels = layoutCell("Normal Case\nSmoke", { column: columns[1], width: 150, canAddImages: true }, measure);
    expect(labels.kind === "labels" && labels.badges.map((b) => b.text)).toEqual(["Normal Case", "Smoke"]);
    const images = layoutCell("a.png\nb.png", { column: columns[7], width: 200, canAddImages: true }, measure);
    expect(images.kind === "images" && images.thumbs.length).toBe(2);
    expect(images.kind === "images" && images.add).not.toBeNull();
    const readOnly = layoutCell("", { column: columns[7], width: 200, canAddImages: false }, measure);
    expect(readOnly.kind === "images" && readOnly.add).toBeNull();
  });

  it("formats the id column and shows the Notes placeholder", () => {
    const id = layoutCell("7", { column: columns[0], width: 72, canAddImages: false }, measure);
    expect(id.kind === "text" && lineTexts(id.layout)).toEqual(["case-7"]);
    const notes = layoutCell("", { column: columns[6], width: 200, canAddImages: false }, measure);
    expect(notes.kind === "text" && notes.layout.lines[0].runs[0]).toMatchObject({ text: "-", dim: true });
  });

  it("numbers non-empty step lines", () => {
    const steps = layoutCell("Open\n\nClick", { column: columns[4], width: 420, canAddImages: false }, measure);
    const prefixes = steps.kind === "text" ? steps.layout.lines.map((l) => l.runs.find((r) => r.kind === "prefix")?.text) : [];
    expect(prefixes).toEqual(["1.", undefined, "2."]);
  });

  it("shows defined variable values in chips and keeps the name as ref", () => {
    const variableValues = new Map([["ID", "admin"], ["EMPTY", ""], ["MULTI", "a\nb"]]);
    const steps = layoutCell("Enter {{ID}} and {{PW}}\n{{EMPTY}} {{MULTI}}", { column: columns[4], width: 420, canAddImages: false, variableValues }, measure);
    const chips = steps.kind === "text" ? steps.layout.lines.flatMap((l) => l.runs.filter((r) => r.kind === "var")) : [];
    expect(chips.map((r) => [r.text, r.ref])).toEqual([
      ["admin", "ID"],
      ["{{PW}}", "PW"],
      ["{{EMPTY}}", "EMPTY"],
      ["a b", "MULTI"],
    ]);
  });
});

describe("changes", () => {
  it("reports modified cells, added, removed and reordered rows", () => {
    const doc = docFromText("h1,h2\na,b\nc,d\ne,f\n");
    const [, r1, r2, r3] = doc.records;
    let d = setCells(doc, [{ recordId: r1.id, col: 1, value: "B" }]);
    d = deleteRecords(d, [r2.id]);
    d = insertRecords(d, 1, [["x", "y"]]).doc;
    const s = computeChanges(d);
    expect(s.changes.map((c) => c.kind)).toEqual(["added", "modified", "removed"]);
    expect(s.changes[1].cells).toEqual([{ col: 1, header: "h2", before: "b", after: "B" }]);
    expect(s.reordered).toBe(false);
    expect(computeChanges(moveRecords(doc, [r3.id], 1)).reordered).toBe(true);
    expect(computeChanges(doc).changes).toEqual([]);
  });
});

describe("column mapping", () => {
  it("matches columns by header so inserted columns do not mark every cell dirty", () => {
    const doc = docFromText("No,Subject,Notes\n1,a,\n2,b,x\n");
    const inserted = insertColumn(doc, 1, "Labels");
    const map = columnMapping(inserted);
    expect(map).toEqual([0, null, 1, 2]);
    const row = inserted.records[2];
    expect([0, 1, 2, 3].map((c) => isCellDirty(row, c, inserted.originals, map))).toEqual([false, false, false, false]);
    const labelled = setCells(inserted, [{ recordId: row.id, col: 1, value: "Smoke" }]);
    expect(isCellDirty(labelled.records[2], 1, labelled.originals, columnMapping(labelled))).toBe(true);

    const s = computeChanges(inserted);
    expect(s.columns).toEqual({ added: ["Labels"], removed: [] });
    // Only the header row has a visible cell change; data rows are unchanged apart from the empty new column.
    expect(s.changes.map((c) => c.index)).toEqual([0]);
  });

  it("treats a renamed header as the same column and reports deleted columns", () => {
    const doc = docFromText("A,B\n1,2\n");
    const renamed = setCells(doc, [{ recordId: doc.records[0].id, col: 1, value: "Bee" }]);
    expect(columnMapping(renamed)).toEqual([0, 1]);
    const dropped = computeChanges(deleteColumn(doc, 0));
    expect(dropped.columns.removed).toEqual(["A"]);
    expect(dropped.changes[1].cells).toEqual([{ col: -1, header: "A", before: "1", after: "" }]);
  });
});

describe("view rows", () => {
  const doc = docFromText("No,Labels,Name\n2,Smoke,beta\n1,\"Normal Case\nSmoke\",Alpha\n3,Normal Case,gamma\n10,,delta\n");

  it("sorts numerically from a snapshot and keeps file order otherwise", () => {
    const order = sortSnapshot(doc.records, 0, false);
    expect(computeViewRows(doc.records, { ...EMPTY_VIEW, sortOrder: order }).map((r) => r.fields[0].value)).toEqual([
      "1",
      "2",
      "3",
      "10",
    ]);
    expect(computeViewRows(doc.records, EMPTY_VIEW).map((r) => r.fields[0].value)).toEqual(["2", "1", "3", "10"]);
  });

  it("filters by column text, labels and quick search", () => {
    const names = (v: Partial<typeof EMPTY_VIEW>) =>
      computeViewRows(doc.records, { ...EMPTY_VIEW, ...v }).map((r) => r.fields[2].value);
    expect(names({ filters: [{ col: 2, text: "A" }] })).toEqual(["beta", "Alpha", "gamma", "delta"]);
    expect(names({ filters: [{ col: 2, text: "al" }] })).toEqual(["Alpha"]);
    expect(names({ labels: ["Smoke"], labelCol: 1 })).toEqual(["beta", "Alpha"]);
    expect(names({ quick: "gam" })).toEqual(["gamma"]);
  });
});

describe("editing below the data", () => {
  const doc = docFromText("a,b,c\r\n1,2,3\r\n");
  const rows = () => computeViewRows(doc.records, EMPTY_VIEW);

  it("fills the gap with empty records", () => {
    const edits = [{ row: 3, col: 1, value: "x" }];
    expect(rowsAddedBy(1, edits)).toBe(3);
    expect(docToText(editViewCells(doc, rows(), edits))).toBe("a,b,c\r\n1,2,3\r\n,,\r\n,,\r\n,x,\r\n");
  });

  it("edits existing rows in place and ignores clearing blank rows", () => {
    const edits = [
      { row: 0, col: 0, value: "9" },
      { row: 5, col: 0, value: "" },
    ];
    expect(rowsAddedBy(1, edits)).toBe(0);
    expect(docToText(editViewCells(doc, rows(), edits))).toBe("a,b,c\r\n9,2,3\r\n");
  });
});
