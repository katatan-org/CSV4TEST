/**
 * UI language: the standalone app follows the browser and remembers the
 * switch; an embedding host sets `locale`, overrides `messages` and names
 * columns with `columnLabels`. The sample data has no Japanese, so in English
 * any Japanese text on the page is an untranslated message.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = readFileSync(join(process.cwd(), "tests", "fixtures", "katatan.csv"));
const PATH = "tests/cases.csv";

interface Hook {
  openFolderHandle(dir: FileSystemDirectoryHandle): Promise<void>;
  scrollTo(col: number, row: number): void;
  getBounds(col: number, row: number): { x: number; y: number; width: number; height: number } | undefined;
  text(): string[][];
  selected(): [number, number] | undefined;
}
interface Embed {
  mount(files: Record<string, string>, capabilities: Record<string, unknown>, options?: Record<string, unknown>): void;
  saved(): { files: { text: string | null }[] }[];
  editor: { update(options: Record<string, unknown>): void };
}

/** Japanese text in the page's text, titles, labels and placeholders, except the switch to Japanese (labelled "日本語"). */
async function japaneseOnPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const re = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (el.closest(".locale-button") || el.closest("script, style")) continue;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("");
      for (const text of [own, el.title, el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? ""]) {
        if (re.test(text)) found.push(text.trim());
      }
    }
    return [...new Set(found)];
  });
}

async function clickCell(page: Page, col: number, row: number, button: "left" | "right" = "left") {
  await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.scrollTo(c, r), [col, row] as const);
  await page.waitForTimeout(100);
  const b = await page.evaluate(([c, r]) => (window as unknown as { __csv4test: Hook }).__csv4test.getBounds(c, r), [col, row] as const);
  if (!b) throw new Error(`no bounds for ${col},${row}`);
  await page.mouse.click(b.x + 12, b.y + b.height / 2, { button });
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

/** Puts the sample at repo/tests/cases.csv in the origin-private file system and opens repo/. */
async function openRepo(page: Page) {
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
  await expect(page.locator(".status-bar")).toContainText(PATH);
}

