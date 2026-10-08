import { expect, test, type Page } from "@playwright/test";
import { callsTo, emit, mockTauri, setReply } from "./mock";
import { detail, fileDiff, NOW, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// The Files view: every file as it is right now, for whatever is picked in
// the sidebar. A tree on the left, the picked file on the right.

const WT = `${ROOT}-feat-login`;
const e = (path: string, dir = false) => ({ name: path.split("/").pop()!, path, dir });
const TOP = [e("docs", true), e("src", true), e(".gitignore"), e("README.md")];
const SRC = [e("src/deep", true), e("src/app.ts"), e("src/my notes ü.txt")];
const text = (path: string, t: string) => ({ path, size: t.length, text: t, why: null });
const tree = { $by: "dir", cases: { "": TOP, src: SRC, "src/deep": [], docs: { $error: "docs doesn't exist here." } } };
const files = {
  file_list: tree,
  file_read: { $by: "path", cases: {
    "src/app.ts": text("src/app.ts", "const a = 1;\nexport function go() {\n  return a;\n}\n"),
    "README.md": text("README.md", "# Proj\r\n\r\nHello <b>world</b>\r\n"),
    ".gitignore": text(".gitignore", ""),
    "src/my notes ü.txt": { path: "src/my notes ü.txt", size: 2_400_000, text: null, why: "This file is too large to show." },
  }, otherwise: { $error: "gone.txt doesn't exist here." } },
  file_find: { paths: ["src/app.ts", "docs/app-guide.md"], truncated: false },
};

const toggle = (page: Page) => page.getByRole("group", { name: "View" });
const treeOf = (page: Page) => page.getByRole("tree", { name: "Files" });

async function open(page: Page, extra: Record<string, unknown> = {}, url = repoUrl(), view: "files" | null = "files") {
  if (view) await page.addInitScript((v) => { if (!localStorage.getItem("pando.view")) localStorage.setItem("pando.view", v); }, view);
  await mockTauri(page, { ...typical(), ...files, ...extra });
  await page.goto(url);
  await expect(page.locator("aside").first().getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("Commits is the default; the toggle switches to Files and back, and is remembered", async ({ page }) => {
  await open(page, {}, repoUrl(), null);
  await expect(toggle(page).getByRole("button", { name: "Commits" })).toHaveAttribute("aria-pressed", "true");
  await expect(treeOf(page)).toHaveCount(0);
  await toggle(page).getByRole("button", { name: "Files" }).click();
  await expect(treeOf(page)).toBeVisible();
  // The sidebar is untouched.
  await expect(page.locator("aside").first().getByText("WORKTREES", { exact: true })).toBeVisible();
  await page.reload();
  await expect(treeOf(page)).toBeVisible();
  await toggle(page).getByRole("button", { name: "Commits" }).click();
  await expect(treeOf(page)).toHaveCount(0);
  await expect(page.getByText("Pick a file to read it.")).toHaveCount(0);
});

test("the toggle isn't on the Repositories page", async ({ page }) => {
  await mockTauri(page, typical());
  await page.goto("/#/");
  await expect(page.getByText("Repositories").first()).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
});

test("with nothing picked it shows the main worktree's folder, and says so", async ({ page }) => {
  await open(page);
  await expect(page.getByText("in proj (the main worktree), as they are on disk")).toBeVisible();
  expect((await callsTo(page, "file_list"))[0]).toEqual({ root: ROOT, worktree: ROOT, rev: null, dir: "" });
  await expect(treeOf(page).getByRole("treeitem")).toHaveText(["▸docs", "▸src", ".gitignore", "README.md"]);
  await expect(page.getByText("Pick a file to read it.")).toBeVisible();
});

test("a worktree shows its folder on disk; a branch and a commit show that commit", async ({ page }) => {
  await open(page, {}, `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await expect(page.getByText("in proj-feat-login, as they are on disk")).toBeVisible();
  expect((await callsTo(page, "file_list")).at(-1)).toEqual({ root: ROOT, worktree: WT, rev: null, dir: "" });
  await page.goto(`/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent("spike/old")}`);
  await expect(page.getByText("in spike/old, as of its last commit")).toBeVisible();
  await expect.poll(async () => (await callsTo(page, "file_list")).at(-1)).toEqual({ root: ROOT, worktree: null, rev: "spike/old", dir: "" });
  const id = "a".repeat(40);
  await page.goto(`/#/commit?root=${encodeURIComponent(ROOT)}&id=${id}`);
  await expect(page.getByText("as of commit aaaaaaa")).toBeVisible();
  await expect.poll(async () => (await callsTo(page, "file_list")).at(-1)).toEqual({ root: ROOT, worktree: null, rev: id, dir: "" });
});

test("folders open one at a time and load only when opened; empty and failed folders say so", async ({ page }) => {
  await open(page);
  const asked = async () => [...new Set((await callsTo(page, "file_list")).map((c) => c.dir))];
  // Only the top folder, until one is opened.
  expect(await asked()).toEqual([""]);
  await treeOf(page).getByRole("treeitem", { name: /src$/ }).click();
  await expect(treeOf(page).getByRole("treeitem", { name: "app.ts" })).toBeVisible();
  await expect(treeOf(page).getByRole("treeitem", { name: "my notes ü.txt" })).toBeVisible();
  expect(await asked()).toEqual(["", "src"]);
  await treeOf(page).getByRole("treeitem", { name: /deep$/ }).click();
  await expect(treeOf(page).getByText("Empty folder")).toBeVisible();
  await treeOf(page).getByRole("treeitem", { name: /docs$/ }).click();
  await expect(treeOf(page).getByText("docs doesn't exist here.")).toBeVisible();
  // Closing and reopening doesn't ask again.
  await treeOf(page).getByRole("treeitem", { name: /src$/ }).click();
  await expect(treeOf(page).getByRole("treeitem", { name: "app.ts" })).toHaveCount(0);
  await treeOf(page).getByRole("treeitem", { name: /src$/ }).click();
  await expect(treeOf(page).getByRole("treeitem", { name: "app.ts" })).toBeVisible();
  expect((await callsTo(page, "file_list")).filter((c) => c.dir === "src")).toHaveLength(1);
});

test("a file shows its lines, numbered, with its size; Windows line ends and HTML are shown as text", async ({ page }) => {
  await open(page);
  await treeOf(page).getByRole("treeitem", { name: /src$/ }).click();
  await treeOf(page).getByRole("treeitem", { name: "app.ts" }).click();
  const body = page.getByLabel("Contents of src/app.ts");
  await expect(body.locator("[data-line]")).toHaveCount(4);
  await expect(body.locator("[data-line]").nth(1)).toHaveText("2export function go() {");
  await expect(page.getByText("4 lines · 50 bytes")).toBeVisible();
  expect((await callsTo(page, "file_read")).at(-1)).toEqual({ root: ROOT, worktree: ROOT, rev: null, path: "src/app.ts" });
  await treeOf(page).getByRole("treeitem", { name: "README.md" }).click();
  const readme = page.getByLabel("Contents of README.md");
  await expect(readme.locator("[data-line]")).toHaveText(["1# Proj", "2", "3Hello <b>world</b>"]);
  await expect(readme.locator("b")).toHaveCount(0);
});

test("an empty file, one too large, and one that's gone each say so", async ({ page }) => {
  await open(page, { file_list: { ...tree, cases: { ...tree.cases, "": [...TOP, e("gone.txt")] } } });
  await treeOf(page).getByRole("treeitem", { name: ".gitignore" }).click();
  await expect(page.getByText("This file is empty.")).toBeVisible();
  await treeOf(page).getByRole("treeitem", { name: /src$/ }).click();
  await treeOf(page).getByRole("treeitem", { name: "my notes ü.txt" }).click();
  await expect(page.getByText("This file is too large to show.")).toBeVisible();
  await expect(page.getByText("2.4 MB")).toBeVisible();
  await treeOf(page).getByRole("treeitem", { name: "gone.txt" }).click();
  await expect(page.getByText("Couldn't read this file")).toBeVisible();
  await expect(page.getByText("gone.txt doesn't exist here.")).toBeVisible();
  await setReply(page, "file_read", text("gone.txt", "back\n"));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Contents of gone.txt")).toHaveText("1back");
});

test("Find a file lists matches by name, opens one, and clearing it brings the tree back", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Find a file" }).fill("app");
  await expect(treeOf(page).getByRole("treeitem")).toHaveText(["app.tssrc", "app-guide.mddocs"]);
  await expect.poll(async () => (await callsTo(page, "file_find")).at(-1)).toEqual({ root: ROOT, worktree: ROOT, rev: null, query: "app", limit: 100 });
  await treeOf(page).getByRole("treeitem", { name: /app\.ts/ }).click();
  await expect(page.getByLabel("Contents of src/app.ts")).toBeVisible();
  await setReply(page, "file_find", { paths: [], truncated: false });
  await page.getByRole("textbox", { name: "Find a file" }).fill("zzz");
  await expect(treeOf(page).getByText("No file's name matches.")).toBeVisible();
  await setReply(page, "file_find", { paths: ["a.ts"], truncated: true });
  await page.getByRole("textbox", { name: "Find a file" }).fill("a");
  await expect(treeOf(page).getByText("Showing the first 100. Type more to narrow it down.")).toBeVisible();
  await setReply(page, "file_find", { $error: "boom" });
  await page.getByRole("textbox", { name: "Find a file" }).fill("b");
  await expect(treeOf(page).getByText("boom")).toBeVisible();
  await page.getByRole("textbox", { name: "Find a file" }).fill("");
  await expect(treeOf(page).getByRole("treeitem", { name: "README.md" })).toBeVisible();
  // The file you had open stays open.
  await expect(page.getByLabel("Contents of src/app.ts")).toBeVisible();
});

test("a change on disk rereads the open folders and the open file; picking something else starts over", async ({ page }) => {
  await open(page);
  await treeOf(page).getByRole("treeitem", { name: "README.md" }).click();
  await expect(page.getByLabel("Contents of README.md")).toContainText("Proj");
  await setReply(page, "file_list", [...TOP, e("new.txt")]);
  await setReply(page, "file_read", text("README.md", "changed\n"));
  await emit(page, "repo-changed", ROOT);
  await expect(treeOf(page).getByRole("treeitem", { name: "new.txt" })).toBeVisible();
  await expect(page.getByLabel("Contents of README.md")).toHaveText("1changed");
  // Another worktree: the tree starts from the top with no file open.
  await page.locator("aside").first().locator("div.group", { hasText: "proj-feat-login" }).first().click();
  await expect(page.getByText("in proj-feat-login, as they are on disk")).toBeVisible();
  await expect(page.getByText("Pick a file to read it.")).toBeVisible();
});

test("a failed first load says why and nothing else breaks; a long line doesn't widen the page", async ({ page }) => {
  await open(page, { file_list: { $error: "fatal: not a git repository" } });
  await expect(treeOf(page).getByText("fatal: not a git repository")).toBeVisible();
  await setReply(page, "file_list", [e("wide.txt")]);
  await setReply(page, "file_read", text("wide.txt", `${"x".repeat(5000)}\n`));
  await emit(page, "repo-changed", ROOT);
  await treeOf(page).getByRole("treeitem", { name: "wide.txt" }).click();
  await expect(page.getByLabel("Contents of wide.txt")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a very large file draws only the lines on screen, and scrolling shows the rest", async ({ page }) => {
  const big = `${Array.from({ length: 40_000 }, (_, i) => `line number ${i + 1}`).join("\n")}\n`;
  await open(page, { file_list: [e("composer.lock")], file_read: text("composer.lock", big) });
  await treeOf(page).getByRole("treeitem", { name: "composer.lock" }).click();
  const body = page.getByLabel("Contents of composer.lock");
  await expect(body.locator('[data-line="1"]')).toHaveText("1line number 1");
  await expect(page.getByText("40000 lines")).toBeVisible();
  // A few hundred rows at most, however long the file is.
  expect(await body.locator("[data-line]").count()).toBeLessThan(400);
  // The scrollbar is as long as the whole file.
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(body.locator('[data-line="40000"]')).toHaveText("40000line number 40000");
  await expect(body.locator('[data-line="1"]')).toHaveCount(0);
  await body.evaluate((el) => { el.scrollTop = 20_000 * 20; });
  await expect(body.locator('[data-line="20001"]')).toBeVisible();
  // Another file starts at its top, not where the last one was scrolled to.
  await setReply(page, "file_read", text("composer.lock", "short\n"));
  await emit(page, "repo-changed", ROOT);
  await expect(body.locator("[data-line]")).toHaveText(["1short"]);
});

test("contents are coloured by file type, worked out from the name; unknown types stay plain", async ({ page }) => {
  const kinds: Record<string, string> = {
    "view.blade.php": "<div>{{ $name }}</div>\n@if ($a)\n  <p>hi</p>\n@endif\n",
    ".env.local": "APP_KEY=abc123\n# a comment\nDEBUG=true\n",
    "composer.lock": '{\n  "name": "x",\n  "n": 1\n}\n',
    Makefile: "build:\n\tcargo build # go\n",
    Dockerfile: "FROM node:20\nRUN npm ci\n",
    "types.d.ts": "export declare const a: number;\n",
    "main.tf": 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n',
    "legacy.h": "#include <stdio.h>\nint main(void);\n",
    "notes.txt": "const a = 1; // not code\n",
    "LICENSE": "function of(the) { law }\n",
  };
  await open(page, { file_list: Object.keys(kinds).map((k) => e(k)), file_read: { $by: "path", cases: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, text(k, v)])) } });
  for (const name of Object.keys(kinds)) {
    await treeOf(page).getByRole("treeitem", { name, exact: true }).click();
    const coloured = page.getByLabel(`Contents of ${name}`).locator('span[style*="color"]');
    if (name === "notes.txt" || name === "LICENSE") {
      await page.waitForTimeout(400);
      await expect(coloured, name).toHaveCount(0);
    } else {
      await expect(coloured.first(), name).toBeVisible();
      // More than one colour: it was read as a language, not painted flat.
      expect(new Set(await coloured.evaluateAll((els) => els.map((x) => (x as HTMLElement).style.color))).size, name).toBeGreaterThan(1);
    }
  }
});

