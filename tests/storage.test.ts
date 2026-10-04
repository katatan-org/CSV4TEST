import { describe, expect, it } from "vitest";
import { cellValue, docFromText, docToBytes, isDirty, setCells } from "../src/csv/document";
import { editorReducer, initialEditorState } from "../src/editor/history";
import { MemoryBackend } from "../src/storage/memory";
import { dirOf, joinPath, NotFoundError, resolvePath } from "../src/storage/types";

const CSV = "No,Test Subject\r\n1,a\r\n2,b\r\n";

describe("paths", () => {
  it("resolves relative paths against a folder", () => {
    expect(resolvePath("tests", "login.assets/case-1-1.png")).toBe("tests/login.assets/case-1-1.png");
    expect(resolvePath("tests/sub", "../a.png")).toBe("tests/a.png");
    expect(resolvePath("", "./a.png")).toBe("a.png");
  });

  it("refuses paths that leave the root, absolute paths and URLs", () => {
    expect(resolvePath("tests", "../../a.png")).toBeNull();
    expect(resolvePath("tests", "/etc/passwd")).toBeNull();
    expect(resolvePath("tests", "https://example.com/a.png")).toBeNull();
  });

  it("splits and joins folders", () => {
    expect(dirOf("tests/login.csv")).toBe("tests");
    expect(dirOf("login.csv")).toBe("");
    expect(joinPath("", "a", "", "b.csv")).toBe("a/b.csv");
  });
});

describe("MemoryBackend", () => {
  it("reads, lists and reports missing files", async () => {
    const b = new MemoryBackend({ files: { "tests/a.csv": CSV, ".csvview.json": "{}" } });
    expect((await b.listTree()).map((e) => e.path)).toEqual([".csvview.json", "tests/a.csv"]);
    const { bytes } = await b.read("tests/a.csv");
    expect(new TextDecoder().decode(bytes)).toBe(CSV);
    await expect(b.read("nope.csv")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("saves when the base version matches and returns the new version", async () => {
    const b = new MemoryBackend({ files: { "a.csv": CSV } });
    const { version } = await b.read("a.csv");
    const bytes = new TextEncoder().encode("No\r\n1\r\n") as Uint8Array<ArrayBuffer>;
    const result = await b.save({ files: [{ path: "a.csv", op: "put", bytes, baseVersion: version }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.versions["a.csv"]).not.toBe(version);
    expect(new TextDecoder().decode(b.get("a.csv"))).toBe("No\r\n1\r\n");
  });

  it("reports a conflict when someone else saved first, and overwrites when forced", async () => {
    const b = new MemoryBackend({ files: { "a.csv": CSV } });
    const { version } = await b.read("a.csv");
    b.put("a.csv", "No\r\n9\r\n"); // someone else
    const bytes = new TextEncoder().encode("No\r\n1\r\n") as Uint8Array<ArrayBuffer>;
    const result = await b.save({ files: [{ path: "a.csv", op: "put", bytes, baseVersion: version }] });
    expect(result).toEqual({ ok: false, conflict: { paths: ["a.csv"] } });
    const forced = await b.save({ files: [{ path: "a.csv", op: "put", bytes, baseVersion: version }], force: true });
    expect(forced.ok).toBe(true);
    expect(new TextDecoder().decode(b.get("a.csv"))).toBe("No\r\n1\r\n");
  });

  it("adds images under an unused name", async () => {
    const b = new MemoryBackend({ files: { "t/a.assets/case-1-1.png": new Uint8Array([1]) } });
    const png = new Blob([new Uint8Array([2])], { type: "image/png" });
    expect(await b.addAsset("t/a.assets", "case-1", png)).toBe("t/a.assets/case-1-2.png");
    expect(await b.addAsset("", "x", png)).toBe("x-1.png");
  });

  it("notifies external changes", async () => {
    const b = new MemoryBackend({ files: { "a.csv": CSV } });
    const seen: string[][] = [];
    const off = b.onExternalChange((paths) => seen.push(paths));
    b.put("a.csv", "No\r\n", true);
    off();
    b.put("a.csv", "No\r\n2\r\n", true);
    expect(seen).toEqual([["a.csv"]]);
  });
});

describe("saving while editing", () => {
  it("keeps edits made during a save unsaved", () => {
    const loaded = docFromText(CSV);
    let state = initialEditorState(loaded);
    const [, r1, r2] = loaded.records;
    state = editorReducer(state, { type: "apply", label: "edit", update: (d) => setCells(d, [{ recordId: r1.id, col: 1, value: "A" }]) });
    const snapshot = state.doc; // save starts here
    state = editorReducer(state, { type: "apply", label: "edit", update: (d) => setCells(d, [{ recordId: r2.id, col: 1, value: "B" }]) });
    state = editorReducer(state, { type: "saved", doc: snapshot });

    expect(isDirty(state.doc)).toBe(true);
    const row1 = state.doc.records.find((r) => r.id === r1.id)!;
    const row2 = state.doc.records.find((r) => r.id === r2.id)!;
    expect(state.doc.originals.get(r1.id)).toBe(row1); // saved
    expect(state.doc.originals.get(r2.id)).not.toBe(row2); // edited after the snapshot
    expect(cellValue(row2, 1)).toBe("B");
  });

  it("applies values the backend assigned without making the document dirty", async () => {
    const loaded = docFromText(CSV);
    let state = initialEditorState(loaded);
    state = editorReducer(state, {
      type: "apply",
      label: "add",
      update: (d) => ({ ...d, records: [...d.records, { id: 999, fields: [{ value: "", quoted: false }, { value: "c", quoted: false }], raw: null, eol: "\r\n" }] }),
    });
    const snapshot = state.doc;
    state = editorReducer(state, { type: "saved", doc: snapshot, assigned: [{ recordId: 999, col: 0, value: "3" }] });

    expect(isDirty(state.doc)).toBe(false);
    const added = state.doc.records.find((r) => r.id === 999)!;
    expect(cellValue(added, 0)).toBe("3");
    const text = new TextDecoder().decode(await docToBytes(state.doc));
    expect(text).toBe("No,Test Subject\r\n1,a\r\n2,b\r\n3,c\r\n");
  });
});