test.describe("standalone app in English", () => {
  test.use({ locale: "en-US" });

  test("follows the browser language, and every message on the main screens is English", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Read and edit test case CSVs with ease");
    expect(await japaneseOnPage(page)).toEqual([]);

    await openRepo(page);
    const status = page.locator(".status-bar");
    await expect(status).toContainText("KATATAN");
    await expect(status).toContainText("9 rows × 6 columns");
    await expect(status).toContainText("CRLF / in cells LF");
    // The sample has no Labels column, so there is no Labels tab.
    for (const tab of ["Issues", "Changes", "Variables", "Display rules"]) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      expect(await japaneseOnPage(page), tab).toEqual([]);
    }

    await page.keyboard.press("Control+f");
    await expect(page.getByRole("textbox", { name: "Search text" })).toBeFocused();
    await page.getByRole("textbox", { name: "Search text" }).fill("(");
    await page.getByRole("button", { name: ".*" }).click();
    await expect(page.locator(".find-count")).toContainText("Invalid regular expression");
    await page.getByRole("button", { name: "Show or hide replace" }).click();
    expect(await japaneseOnPage(page)).toEqual([]);
    await page.getByRole("button", { name: "Close find" }).click();

    await clickCell(page, 1, 2, "right");
    await expect(page.getByRole("menuitem", { name: /Insert row above/ })).toBeVisible();
    expect(await japaneseOnPage(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.keyboard.press("F1");
    const help = page.getByRole("dialog", { name: "Help" });
    await expect(help).toBeVisible();
    for (const section of ["About CSV4TEST", "Opening and saving", "Browser differences", "Editing", "Sorting and filtering", "Display rules and detection", "KATATAN format", "Side panel", "Customizing"]) {
      await help.getByRole("button", { name: section }).click();
      expect(await japaneseOnPage(page), section).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(await japaneseOnPage(page)).toEqual([]);
  });

  test("main operations: edit, save, undo, validate and filter", async ({ page }) => {
    await page.goto("/");
    await openRepo(page);
    await page.screenshot({ path: "e2e-results/english.png" });
    await editCell(page, 1, 2, "Edited subject");
    await expect(page.locator(".status-bar")).toContainText("Edit cell");
    await page.keyboard.press("Control+s");
    await expect(page.locator(".toast")).toContainText(`Saved ${PATH}`);
    await expect(page.locator(".status-bar")).toContainText("Saved");

    await clickCell(page, 1, 2);
    await page.keyboard.press("Control+z");
    await expect(page.locator(".status-bar")).toContainText("Undo");
    await expect(page.locator(".save-button")).toContainText("Save");

    await editCell(page, 2, 1, "A project has been created in case-42");
    await page.getByRole("tab", { name: /Issues/ }).click();
    await expect(page.locator(".issue-list")).toContainText("case-42 does not exist");
    await expect(page.locator(".issue-list")).toContainText("Warning");

    await page.getByRole("textbox", { name: "Filter rows" }).fill("delete");
    await expect(page.locator(".status-bar")).toContainText("3 / 9 rows");
  });

  test("the language switch changes the whole UI at once and is remembered", async ({ page }) => {
    await page.goto("/");
    await openRepo(page);
    await expect(page.getByRole("tab", { name: /Issues/ })).toBeVisible();

    await page.getByRole("button", { name: /Switch language/ }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("tab", { name: /検証/ })).toBeVisible();
    await expect(page.locator(".status-bar")).toContainText("9 行 × 6 列");
    await expect(page.getByRole("textbox", { name: "行を絞り込み" })).toBeVisible();
    // The check used for English does find untranslated text.
    expect((await japaneseOnPage(page)).length).toBeGreaterThan(0);
    // Messages already shown in the grid and panels switch too.
    await editCell(page, 2, 1, "See case-42");
    await expect(page.locator(".issue-list")).toContainText("case-42 は存在しません");

    await page.reload();
    await expect(page.getByRole("button", { name: /サンプルを開く/ })).toBeVisible();
    await page.getByRole("button", { name: /表示言語を切り替え/ }).click();
    await expect(page.getByRole("button", { name: /Open sample/ })).toBeVisible();
  });
});

test.describe("embedded with locale and messages", () => {
  const sample = SAMPLE.toString("utf8");

  async function mountEditor(page: Page, options: Record<string, unknown>, capabilities: Record<string, unknown> = { tree: true }) {
    await page.goto("/embed.html");
    await page.waitForFunction(() => "__embed" in window);
    await page.evaluate(
      ([s, path, caps, opts]) => (window as unknown as { __embed: Embed }).__embed.mount({ [path]: s }, caps, { file: path, ...opts }),
      [sample, PATH, capabilities, options] as const,
    );
    await expect(page.locator("#editor .status-bar")).toContainText(PATH);
  }

  test("mounts in English and switches to Japanese with update()", async ({ page }) => {
    await mountEditor(page, { locale: "en" });
    await expect(page.locator("#editor .c4t-root")).toHaveAttribute("lang", "en");
    await expect(page.locator("#editor .status-bar")).toContainText("9 rows × 6 columns");
    await expect(page.locator("#editor .file-tree")).toContainText("Files");
    expect(await japaneseOnPage(page)).toEqual([]);

    await editCell(page, 1, 2, "Edited subject");
    await page.keyboard.press("Control+s");
    await expect(page.locator(".toast")).toContainText(`Saved ${PATH}`);

    await page.evaluate(() => (window as unknown as { __embed: Embed }).__embed.editor.update({ locale: "ja" }));
    await expect(page.locator("#editor .c4t-root")).toHaveAttribute("lang", "ja");
    await expect(page.locator("#editor .status-bar")).toContainText("9 行 × 6 列");
    await expect(page.getByRole("tab", { name: /検証/ })).toBeVisible();
    await expect(page.locator("#editor .file-tree")).toContainText("ファイル");
    // The standalone app's switch is not part of the embedded editor.
    await expect(page.locator("#editor .locale-button")).toHaveCount(0);
  });

  test("messages override single texts, as strings or functions", async ({ page }) => {
    await mountEditor(page, { locale: "en", messages: { tabIssues: "Checks" } });
    await page.evaluate(() =>
      (window as unknown as { __embed: Embed }).__embed.editor.update({
        messages: { tabIssues: "Checks", savedPath: ({ path }: { path: string }) => `${path} is stored` },
      }),
    );
    await expect(page.getByRole("tab", { name: /Checks/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Changes/ })).toBeVisible();
    await editCell(page, 1, 2, "Edited subject");
    await page.keyboard.press("Control+s");
    await expect(page.locator(".toast")).toContainText(`${PATH} is stored`);
  });

  test("columnLabels rename columns on screen only", async ({ page }) => {
    await mountEditor(page, { locale: "ja", columnLabels: { "test subject": "テスト項目名", "Expected Result": "期待結果" } });
    await page.getByRole("tab", { name: /表示ルール/ }).click();
    const rules = page.locator(".rule-table");
    await expect(rules).toContainText("テスト項目名");
    await expect(rules).toContainText("期待結果");
    await expect(rules).not.toContainText("Test Subject");
    await expect(rules).toContainText("Preconditions");

    await page.keyboard.press("Control+f");
    await expect(page.getByRole("combobox", { name: "検索する列" }).locator("option", { hasText: "テスト項目名" })).toHaveCount(1);
    await page.keyboard.press("Escape");

    await editCell(page, 1, 2, "Edited subject");
    await page.getByRole("tab", { name: /変更/ }).click();
    await expect(page.locator(".change-list")).toContainText("テスト項目名");
    await page.keyboard.press("Control+s");
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __embed: Embed }).__embed.saved())).length).toBe(1);
    const [change] = await page.evaluate(() => (window as unknown as { __embed: Embed }).__embed.saved());
    expect(change.files[0].text!.split("\r\n")[0]).toContain("Test Subject");
  });
});