// ---- Changes, Blame and History on a file -----------------------------------

const st = (path: string, o: Partial<{ staged: string; unstaged: string; untracked: boolean; conflicted: boolean }>) => ({ path, orig_path: null, staged: o.staged ?? null, unstaged: o.unstaged ?? null, untracked: o.untracked ?? false, conflicted: o.conflicted ?? false });
const HEAD = "c".repeat(40), A = "a".repeat(40);
const dirty = {
  overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main", { head: HEAD }) }), row("spike/old")] }),
  detail_load: detail(ROOT, "main", [st("src/app.ts", { unstaged: "M" }), st("README.md", { staged: "M", unstaged: "M" }), st("src/my notes ü.txt", { untracked: true }), st("docs/clash.md", { conflicted: true })]),
  diff_file: fileDiff("src/app.ts", 5),
  file_blame: { path: "src/app.ts", lines: [{ commit: A, text: "const a = 1;" }, { commit: "", text: "draft();" }], commits: { [A]: { author: "Ana Lima", time: NOW - 3600, summary: "Add the app", path: "src/app.ts" } } },
  file_history: { commits: [{ entry: { id: A, parents: [], author: "Ana Lima", time: NOW - 3600, summary: "Add the app", refs: [], is_head: false }, path: "src/app.ts", change: "A" }], truncated: false },
  commit_file_diff: fileDiff("src/app.ts", 3),
};
const tabs = (page: Page) => page.getByRole("group", { name: "What to show for this file" });
const folderRow = (page: Page, name: string) => treeOf(page).getByRole("treeitem").filter({ hasText: new RegExp(`^[▸▾]${name}$`) });
const openApp = async (page: Page) => { await folderRow(page, "src").click(); await treeOf(page).getByRole("treeitem", { name: /^app\.ts/ }).click(); };

