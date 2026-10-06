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
  await page.getByRole("menuitem", { name: "Remove worktree (keep branch)…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Deletes the folder proj-fix-typo. The branch fix/typo and its commits stay.");
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

test("a folder that doesn't match its branch is named on the row", async ({ page }) => {
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("spike/old", { worktree: wt(`${ROOT}-feat-behind`, "spike/old") }), row("feat/login", { worktree: wt(`${ROOT}-feat-login`, "feat/login") })] }) });
  await expect(sidebar(page).locator("div.group", { hasText: "spike/old" }).getByText("in proj-feat-behind", { exact: false })).toBeVisible();
  await expect(sidebar(page).locator("div.group", { hasText: "feat/login" }).getByText(/ in /)).toHaveCount(0);
});

test("a missing folder offers Repair worktree and sends where it is now", async ({ page }) => {
  const gone = wt(`${ROOT}-fix-typo`, "fix/typo", { prunable: "gitdir file points to non-existent location" });
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("fix/typo", { worktree: gone })] }), worktree_repair: { $seq: [{ $error: "/x/moved isn't a worktree of this repository." }, null] } });
  const r = sidebar(page).locator("div.group", { hasText: "fix/typo" }).first();
  await expect(r.getByText("folder missing")).toBeVisible();
  await r.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Repair worktree…" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg.getByRole("textbox")).toHaveValue(`${ROOT}-fix-typo`);
  await dlg.getByRole("textbox").fill("  /x/moved ");
  await dlg.getByRole("button", { name: "Repair worktree" }).click();
  await expect.poll(() => callsTo(page, "worktree_repair")).toEqual([{ root: ROOT, path: "/x/moved" }]);
  // A refusal says why and doesn't claim success.
  await expect(page.getByRole("alert")).toContainText("isn't a worktree of this repository");
  await expect(page.getByRole("status").filter({ hasText: "Repaired worktree" })).toHaveCount(0);
});

test("a worktree whose folder is there has no Repair item", async ({ page }) => {
  await open(page);
  await sidebar(page).locator("div.group", { hasText: "fix/typo" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Remove worktree/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Repair worktree…" })).toHaveCount(0);
});

// ---- Open in editor -----------------------------------------------------------------

test("Open in <editor> lists each editor found and sends its name and the path", async ({ page }) => {
  await open(page, { editor_names: ["Cursor", "VS Code"], open_editor: null });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open in Cursor" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Open in VS Code" }).click();
  await expect.poll(() => callsTo(page, "open_editor")).toEqual([{ name: "VS Code", path: WT }]);
  // The one used last is listed first from now on.
  await page.reload();
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  const items = page.getByRole("menuitem", { name: /^Open in (Cursor|VS Code)$/ });
  await expect(items).toHaveText(["Open in VS Code", "Open in Cursor"]);
});

test("no editor found, no menu item and no tick-box", async ({ page }) => {
  await open(page, { editor_names: [], terminal_name: null, worktree_path_preview: `${ROOT}-x` });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Open in (?!new window)/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("dialog").getByLabel(/^Open in .* when it's ready$/)).toHaveCount(0);
});

test("a failed launch says why", async ({ page }) => {
  await open(page, { editor_names: ["Zed"], open_editor: { $error: "Zed isn't installed any more." } });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in Zed" }).click();
  await expect(page.getByRole("alert")).toContainText("Zed isn't installed any more.");
});

test("an editor remembered from before but gone now isn't offered", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pando.editor", "Windsurf"));
  await open(page, { editor_names: ["Cursor"] });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open in Cursor" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open in Windsurf" })).toHaveCount(0);
});

