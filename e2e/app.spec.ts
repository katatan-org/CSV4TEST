import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = readFileSync(join(process.cwd(), "tests", "fixtures", "katatan.csv"));

interface Hook {
  openFolderHandle(dir: FileSystemDirectoryHandle): Promise<void>;
  scrollTo(col: number, row: number): void;
  getBounds(col: number, row: number): { x: number; y: number; width: number; height: number } | undefined;
  text(): string[][];
  selected(): [number, number] | undefined;
  selectedRows(): number[];
}

/** Puts the sample at repo/tests/cases.csv in the origin-private file system and opens repo/. */
async function openRepo(page: Page) {
  await page.goto("/");
  await page.evaluate(async (bytes) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
    const repo = await root.getDirectoryHandle("repo", { create: true });
    const tests = await repo.getDirectoryHandle("tests", { create: true });
    const file = await tests.getFileHandle("cases.csv", { create: true });
    const w = await file.createWritable();
    await w.write(new Uint8Array(bytes));
    await w.close();
    await (window as unknown as { __csv4test: Hook }).__csv4test.openFolderHandle(repo);
  }, Array.from(SAMPLE));
  await expect(page.locator(".status-bar")).toContainText("tests/cases.csv");
  await expect(page.locator(".file-tree")).toBeVisible();
}

async function readRepoFile(page: Page, path: string): Promise<number[] | null> {
  return page.evaluate(async (path) => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("repo");
    const parts = path.split("/");
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    } catch {
      return null;
    }
  }, path);
}

async function clickCell(page: Page, col: number, row: number) {
  await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.scrollTo(c, r), [col, row] as const);
  await page.waitForTimeout(100);
  const b = await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(c, r), [col, row] as const);
  if (!b) throw new Error(`no bounds for ${col},${row}`);
  await page.mouse.click(b.x + 12, b.y + b.height / 2);
  // The grid selection is React state; wait until it reflects the click before typing.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selected()))
    .toEqual([col, row]);
}

const cells = (page: Page) => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.text());

test("sample opens with KATATAN rules", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /サンプルを開く/ }).click();
  const status = page.locator(".status-bar");
  await expect(status).toContainText("KATATAN");
  await expect(status).toContainText("9 行 × 6 列");
  await expect(status).toContainText("UTF-8 (BOM)");
  await expect(status).toContainText("CRLF / セル内 LF");
  await expect(page.getByRole("tab", { name: /検証/ })).toBeVisible();
  await page.screenshot({ path: "e2e-results/sample-light.png" });
  await page.getByRole("button", { name: "ライト/ダークを切り替え" }).click();
  await page.screenshot({ path: "e2e-results/sample-dark.png" });
});

test("editing one cell and saving rewrites only that line", async ({ page }) => {
  await openRepo(page);
  await clickCell(page, 1, 2);
  await page.keyboard.press("Enter");
  const editor = page.locator(".cell-editor textarea");
  await expect(editor).toHaveValue("Can add a card to the list");
  await editor.press("Control+a");
  await editor.fill("Edited subject");
  await editor.press("Enter");
  await expect(page.locator(".toolbar .badge")).toHaveText("1");

  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast")).toContainText("保存しました");

  const saved = Buffer.from((await readRepoFile(page, "tests/cases.csv"))!);
  const before = SAMPLE.toString("utf8").split("\r\n");
  const after = saved.toString("utf8").split("\r\n");
  expect(saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
  expect(after).toHaveLength(before.length);
  expect(after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null)).toEqual([3]);
  expect(after[3].startsWith("3,Edited subject,")).toBe(true);
  await expect(page.locator(".toolbar .badge")).toHaveCount(0);
});

