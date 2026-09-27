import { expect, test, type Page } from "@playwright/test";
import { callsTo, emit, mockTauri, setReply } from "./mock";
import { dirty, log, overview, remote, repoUrl, ROOT, row, typical, wt } from "./fixtures";

const sidebar = (page: Page) => page.locator("aside").first();
const branchRow = (page: Page, name: string) => sidebar(page).locator("div.group", { hasText: name }).first();
const menuItems = (page: Page) => page.getByRole("menuitem").allTextContents();

async function open(page: Page, handlers: Record<string, unknown> = typical()) {
  await mockTauri(page, handlers);
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
}

test("every row's ⋯ opens exactly its right-click menu", async ({ page }) => {
  await open(page);
  for (const name of ["feat/login", "spike/old", "half done"]) {
    const r = branchRow(page, name);
    await r.click({ button: "right" });
    const viaRightClick = await menuItems(page);
    await page.keyboard.press("Escape");
    await r.hover();
    await r.getByRole("button", { name: /Actions|Stash actions/ }).click();
    expect(await menuItems(page)).toEqual(viaRightClick);
    expect(viaRightClick.length).toBeGreaterThan(1);
    expect(viaRightClick).not.toContain("Open");
    await page.keyboard.press("Escape");
  }
});

test("menus never spill off screen", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await open(page);
  // The commit list's ⋯ sits at the right edge; the last visible row is near the bottom.
  const more = page.getByRole("button", { name: /^Actions for / }).last();
  await more.scrollIntoViewIfNeeded();
  await more.click();
  const box = await page.getByRole("menu").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(900);
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
});