test("new worktree can open straight in the editor, and the choice is remembered", async ({ page }) => {
  const made = { worktree: { path: `${ROOT}-feat-new` } };
  await open(page, { editor_names: ["Cursor", "Zed"], terminal_name: "Terminal", worktree_path_preview: `${ROOT}-feat-new`, worktree_add: made, open_editor: null, open_terminal: null });
  await page.keyboard.press("ControlOrMeta+n");
  let dlg = page.getByRole("dialog");
  const box = dlg.getByLabel("Open in Cursor when it's ready");
  await expect(box).not.toBeChecked();
  await box.check();
  await dlg.getByRole("textbox").first().fill("feat/new");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(() => callsTo(page, "open_editor")).toEqual([{ name: "Cursor", path: `${ROOT}-feat-new` }]);
  // The terminal box was left alone: no terminal.
  expect(await callsTo(page, "open_terminal")).toHaveLength(0);
  await page.reload();
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("Open in Cursor when it's ready")).toBeChecked();
});

test("no editor opens when the worktree couldn't be created, or for a branch without one", async ({ page }) => {
  await open(page, { editor_names: ["Cursor"], worktree_path_preview: `${ROOT}-x`, worktree_add: { $error: "fatal: already exists" }, branch_create: null });
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Open in Cursor when it's ready").check();
  await dlg.getByRole("textbox").first().fill("feat/x");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dlg.getByText("already exists", { exact: false })).toBeVisible();
  expect(await callsTo(page, "open_editor")).toHaveLength(0);
});

// ---- Switch branch in any worktree ------------------------------------------------

const switchRows = () => overview({ branches: [
  row("main", { worktree: wt(ROOT, "main") }),
  row("feat/login", { worktree: wt(WT, "feat/login") }),
  row("spike/old"), row("docs/readme"),
] });

test("a linked worktree can switch to a free branch, and Undo switches back", async ({ page }) => {
  await open(page, { overview_load: switchRows(), worktree_switch: { $seq: ["feat/login", "spike/old"] } });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("Check out another branch in proj-feat-login. feat/login stays as a branch, without a worktree.");
  // Only branches with no worktree are offered: not main, not itself.
  await expect(dlg.getByRole("combobox").locator("option")).toHaveText(["spike/old", "docs/readme"]);
  await dlg.getByRole("combobox").selectOption("spike/old");
  await dlg.getByRole("button", { name: "Switch branch" }).click();
  await expect.poll(() => callsTo(page, "worktree_switch")).toEqual([{ root: ROOT, path: WT, name: "spike/old" }]);
  const toast = page.getByRole("status").filter({ hasText: "Switched proj-feat-login to spike/old" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await callsTo(page, "worktree_switch"))[1]).toEqual({ root: ROOT, path: WT, name: "feat/login" });
});

test("the main worktree switches the same way; Escape switches nothing", async ({ page }) => {
  await open(page, { overview_load: switchRows(), worktree_switch: "main" });
  await sidebar(page).locator("div.group", { hasText: "main worktree" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Check out another branch in the main worktree.");
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "worktree_switch")).toHaveLength(0);
  await sidebar(page).locator("div.group", { hasText: "main worktree" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch branch" }).click();
  await expect.poll(() => callsTo(page, "worktree_switch")).toEqual([{ root: ROOT, path: ROOT, name: "spike/old" }]);
  await expect(page.getByRole("status").filter({ hasText: "Switched the main worktree to spike/old" })).toBeVisible();
});

test("a refused switch says why and offers no Undo", async ({ page }) => {
  await open(page, { overview_load: switchRows(), worktree_switch: { $error: "Your uncommitted changes to a.txt would be lost. Commit or stash them first." } });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Switch branch" }).click();
  await expect(page.getByRole("alert")).toContainText("Your uncommitted changes to a.txt would be lost.");
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("with every branch in a worktree there's nothing to switch to, and a missing folder has no Switch", async ({ page }) => {
  const gone = wt(`${ROOT}-fix-typo`, "fix/typo", { prunable: "gone" });
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/login", { worktree: wt(WT, "feat/login") }), row("fix/typo", { worktree: gone })] }) });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  await expect(page.getByRole("alert")).toContainText("Every local branch already has a worktree.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await sidebar(page).locator("div.group", { hasText: "fix/typo" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Repair worktree…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Switch branch…" })).toHaveCount(0);
});
