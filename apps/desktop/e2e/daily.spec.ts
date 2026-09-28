import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { detail, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

const sidebar = (page: Page) => page.locator("aside").first();
const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;

async function open(page: Page, extra: Record<string, unknown> = {}, url = repoUrl()) {
  await mockTauri(page, { ...typical(), ...extra });
  await page.goto(url);
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
}

// ---- Undo ---------------------------------------------------------------------

test("delete branch → Undo restores it from its backup", async ({ page }) => {
  await open(page, { branch_delete: null, backup_restore_branch: null });
  await sidebar(page).locator("div.group", { hasText: "spike/old" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Deleted spike/old" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "backup_restore_branch")).toEqual([{ root: ROOT, refname: "refs/pando/backup/spike/old" }]);
  await expect(page.getByRole("status").filter({ hasText: "Undone" })).toBeVisible();
});

test("rename → Undo renames it back", async ({ page }) => {
  await open(page, { branch_rename: null });
  await sidebar(page).locator("div.group", { hasText: "spike/old" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill("spike/new");
  await page.getByRole("alertdialog").getByRole("button", { name: "Rename" }).click();
  await page.getByRole("status").filter({ hasText: "Renamed to spike/new" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "branch_rename")).toEqual([
    { root: ROOT, old: "spike/old", new: "spike/new" },
    { root: ROOT, old: "spike/new", new: "spike/old" },
  ]);
});

test("remove worktree → Undo puts it back with what core saved", async ({ page }) => {
  const removed = { path: `${ROOT}-fix-typo`, branch: "fix/typo", head: null, snapshot: "refs/pando/snapshots/remove-worktree/1" };
  await open(page, { worktree_remove: removed, worktree_undo_remove: null });
  await sidebar(page).locator("div.group", { hasText: "fix/typo" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await page.getByRole("status").filter({ hasText: "Removed worktree" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "worktree_undo_remove")).toEqual([{ root: ROOT, removed }]);
});

test("drop stash → Undo puts it back in the list, it isn't applied", async ({ page }) => {
  await open(page, { stash_drop: "refs/pando/snapshots/stash/9", stash_restore: null });
  await sidebar(page).locator("div.group", { hasText: "half done" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Drop…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("You can undo this");
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop stash" }).click();
  await page.getByRole("status").filter({ hasText: "Dropped stash" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "stash_restore")).toEqual([{ root: ROOT, kept: "refs/pando/snapshots/stash/9", message: "On main: half done" }]);
  expect(await callsTo(page, "stash_apply")).toHaveLength(0);
});

test("discard → Undo restores the file into the same worktree", async ({ page }) => {
  const f = { path: "a.ts", orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false };
  await open(page, { detail_load: detail(WT, "feat/login", [f]), discard_paths: "refs/pando/snapshots/discard/5", backup_restore_files: null }, wtUrl);
  const fileRow = page.locator("div.group", { hasText: "a.ts" }).first();
  await fileRow.hover();
  await fileRow.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("You can undo this");
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("status").filter({ hasText: "Discarded changes in a.ts" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "backup_restore_files")).toEqual([{ root: ROOT, refname: "refs/pando/snapshots/discard/5", worktree: WT }]);
});

test("a failed undo says why and doesn't claim success", async ({ page }) => {
  await open(page, { branch_delete: null, backup_restore_branch: { $error: "fatal: a branch named 'spike/old' already exists" } });
  await sidebar(page).locator("div.group", { hasText: "spike/old" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  await page.getByRole("status").filter({ hasText: "Deleted spike/old" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(page.getByRole("status").filter({ hasText: "Undone" })).toHaveCount(0);
});

test("the Undo toast stays long enough to press, then goes", async ({ page }) => {
  await page.clock.install();
  await open(page, { branch_delete: null });
  await sidebar(page).locator("div.group", { hasText: "spike/old" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Deleted spike/old" });
  await expect(toast).toBeVisible();
  await page.clock.runFor(5000);
  await expect(toast).toBeVisible();
  await page.clock.runFor(4000);
  await expect(toast).toBeHidden();
});

// ---- Push / Pull ----------------------------------------------------------------

for (const [label, up, down, upstream, cmd] of [
  ["Pull ↓3", 1, 3, "origin/feat/login", "branch_pull"],
  ["Push ↑2", 2, 0, "origin/feat/login", "branch_push"],
  ["Push to origin", 0, 0, null, "branch_push"],
] as const) {
  test(`worktree page shows ${label}`, async ({ page }) => {
    const d = detail(WT, "feat/login");
    d.branch = { ...d.branch!, upstream, ahead: up, behind: down };
    await open(page, { detail_load: d, branch_pull: null, branch_push: null }, wtUrl);
    await page.getByRole("button", { name: label }).click();
    await expect.poll(async () => (await callsTo(page, cmd)).length).toBe(1);
  });
}

test("in sync says Up to date, with no button", async ({ page }) => {
  const d = detail(WT, "feat/login");
  d.branch = { ...d.branch!, upstream: "origin/feat/login", ahead: 0, behind: 0 };
  await open(page, { detail_load: d }, wtUrl);
  await expect(page.getByText("Up to date")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Push|Pull)/ })).toHaveCount(0);
});

test("sidebar shows ↑↓ against the remote", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x"), upstream: "origin/feat/x", up: [2, 1] })] });
  await open(page, { overview_load: o });
  await expect(sidebar(page).getByTitle("2 to push, 1 to pull (origin/feat/x)")).toHaveText(/↑2 ↓1/);
});

// ---- Merged ---------------------------------------------------------------------

test("a merged worktree says so and offers Remove worktree instead of Merge", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/done", { worktree: wt(`${ROOT}-done`, "feat/done"), merged: true, ahead: 3 }), row("feat/wip", { worktree: wt(`${ROOT}-wip`, "feat/wip"), ahead: 1 })] });
  await open(page, { overview_load: o, worktree_remove: { path: `${ROOT}-done`, branch: "feat/done", head: null, snapshot: null } });
  const done = sidebar(page).locator("div.group", { hasText: "feat/done" }).first();
  await expect(done.getByText("merged")).toBeVisible();
  await done.hover();
  await expect(done.getByRole("button", { name: "Merge" })).toHaveCount(0);
  await done.getByRole("button", { name: "Remove worktree" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect.poll(async () => (await callsTo(page, "worktree_remove")).length).toBe(1);
  const wip = sidebar(page).locator("div.group", { hasText: "feat/wip" }).first();
  await wip.hover();
  await expect(wip.getByRole("button", { name: "Merge" })).toBeVisible();
});

// ---- Open in Terminal -----------------------------------------------------------

test("Open in Terminal uses the name core reports, and the path", async ({ page }) => {
  await open(page, { terminal_name: "iTerm", open_terminal: null });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in iTerm" }).click();
  await expect.poll(() => callsTo(page, "open_terminal")).toEqual([{ path: WT }]);
});

test("no terminal found, no menu item", async ({ page }) => {
  await open(page, { terminal_name: null });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Open in (?!new window)/ })).toHaveCount(0);
});

// ---- New branch → Open in Terminal ------------------------------------------------

async function newBranch(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox").first().fill(name);
  return dlg;
}

test("new worktree can open straight in the terminal, and the choice is remembered", async ({ page }) => {
  const made = { worktree: wt(`${ROOT}-feat-new`, "feat/new") };
  await open(page, { terminal_name: "Terminal", worktree_path_preview: `${ROOT}-feat-new`, worktree_add: made, open_terminal: null });
  let dlg = await newBranch(page, "feat/new");
  const box = dlg.getByLabel("Open in Terminal when it's ready");
  await expect(box).not.toBeChecked();
  await box.check();
  await dlg.getByRole("textbox").first().press("Enter");
  await expect.poll(() => callsTo(page, "open_terminal")).toEqual([{ path: `${ROOT}-feat-new` }]);
  dlg = await newBranch(page, "feat/again");
  await expect(dlg.getByLabel("Open in Terminal when it's ready")).toBeChecked();
});

test("no terminal opens when unticked, for a branch without a worktree, or when create fails", async ({ page }) => {
  await open(page, { terminal_name: "Terminal", worktree_path_preview: `${ROOT}-x`, worktree_add: { $error: "fatal: already exists" }, branch_create: null, open_terminal: null });
  let dlg = await newBranch(page, "feat/x");
  await dlg.getByLabel("Open in Terminal when it's ready").check();
  await dlg.getByRole("textbox").first().press("Enter");
  await expect(dlg.getByText("Already exists")).toBeVisible();
  await page.keyboard.press("Escape");
  dlg = await newBranch(page, "feat/plain");
  await dlg.getByLabel("Add a worktree for it").uncheck();
  await expect(dlg.getByLabel("Open in Terminal when it's ready")).toHaveCount(0);
  await dlg.getByRole("textbox").first().press("Enter");
  await expect.poll(async () => (await callsTo(page, "branch_create")).length).toBe(1);
  expect(await callsTo(page, "open_terminal")).toHaveLength(0);
});