test("undo, multi-line edit with Alt+Enter and variable completion", async ({ page }) => {
  await openRepo(page);
  await clickCell(page, 3, 0);
  await page.keyboard.press("Enter");
  const editor = page.locator(".cell-editor textarea");
  await editor.press("End");
  await editor.press("Control+End");
  await editor.press("Alt+Enter");
  await editor.pressSequentially("Click {{dialog_confirm_del");
  await expect(page.locator(".completion li").first()).toHaveText("{{dialog_confirm_delete_button}}");
  await editor.press("Enter"); // accept completion
  await editor.press("Enter"); // commit
  const steps = (await cells(page))[1][3].split("\n");
  expect(steps[steps.length - 1]).toBe("Click {{dialog_confirm_delete_button}}");
  expect(steps).toHaveLength(6);

  await page.keyboard.press("Control+z");
  expect((await cells(page))[1][3].split("\n")).toHaveLength(5);
  await page.keyboard.press("Control+y");
  expect((await cells(page))[1][3].split("\n")).toHaveLength(6);
});

test("labels and images columns: add, paste a label, paste an image", async ({ page }) => {
  await openRepo(page);
  await page.getByRole("button", { name: "Labels列を追加" }).click();
  await page.getByRole("button", { name: "Images列を追加" }).click();
  const header = (await cells(page))[0];
  expect(header).toEqual(["No", "Labels", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes", "Images"]);

  // Paste a label into Labels of case-1.
  await clickCell(page, 1, 0);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "Normal Case");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  expect((await cells(page))[1][1]).toBe("Normal Case");
  await clickCell(page, 1, 1);
  await page.keyboard.press("Enter");
  const labelEditor = page.locator(".cell-editor textarea");
  await expect(page.locator(".completion li").first()).toHaveText("Normal Case");
  await labelEditor.press("Enter"); // accept suggestion
  await labelEditor.press("Alt+Enter");
  await labelEditor.pressSequentially("Smoke");
  await labelEditor.press("Enter");
  expect((await cells(page))[2][1]).toBe("Normal Case\nSmoke");
  await page.waitForTimeout(100);
  await page.screenshot({ path: "e2e-results/labels.png" });

  // Paste a screenshot into Images of case-1.
  await clickCell(page, 7, 0);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#fff";
    ctx.font = "28px sans-serif";
    ctx.fillText("screenshot", 90, 100);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await cells(page))[1][7]).toBe("cases.assets/case-1-1.png");
  expect(await readRepoFile(page, "tests/cases.assets/case-1-1.png")).not.toBeNull();

  await page.keyboard.press("Control+s");
  // The image toast also says "保存しました"; wait for the CSV save itself.
  await expect(page.locator(".toast", { hasText: "tests/cases.csv を保存しました" })).toBeVisible();
  const saved = Buffer.from((await readRepoFile(page, "tests/cases.csv"))!).toString("utf8");
  expect(saved.split("\r\n")[0]).toBe("﻿No,Labels,Test Subject,Preconditions,Steps,Expected Result,Notes,Images");
  expect(saved.split("\r\n")[1]).toMatch(/^1,Normal Case,Can create a new board/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "e2e-results/labels-images.png" });
});

test("case-N references jump, filters and validation", async ({ page }) => {
  await openRepo(page);
  // Make case-2's precondition start with the link so its position is known, then click it.
  await clickCell(page, 2, 1);
  await page.keyboard.press("Enter");
  await page.locator(".cell-editor textarea").fill("case-1 is done");
  await page.locator(".cell-editor textarea").press("Enter");
  const b = await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(2, 1));
  await page.mouse.click(b!.x + 16, b!.y + 8 + 10);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selected()))
    .toEqual([0, 0]);
  await expect(page.locator(".panel-body .empty.ok")).toContainText("問題は見つかりませんでした");
  // Break a reference: case-2 precondition → case-42.
  await clickCell(page, 2, 1);
  await page.keyboard.press("Enter");
  const editor = page.locator(".cell-editor textarea");
  await editor.fill("A project has been created in case-42");
  await editor.press("Enter");
  await expect(page.locator(".issue-list")).toContainText("case-42 は存在しません");

  await page.getByRole("textbox", { name: "行を絞り込み" }).fill("delete");
  await expect(page.locator(".filter-bar")).toHaveCount(0);
  await expect(page.locator(".status-bar")).toContainText("3 / 9 行");
});