test("delete asks first, Cancel is the default, and the git call is right", async ({ page }) => {
  await open(page, { ...typical(), branch_delete: null });
  await branchRow(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Delete branch" })).toBeVisible();
  // Enter on the default button must not delete.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await callsTo(page, "branch_delete")).toHaveLength(0);

  await branchRow(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  await expect.poll(() => callsTo(page, "branch_delete")).toEqual([{ root: ROOT, name: "spike/old", remote: false }]);
  await expect(page.getByRole("status").getByText("Deleted spike/old")).toBeVisible();
});

test("a git error shows one plain line, full output under Details, and stays", async ({ page }) => {
  await open(page, {
    ...typical(),
    branch_rename: { $error: "git branch -m spike/old x failed: fatal: a branch named 'x' already exists\nhint: use -M" },
  });
  await branchRow(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill("x");
  await page.getByRole("alertdialog").getByRole("button", { name: "Rename" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("A branch named 'x' already exists");
  await expect(alert).not.toContainText("hint");
  await alert.getByRole("button", { name: "Details" }).click();
  await expect(alert).toContainText("hint: use -M");
  await page.waitForTimeout(3000);
  await expect(alert).toBeVisible();
});

test("the same error twice shows once", async ({ page }) => {
  await open(page, { ...typical(), fetch_all: { $error: "git fetch failed: fatal: unable to access origin" } });
  const fetch = sidebar(page).getByRole("button", { name: "Fetch" });
  await fetch.click();
  await expect(page.getByRole("alert")).toHaveCount(1);
  await fetch.click();
  await page.waitForTimeout(300);
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test("a repo that can't load says so and Retry recovers", async ({ page }) => {
  await mockTauri(page, { ...typical(), overview_load: { $error: "not a git repository: /gone" } });
  await page.goto(repoUrl());
  await expect(page.getByText("Couldn't open this repository")).toBeVisible();
  await expect(page.getByText("Not a git repository: /gone")).toBeVisible();
  await setReply(page, "overview_load", typical().overview_load);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(sidebar(page).getByText("feat/login")).toBeVisible();
});

test("a failed refresh keeps what's on screen", async ({ page }) => {
  await open(page);
  await setReply(page, "overview_load", { $error: "git status failed: fatal: index file corrupt" });
  await emit(page, "repo-changed", ROOT);
  await expect(page.getByText(/Couldn't refresh: Index file corrupt/)).toBeVisible();
  await expect(sidebar(page).getByText("feat/login")).toBeVisible();
});

test("a file change elsewhere refreshes the page; another repo's doesn't", async ({ page }) => {
  await open(page);
  const before = (await callsTo(page, "overview_load")).length;
  await emit(page, "repo-changed", "/some/other/repo");
  await page.waitForTimeout(300);
  expect((await callsTo(page, "overview_load")).length).toBe(before);

  const o = typical().overview_load;
  o.branches[1] = row("feat/login", { worktree: wt(`${ROOT}-feat-login`, "feat/login"), status: dirty(9) });
  await setReply(page, "overview_load", o);
  await emit(page, "repo-changed", ROOT);
  await expect(sidebar(page).getByText("9 changed")).toBeVisible();
});

test("first paint skips status, then fills it in", async ({ page }) => {
  const quick = { ...typical().overview_load, status_loaded: false, branches: typical().overview_load.branches.map((b) => ({ ...b, status: null })) };
  await open(page, { ...typical(), overview_load: { $seq: [quick, { $delay: 800, value: typical().overview_load }] } });
  await expect(sidebar(page).getByText("checking…").first()).toBeVisible();
  await expect(sidebar(page).getByText("3 changed")).toBeVisible();
  await expect(sidebar(page).getByText("checking…")).toHaveCount(0);
});

test("folded sections stay folded after a reload", async ({ page }) => {
  await open(page);
  await sidebar(page).getByRole("button", { name: /BRANCHES/ }).first().click();
  await expect(sidebar(page).getByText("spike/old")).toBeHidden();
  await page.reload();
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
  await expect(sidebar(page).getByText("spike/old")).toBeHidden();
});

test("hostile names render as text", async ({ page }) => {
  const evil = `<img src=x onerror="window.__pwned=1">`;
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row(`feat/${evil}`)] });
  const l = log(3);
  l.entries[0].summary = evil;
  await open(page, { ...typical(), overview_load: o, log_list: l });
  await expect(page.getByText(evil).first()).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("a 200-character branch name doesn't push its ⋯ out of the sidebar", async ({ page }) => {
  const long = "feat/" + "very-long-name-".repeat(13);
  await open(page, { ...typical(), overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row(long, { worktree: wt(`${ROOT}-long`, long) })] }) });
  const side = await sidebar(page).boundingBox();
  const more = sidebar(page).getByRole("button", { name: `Actions for ${long}` });
  const box = await more.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(side!.x + side!.width + 1);
});

test("hundreds of branches and remote branches", async ({ page }) => {
  const branches = [row("main", { worktree: wt(ROOT, "main") }), ...Array.from({ length: 500 }, (_, i) => row(`b/${i}`))];
  const remote_only = Array.from({ length: 300 }, (_, i) => remote(`origin/r/${i}`));
  await open(page, { ...typical(), overview_load: overview({ branches, remote_only }) });
  await expect(sidebar(page).getByText("500 without a worktree")).toBeVisible();
  await sidebar(page).getByRole("button", { name: /REMOTE BRANCHES/ }).click();
  await expect(sidebar(page).getByText("Showing 8 of 300")).toBeVisible();
  await sidebar(page).getByPlaceholder("Search").fill("r/299");
  await expect(sidebar(page).getByText("origin/r/299")).toBeVisible();
  await sidebar(page).getByPlaceholder("Search").fill("zzz");
  await expect(sidebar(page).getByText("No match.")).toBeVisible();
});

test("a repo with no commits and no worktrees except main", async ({ page }) => {
  await open(page, { ...typical(), overview_load: overview(), log_list: { entries: [], truncated: false }, stash_list: [] });
  await expect(page.getByText("No commits yet.").first()).toBeVisible();
});

test("⌘N opens New branch and Escape closes it", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("counts and labels stay on one line next to long names", async ({ page }) => {
  const long = "feat/" + "a-really-long-branch-name-".repeat(4);
  const files = Array.from({ length: 62 }, (_, i) => ({ path: `src/very/deep/folder/structure/file-${i}.ts`, orig_path: null, staged: i % 3 ? null : "M", unstaged: i % 3 ? "M" : "M", untracked: false, conflicted: false }));
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row(long, { worktree: wt(`${ROOT}-long`, long), status: dirty(62) })] });
  await open(page, { ...typical(), overview_load: o, detail_load: { ...typical().detail_load, worktree: wt(`${ROOT}-long`, long), files } });
  for (const text of ["62 files", "partly staged"]) {
    const el = page.getByText(text, { exact: true }).first();
    await expect(el).toBeVisible();
    const box = await el.boundingBox();
    expect(box!.height, `${text} wrapped`).toBeLessThan(22);
  }
});