test("files with uncommitted changes are marked in the tree, and so is the folder they're in", async ({ page }) => {
  await open(page, dirty);
  await expect(treeOf(page).getByRole("treeitem", { name: /README\.md/ })).toHaveText("README.mdedited");
  await expect(treeOf(page).getByRole("treeitem", { name: ".gitignore" })).toHaveText(".gitignore");
  await expect(folderRow(page, "src").getByLabel("has uncommitted changes inside")).toBeVisible();
  await folderRow(page, "src").click();
  await expect(treeOf(page).getByRole("treeitem", { name: /^app\.ts/ })).toHaveText("app.tsedited");
  await expect(treeOf(page).getByRole("treeitem", { name: /my notes/ })).toHaveText("my notes ü.txtnew");
  // Found files are marked too.
  await page.getByRole("textbox", { name: "Find a file" }).fill("app");
  await expect(treeOf(page).getByRole("treeitem").first()).toHaveText("app.tssrcedited");
  // A branch is a commit: nothing is uncommitted there, and nothing is asked.
  const before = (await callsTo(page, "detail_load")).length;
  await page.goto(`/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent("spike/old")}`);
  await expect(page.getByText("in spike/old, as of its last commit")).toBeVisible();
  await expect(treeOf(page).getByText("edited")).toHaveCount(0);
  expect((await callsTo(page, "detail_load")).length).toBe(before);
});