test("typing below the last row adds rows; hover buttons insert rows and columns", async ({ page }) => {
  await openRepo(page);
  const before = await cells(page);
  const dataRows = before.length - 1;
  const width = before[0].length;

  // Two rows below the data: the gap is saved as an empty record.
  await clickCell(page, 1, dataRows + 1);
  await page.keyboard.press("Enter");
  const editor = page.locator(".cell-editor textarea");
  await editor.fill("Free input");
  await editor.press("Enter");
  await expect.poll(async () => (await cells(page)).length).toBe(before.length + 2);
  let now = await cells(page);
  expect(now[now.length - 2]).toEqual(Array(width).fill(""));
  expect(now[now.length - 1][1]).toBe("Free input");

  // Row number hover: insert above the first data row.
  await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const marker = await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(-1, 0));
  await page.mouse.move(marker!.x + marker!.width / 2, marker!.y + marker!.height / 2, { steps: 3 });
  await page.getByRole("button", { name: "上に行を挿入" }).click();
  now = await cells(page);
  expect(now[1]).not.toEqual(before[1]);
  expect(now[2]).toEqual(before[1]);

  // Header hover: insert a column to the right of column 1.
  const header = await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(1, -1));
  await page.mouse.move(header!.x + header!.width / 2, header!.y + header!.height / 2, { steps: 3 });
  await page.getByRole("button", { name: "右に列を挿入" }).click();
  await page.locator("form input").fill("Extra");
  await page.locator("form input").press("Enter");
  now = await cells(page);
  expect(now[0][2]).toBe("Extra");
  expect(now[0]).toHaveLength(width + 1);
});

test("insert buttons come back after leaving a button or clicking it", async ({ page }) => {
  await openRepo(page);
  const marker = (await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(-1, 1)))!;
  const cx = marker.x + marker.width / 2;
  const cy = marker.y + marker.height / 2;
  await page.mouse.move(cx, cy, { steps: 3 });
  const below = page.getByRole("button", { name: "下に行を挿入" });
  await below.hover();
  // Back into the same row number cell without clicking.
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.waitForTimeout(400);
  await expect(below).toBeVisible();

  const before = (await cells(page)).length;
  await below.click();
  await expect.poll(async () => (await cells(page)).length).toBe(before + 1);
  await page.mouse.move(cx, cy - 4, { steps: 5 });
  await expect(below).toBeVisible();
});

test("the whole row number cell selects the row, and rows can still be dragged", async ({ page }) => {
  await openRepo(page);
  const marker = (await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(-1, 1)))!;
  expect(marker.height).toBeGreaterThan(60);
  // Far from the number, near the top-left corner.
  await page.mouse.click(marker.x + 6, marker.y + 8);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selectedRows())).toEqual([1]);
  await page.mouse.click(marker.x + marker.width - 6, marker.y + marker.height - 8);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selectedRows())).toEqual([]);

  const before = await cells(page);
  const target = (await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(-1, 3)))!;
  await page.mouse.move(marker.x + 24, marker.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x + 24, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await cells(page))[2][0]).not.toBe(before[2][0]);
  expect(await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selectedRows())).toEqual([3]);
});

test("help opens from the start screen; folder button explains itself where unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await page.goto("/");
  await expect(page.locator(".welcome")).toBeVisible();
  await page.waitForTimeout(100);
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog", { name: "ヘルプ" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "キーボードショートカット" })).toBeVisible();
  await page.keyboard.press("Escape");

  const folder = page.locator(".welcome-actions button").first();
  await expect(folder).toHaveAttribute("aria-disabled", "true");
  await folder.click({ force: true });
  await expect(page.locator(".toast")).toContainText("Chrome / Edge");
});
