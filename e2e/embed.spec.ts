/**
 * The editor embedded in a non-React page through mount() (embed.html), with an
 * in-memory backend: saving goes through the StorageBackend, shortcuts stay
 * inside the editor, and the host page's styles are untouched.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = readFileSync(join(process.cwd(), "tests", "fixtures", "katatan.csv"), "utf8");
const PATH = "tests/cases.csv";

interface SavedChangeSet {
  message?: string;
  force: boolean;
  files: { path: string; op: string; baseVersion: string | null; text: string | null }[];
  records?: { path: string; order: number; headers: string[]; changes: { kind: string; cells: { header: string; after: string }[] }[] };
}
interface Embed {
  mount(files: Record<string, string>, capabilities: Record<string, unknown>, options?: Record<string, unknown>): void;
  saved(): SavedChangeSet[];
  backend: { put(path: string, content: string, notify?: boolean): string };
}
interface Hook {
  scrollTo(col: number, row: number): void;
  getBounds(col: number, row: number): { x: number; y: number; width: number; height: number } | undefined;
  text(): string[][];
  selected(): [number, number] | undefined;
}

async function mountEditor(page: Page, capabilities: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  await page.goto("/embed.html");
  await page.waitForFunction(() => "__embed" in window);
  await page.evaluate(
    ([sample, path, caps, opts]) => (window as unknown as { __embed: Embed }).__embed.mount({ [path]: sample }, caps, { file: path, ...opts }),
    [SAMPLE, PATH, capabilities, options] as const,
  );
  await expect(page.locator("#editor .status-bar")).toContainText(PATH);
}

const saved = (page: Page) => page.evaluate(() => (window as unknown as { __embed: Embed }).__embed.saved());
const cells = (page: Page) => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.text());

async function clickCell(page: Page, col: number, row: number) {
  await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.scrollTo(c, r), [col, row] as const);
  await page.waitForTimeout(100);
  const b = await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(c, r), [col, row] as const);
  if (!b) throw new Error(`no bounds for ${col},${row}`);
  await page.mouse.click(b.x + 12, b.y + b.height / 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.selected())).toEqual([col, row]);
}

async function editCell(page: Page, col: number, row: number, value: string) {
  await clickCell(page, col, row);
  await page.keyboard.press("Enter");
  const editor = page.locator(".cell-editor textarea");
  await editor.press("Control+a");
  await editor.fill(value);
  await editor.press("Enter");
}

test("saves through the backend with file bytes and per-record changes", async ({ page }) => {
  await mountEditor(page, { tree: true });
  await expect(page.locator("#editor .file-tree")).toContainText("cases.csv");
  await editCell(page, 1, 2, "Edited subject");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast")).toContainText("保存しました");

  const [change] = await saved(page);
  expect(change.files).toHaveLength(1);
  expect(change.files[0]).toMatchObject({ path: PATH, op: "put", baseVersion: "m1" });
  const before = SAMPLE.split("\r\n");
  const after = change.files[0].text!.split("\r\n");
  expect(after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null)).toEqual([3]);
  expect(change.records).toMatchObject({ path: PATH, order: 9, headers: ["No", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes"] });
  expect(change.records!.changes).toEqual([{ kind: "modified", cells: [{ header: "Test Subject", after: "Edited subject" }] }]);
});

test("shortcuts work only inside the editor, and the host page keeps its styles", async ({ page }) => {
  await page.goto("/embed.html");
  const hostButton = page.locator("#host-btn");
  const styleOf = () =>
    hostButton.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, font: s.fontFamily, body: getComputedStyle(document.body).fontFamily };
    });
  const before = await styleOf();
  await mountEditor(page, { tree: true });
  expect(await styleOf()).toEqual(before);
  await page.screenshot({ path: "e2e-results/embed.png" });
  // The editor fills the host's container (560px in embed.html).
  expect(await page.locator("#editor .c4t-root").evaluate((el) => el.getBoundingClientRect().height)).toBe(560);

  await editCell(page, 1, 2, "Edited");
  // Outside the editor: no save, no help.
  await page.locator("#host-input").focus();
  await page.keyboard.press("Control+s");
  await hostButton.focus();
  await page.keyboard.press("F1");
  await page.waitForTimeout(200);
  expect(await saved(page)).toHaveLength(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Inside the editor they work.
  await clickCell(page, 1, 1);
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await saved(page)).length).toBe(1);
});

test("read-only columns, fixed columns and a read-only file", async ({ page }) => {
  await mountEditor(page, { fixedColumns: true, readOnlyColumns: ["No"] });
  // Fixed columns: no buttons that add KATATAN's optional columns.
  await expect(page.getByRole("button", { name: "Labels列を追加" })).toHaveCount(0);
  // The No column cannot be edited, even by pasting.
  await clickCell(page, 0, 1);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "99");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".toast")).toContainText("No 列は編集できません");
  expect((await cells(page))[2][0]).toBe("2");
  // Other columns can.
  await editCell(page, 1, 1, "Still editable");
  expect((await cells(page))[2][1]).toBe("Still editable");

  await mountEditor(page, {}, { readOnly: true });
  await expect(page.locator("#editor .status-bar")).toContainText("読み取り専用");
  await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();
});

test("autosave saves shortly after an edit", async ({ page }) => {
  await mountEditor(page, { autosave: true });
  await expect(page.locator(".save-state")).toHaveText("保存済み");
  await editCell(page, 1, 2, "Autosaved");
  await expect(page.locator(".save-state")).toHaveText("未保存");
  await expect.poll(async () => (await saved(page)).length, { timeout: 6000 }).toBe(1);
  await expect(page.locator(".save-state")).toHaveText("保存済み");
});

test("a commit message is asked for, prefilled from the changes", async ({ page }) => {
  await mountEditor(page, { commitMessage: true });
  await editCell(page, 1, 2, "Edited");
  await page.keyboard.press("Control+s");
  const input = page.getByRole("dialog").locator("input");
  await expect(input).toHaveValue("cases.csv: case-3 を更新");
  await input.fill("Update case-3 wording");
  await input.press("Enter");
  await expect.poll(async () => (await saved(page))[0]?.message).toBe("Update case-3 wording");
});

test("a conflict offers reload or overwrite", async ({ page }) => {
  await mountEditor(page, {});
  await editCell(page, 1, 2, "Mine");
  // Someone else saves the file meanwhile.
  await page.evaluate((path) => (window as unknown as { __embed: Embed }).__embed.backend.put(path, "No,Test Subject\r\n1,theirs\r\n"), PATH);
  await page.keyboard.press("Control+s");
  const banner = page.locator(".banner", { hasText: "保存できませんでした" });
  await expect(banner).toBeVisible();
  expect(await saved(page)).toHaveLength(0);

  await banner.getByRole("button", { name: "上書きして保存" }).click();
  await expect.poll(async () => (await saved(page)).length).toBe(1);
  expect((await saved(page))[0].force).toBe(true);
  await expect(banner).toHaveCount(0);
});

test("host callbacks that return a value do not break the editor", async ({ page }) => {
  // Svelte's dispatch returns a boolean; React must not take it as an effect cleanup.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/embed.html");
  await page.waitForFunction(() => "__embed" in window);
  await page.evaluate(
    ([sample, path]) =>
      (window as unknown as { __embed: Embed }).__embed.mount({ [path]: sample }, {}, {
        file: path,
        onDirtyChange: () => true,
        onFileChange: () => true,
      }),
    [SAMPLE, PATH] as const,
  );
  await expect(page.locator("#editor .status-bar")).toContainText(PATH);
  await editCell(page, 1, 2, "first");
  await editCell(page, 2, 5, "second");
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await saved(page)).length).toBe(1);
  await editCell(page, 4, 7, "third");
  expect(errors).toEqual([]);
});

test("variables from the backend show their values, and undefined ones are reported", async ({ page }) => {
  const names = [...SAMPLE.matchAll(/\{\{([^{}\n]*)\}\}/g)].map((m) => m[1].trim());
  const variables = [{ name: "ID", value: "admin" }, ...names.map((name) => ({ name }))];
  await mountEditor(page, {}, { variables });
  await editCell(page, 3, 2, "Type {{ID}} then {{PW}}");

  // Hovering the chip that shows "admin" hints the variable behind it.
  const b = await page.evaluate(() => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(3, 2));
  const grid = page.locator("#editor .grid-container");
  let hint = "";
  for (let x = b!.x + 8; x < b!.x + b!.width && hint === ""; x += 4) {
    await page.mouse.move(x, b!.y + 18);
    hint = (await grid.getAttribute("title")) ?? "";
  }
  expect(hint).toBe("{{ID}}");

  const panel = page.locator("#editor .side-panel");
  await page.getByRole("tab", { name: /検証/ }).click();
  await expect(panel).toContainText("{{PW}} は定義されていません");
  await expect(panel).not.toContainText("{{ID}} は定義されていません");
  await page.getByRole("tab", { name: /変数/ }).click();
  await expect(panel.locator(".var-list li", { hasText: "{{ID}}" })).toContainText("admin");
  await expect(panel.locator(".var-list li", { hasText: "{{PW}}" })).toContainText("未定義");
});

test("a slow commit shows its progress and then its result on the button", async ({ page }) => {
  await mountEditor(page, { commitMessage: true });
  // Hold the save until the test releases it.
  await page.evaluate(() => {
    const w = window as unknown as { __embed: { backend: { save: (c: unknown) => Promise<unknown> } }; __release?: () => void };
    const original = w.__embed.backend.save.bind(w.__embed.backend);
    w.__embed.backend.save = (c) => new Promise((resolve) => (w.__release = () => resolve(original(c))));
  });
  await editCell(page, 1, 2, "Edited");
  await page.keyboard.press("Control+s");
  await page.getByRole("dialog").locator("input").press("Enter");

  const button = page.locator("#editor .save-button");
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toContainText("コミット中…");
  await expect(button.locator("svg.spin")).toHaveCount(1);

  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(button).toContainText("コミットしました");
  await expect(button).toHaveAttribute("aria-busy", "false");
  await expect(button).toContainText("コミット", { timeout: 4000 });
  await expect(button).not.toContainText("コミットしました", { timeout: 4000 });
});

test("adding an image shows progress in the toolbar until it is stored", async ({ page }) => {
  await mountEditor(page, { images: true });
  await page.getByRole("button", { name: /Images/ }).click();
  await page.evaluate(() => {
    const w = window as unknown as { __embed: { backend: { addAsset: (...a: unknown[]) => Promise<string> } }; __releaseImage?: () => void };
    const original = w.__embed.backend.addAsset.bind(w.__embed.backend);
    w.__embed.backend.addAsset = (...a) => new Promise((resolve) => (w.__releaseImage = () => resolve(original(...a))));
  });
  const adding = page.evaluate(() => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    const hook = (window as unknown as { __csv4test: { addImages(row: number, files: File[]): Promise<void> } }).__csv4test;
    return hook.addImages(0, [png]);
  });
  const activity = page.locator("#editor .activity");
  await expect(activity).toContainText("画像を追加中…");
  await expect(activity.locator("svg.spin")).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { __releaseImage: () => void }).__releaseImage());
  await adding;
  await expect(activity).toHaveCount(0);
});