test("Changes shows what's uncommitted in the file: staged and not staged apart, new files whole", async ({ page }) => {
  await open(page, dirty);
  await openApp(page);
  await expect(tabs(page).getByRole("button")).toHaveText(["File", "Changes •", "Blame", "History"]);
  await tabs(page).getByRole("button", { name: /Changes/ }).click();
  await expect.poll(async () => (await callsTo(page, "diff_file")).at(-1)).toEqual({ worktree: ROOT, path: "src/app.ts", staged: false, untracked: false });
  await expect(page.getByLabel("Contents of src/app.ts")).toHaveCount(0);
  // The tab stays as you move between files.
  await treeOf(page).getByRole("treeitem", { name: /README\.md/ }).click();
  await expect(page.getByRole("region", { name: "Not staged" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Staged", exact: true })).toBeVisible();
  expect((await callsTo(page, "diff_file")).slice(-2).map((c) => c.staged).sort()).toEqual([false, true]);
  await treeOf(page).getByRole("treeitem", { name: /my notes/ }).click();
  await expect.poll(async () => (await callsTo(page, "diff_file")).at(-1)).toEqual({ worktree: ROOT, path: "src/my notes ü.txt", staged: false, untracked: true });
  await treeOf(page).getByRole("treeitem", { name: ".gitignore" }).click();
  await expect(tabs(page).getByRole("button", { name: "Changes", exact: true })).toBeVisible();
  await expect(page.getByText("No uncommitted changes in this file.")).toBeVisible();
});

test("a file with conflicts says so, and a failed diff offers Retry", async ({ page }) => {
  await open(page, { ...dirty, file_list: { ...tree, cases: { ...tree.cases, docs: [e("docs/clash.md")] } }, diff_file: { $error: "fatal: bad object" } });
  await folderRow(page, "docs").click();
  await treeOf(page).getByRole("treeitem", { name: /clash\.md/ }).click();
  await expect(treeOf(page).getByRole("treeitem", { name: /clash\.md/ })).toHaveText("clash.mdconflict");
  await tabs(page).getByRole("button", { name: /Changes/ }).click();
  await expect(page.getByText("This file has conflicts. Open the worktree to resolve them.")).toBeVisible();
  await treeOf(page).getByRole("treeitem", { name: /README\.md/ }).click();
  await expect(page.getByText("Couldn't load this file's changes")).toBeVisible();
  await setReply(page, "diff_file", fileDiff("README.md", 3));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("region", { name: "Not staged" })).toBeVisible();
});

test("a branch has no Changes tab; a tab left on Changes falls back to File", async ({ page }) => {
  await open(page, dirty);
  await openApp(page);
  await tabs(page).getByRole("button", { name: /Changes/ }).click();
  await page.goto(`/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent("spike/old")}`);
  await expect(page.getByText("in spike/old, as of its last commit")).toBeVisible();
  await openApp(page);
  await expect(tabs(page).getByRole("button")).toHaveText(["File", "Blame", "History"]);
  await expect(page.getByLabel("Contents of src/app.ts")).toBeVisible();
});

test("Blame reads the folder on disk or the branch, and a commit in it opens in the commit graph", async ({ page }) => {
  await open(page, dirty);
  await openApp(page);
  await tabs(page).getByRole("button", { name: "Blame" }).click();
  await expect(page.getByRole("table", { name: "Blame for src/app.ts" })).toContainText("Not committed yet");
  // Coloured like the file itself.
  await expect(page.getByRole("table", { name: "Blame for src/app.ts" }).locator('span[style*="color"]').first()).toBeVisible();
  expect((await callsTo(page, "file_blame")).at(-1)).toEqual({ root: ROOT, worktree: ROOT, rev: null, path: "src/app.ts" });
  await page.getByRole("table", { name: "Blame for src/app.ts" }).getByRole("button", { name: /Add the app/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/commit\\?.*id=${A}`));
  await expect(toggle(page).getByRole("button", { name: "Commits" })).toHaveAttribute("aria-pressed", "true");
  await expect(treeOf(page)).toHaveCount(0);
  // On a branch: the file as of that branch.
  await toggle(page).getByRole("button", { name: "Files" }).click();
  await page.goto(`/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent("spike/old")}`);
  await expect(page.getByText("in spike/old, as of its last commit")).toBeVisible();
  await openApp(page);
  await tabs(page).getByRole("button", { name: "Blame" }).click();
  await expect.poll(async () => (await callsTo(page, "file_blame")).at(-1)).toEqual({ root: ROOT, worktree: null, rev: "spike/old", path: "src/app.ts" });
});

test("History starts from the worktree's own commit, or the branch", async ({ page }) => {
  await open(page, dirty);
  await openApp(page);
  await tabs(page).getByRole("button", { name: "History" }).click();
  await expect(page.getByText("1 commit changed this file")).toBeVisible();
  expect((await callsTo(page, "file_history")).at(-1)).toEqual({ root: ROOT, rev: HEAD, path: "src/app.ts", skip: 0, limit: 100 });
  await page.goto(`/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent("spike/old")}`);
  await expect(page.getByText("in spike/old, as of its last commit")).toBeVisible();
  await openApp(page);
  await expect.poll(async () => (await callsTo(page, "file_history")).at(-1)).toEqual({ root: ROOT, rev: "spike/old", path: "src/app.ts", skip: 0, limit: 100 });
});
