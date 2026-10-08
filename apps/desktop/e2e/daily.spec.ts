import { expect, test, type Page } from "@playwright/test";
import { callsTo, emit, mockTauri, setReply } from "./mock";
import { detail, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

const sidebar = (page: Page) => page.locator("aside").first();
const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;

async function open(page: Page, extra: Record<string, unknown> = {}, url = repoUrl()) {
  await mockTauri(page, { ...typical(), ...extra });
  await page.goto(url);
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
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

test("the sidebar says what's left to do, each piece naming what it counts; nothing to do shows nothing", async ({ page }) => {
  const o = overview({ branches: [
    row("main", { worktree: wt(ROOT, "main") }),
    row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x"), upstream: "origin/feat/x", up: [2, 1], ahead: 3, behind: 14, status: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0 } }),
    row("feat/idle", { worktree: wt(`${ROOT}-idle`, "feat/idle"), upstream: "origin/feat/idle" }),
    row("feat/new", { worktree: wt(`${ROOT}-new`, "feat/new"), ahead: 1 }),
    { ...row("feat/done", { worktree: wt(`${ROOT}-done`, "feat/done"), upstream: "origin/feat/done", merged: true, behind: 5 }), merged_in: "origin/main" },
    { ...row("feat/local", { worktree: wt(`${ROOT}-local`, "feat/local"), upstream: "origin/feat/local", merged: true }), merged_in: "main" },
    row("spike/loose", { ahead: 1, upstream: "origin/spike/loose" }),
  ], compare_base: "origin/main" });
  await open(page, { overview_load: o });
  const todo = (text: string, about: "folder" | "branch") => sidebar(page).locator("div.group", { hasText: text }).first().locator(`[data-todo="${about}"]`);
  // Facts about the folder sit under the folder; facts about the branch under the branch.
  await expect(sidebar(page).locator("div.group", { hasText: "proj-x" }).first().locator("div.min-w-0 > div")).toHaveText(["proj-x", /proj-x$/, "1 file to commit", "on feat/x▾", "2 commits to push1 commit to pull3 commits to merge into origin/main14 commits behind origin/main"]);
  // One fact per line.
  await expect(todo("proj-x", "branch").locator("> div")).toHaveText(["2 commits to push", "1 commit to pull", "3 commits to merge into origin/main", "14 commits behind origin/main"]);
  await expect(todo("proj-x", "branch").getByText("2 commits to push")).toHaveAttribute("title", "2 commits here that origin/feat/x doesn't have.");
  await expect(todo("proj-x", "branch").getByText("14 commits behind origin/main")).toHaveAttribute("title", "origin/main has 14 commits that this branch doesn't have.");
  await expect(todo("proj-x", "folder").getByText("1 file to commit")).toHaveAttribute("title", "1 file edited in this folder and not committed yet.");
  // Nothing to do: no line at all, and no "clean".
  await expect(sidebar(page).locator("div.group", { hasText: "proj-idle" }).first().locator("[data-todo]")).toHaveCount(0);
  await expect(sidebar(page).getByText("clean")).toHaveCount(0);
  // Never pushed says so. Already in the base names which base.
  await expect(todo("proj-new", "branch").locator("> div")).toHaveText(["not pushed yet", "1 commit to merge into origin/main"]);
  await expect(todo("proj-done", "branch").locator("> div")).toHaveText(["already in origin/main", "5 commits behind origin/main"]);
  await expect(todo("proj-local", "branch")).toHaveText("already in main");
  await expect(todo("spike/loose", "branch")).toHaveText("1 commit to merge into origin/main");
  await expect(sidebar(page).getByText(/[↑↓]/)).toHaveCount(0);
});

// ---- Merged ---------------------------------------------------------------------

test("a worktree row has no buttons to hit by accident: Merge and Remove worktree are in its menu", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/done", { worktree: wt(`${ROOT}-done`, "feat/done"), merged: true, ahead: 3 })] });
  await open(page, { overview_load: o, worktree_remove: { path: `${ROOT}-done`, branch: "feat/done", head: null, snapshot: null } });
  const done = sidebar(page).locator("div.group", { hasText: "feat/done" }).first();
  await expect(done.getByText("already in main")).toBeVisible();
  await done.hover();
  // Only the branch list, the ⋯ menu and the handle to move the row.
  await expect(done.getByRole("button")).toHaveCount(3);
  await done.getByRole("button", { name: "Actions for feat/done" }).click();
  for (const name of ["Open in new window", "Merge…", "Remove worktree (keep branch)…"]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove worktree (keep branch)…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect.poll(async () => (await callsTo(page, "worktree_remove")).length).toBe(1);
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

test("each worktree row names its folder first, then the branch checked out in it", async ({ page }) => {
  await open(page, { "plugin:path|resolve_directory": ROOT.split("/").slice(0, 3).join("/"), overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("spike/old", { worktree: wt(`${ROOT}-feat-behind`, "spike/old") })], detached: [{ worktree: wt("/opt/work/proj-loose", null, { head: "abc1234def" }), status: null, is_main_worktree: false }] }) });
  const r = sidebar(page).locator("div.group", { hasText: "proj-feat-behind" }).first();
  // Folder, where it is (home shortened to ~), the branch in it, then its state.
  await expect(r.locator("div.min-w-0 > div")).toHaveText(["proj-feat-behind", `~${ROOT.split("/").slice(3).map((p) => `/${p}`).join("")}-feat-behind`, "on spike/old▾"]);
  // No branch: git's word for it. Outside home: the whole path.
  const loose = sidebar(page).locator("div.group", { hasText: "proj-loose" }).first().locator("div.min-w-0 > div");
  await expect(loose.nth(1)).toHaveText("/opt/work/proj-loose");
  await expect(loose.nth(2)).toHaveText("no branch · commit abc1234 checked out▾");
  await expect(loose.nth(2).getByText("no branch", { exact: false }).first()).toHaveAttribute("title", /a commit checked out, not a branch.*easy to lose/);
  await expect(sidebar(page).getByText(/detached/)).toHaveCount(0);
});

test("only the main worktree is tagged, and the tag says what that means", async ({ page }) => {
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x") })] }) });
  const tag = sidebar(page).getByText("main worktree", { exact: true });
  await expect(tag).toHaveCount(1);
  await expect(sidebar(page).locator("div.group", { hasText: "on main" }).first().getByText("main worktree", { exact: true })).toBeVisible();
  await expect(tag).toHaveAttribute("title", /holds the repository itself.*can't be removed.*nothing to do with the main branch/);
});

test("a worktree menu with an empty group shows one line, not two", async ({ page }) => {
  // No branch and no changes: nothing to pull, push, merge or stash.
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") })], detached: [{ worktree: wt(`${ROOT}-loose`, null), status: null, is_main_worktree: false }] }) });
  await sidebar(page).locator("div.group", { hasText: "proj-loose" }).first().click({ button: "right" });
  const kids = await page.getByRole("menu").locator("> *").evaluateAll((els) => els.map((e) => (e.getAttribute("role") === "menuitem" ? "item" : "line")));
  expect(kids.join(" ")).not.toMatch(/line line|^line|line$/);
  expect(kids).toContain("line");
});

test("the branch on a worktree row opens a searchable list; branches in other worktrees can't be picked", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/login", { worktree: wt(`${ROOT}-feat-login`, "feat/login") }), row("feat/pay", { worktree: wt(`${ROOT}-pay`, "feat/pay") }), row("spike/old"), row("spike/new"), row("fix/typo")] });
  await open(page, { overview_load: o, worktree_switch: "feat/login" });
  await page.getByRole("button", { name: "Switch branch in proj-feat-login" }).click();
  // Opening the list doesn't open the worktree.
  await expect(page).not.toHaveURL(/#\/worktree/);
  const list = page.getByRole("dialog", { name: "Switch branch" });
  await expect(list.getByRole("textbox", { name: "Find a branch" })).toBeFocused();
  // What can be picked comes first; the rest say where they are.
  await expect(list.getByRole("option")).toHaveText(["spike/old", "spike/new", "fix/typo", "mainin proj", "feat/loginchecked out here", "feat/payin proj-pay"]);
  await expect(list.getByRole("option", { name: /feat\/pay/ })).toHaveAttribute("aria-disabled", "true");
  await list.getByRole("option", { name: /feat\/pay/ }).click({ force: true });
  expect(await callsTo(page, "worktree_switch")).toHaveLength(0);
  await page.keyboard.type("spike");
  await expect(list.getByRole("option")).toHaveText(["spike/old", "spike/new"]);
  await page.keyboard.type(" zzz");
  await expect(list).toContainText("No branch matches.");
  await page.keyboard.press("Enter");
  expect(await callsTo(page, "worktree_switch")).toHaveLength(0);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => callsTo(page, "worktree_switch")).toEqual([{ root: ROOT, path: `${ROOT}-feat-login`, name: "spike/new" }]);
  const toast = page.getByRole("status").filter({ hasText: "Switched proj-feat-login to spike/new" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await callsTo(page, "worktree_switch"))[1]).toEqual({ root: ROOT, path: `${ROOT}-feat-login`, name: "feat/login" });
});

test("Escape or a click elsewhere closes the branch list and switches nothing", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("spike/old")] });
  await open(page, { overview_load: o, worktree_switch: null });
  const list = page.getByRole("dialog", { name: "Switch branch" });
  await page.getByRole("button", { name: "Switch branch in proj", exact: true }).click();
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page).toHaveURL(/#\/repo/);
  await page.getByRole("button", { name: "Switch branch in proj", exact: true }).click();
  await page.mouse.click(700, 500);
  await expect(list).toHaveCount(0);
  expect(await callsTo(page, "worktree_switch")).toHaveLength(0);
});

test("a missing folder has no branch list to open", async ({ page }) => {
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("fix/typo", { worktree: wt(`${ROOT}-fix-typo`, "fix/typo", { prunable: "gone" }) })] }) });
  await expect(page.getByRole("button", { name: "Switch branch in proj-fix-typo" })).toHaveCount(0);
  await expect(sidebar(page).locator("div.group", { hasText: "proj-fix-typo" }).first()).toContainText("on fix/typo");
});

test("the base has its own section: origin/main when there's a remote, the local branch when there isn't", async ({ page }) => {
  const branches = [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x") })];
  await open(page, { overview_load: overview({ branches, compare_base: "origin/main" }) });
  const base = page.getByRole("region", { name: "Base" });
  await expect(base).toContainText("BASE");
  const it = base.getByRole("button", { name: /every branch here is compared to it/i });
  await expect(it).toHaveText("origin/mainThe remote's main, as of your last fetch. Every branch here is compared to it.");
  // First, above Worktrees. All branches comes after Branches.
  const order = await sidebar(page).evaluate((el) => ["BASE", "WORKTREES", "BRANCHES", "All branches"].map((t) => el.textContent!.indexOf(t)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // No total of uncommitted files; the row says what it shows.
  await expect(sidebar(page).getByText(/\d+ uncommitted/)).toHaveCount(0);
  await expect(sidebar(page).getByRole("button", { name: /^All branches/ })).toContainText("every branch in this repository, checked out or not, local and remote");
  // It folds like the other sections, still naming the base, and stays folded.
  await base.getByRole("button", { name: /BASE/ }).click();
  await expect(it).toHaveCount(0);
  await expect(base.getByRole("button", { name: /BASE/ })).toHaveText("▸BASEorigin/main");
  await page.reload();
  await expect(base.getByRole("button", { name: /BASE/ })).toHaveText("▸BASEorigin/main");
  await base.getByRole("button", { name: /BASE/ }).click();
  await it.click();
  await expect(page).toHaveURL(/#\/branch\?.*name=origin%2Fmain/);
  // No remote: the local branch, and it says so. Never-pushed isn't mentioned, since there's nowhere to push.
  await setReply(page, "overview_load", overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x") })], compare_base: "main" }));
  await emit(page, "repo-changed", ROOT);
  await expect(it).toHaveText("mainYour local main branch. There's no remote copy of it, so every branch here is compared to it.");
  await expect(sidebar(page).getByText("not pushed yet")).toHaveCount(0);
});

test("no sidebar row has a button beside its ⋯ menu, and the ⋯ sits at the row's top right", async ({ page }) => {
  await open(page);
  for (const name of [/BACKUPS/, /REMOTE BRANCHES/]) {
    const h = sidebar(page).getByRole("button", { name }).first();
    if (await h.count() && (await h.textContent())?.includes("▸")) await h.click();
  }
  const rows = sidebar(page).locator("div.group");
  const n = await rows.count();
  expect(n).toBeGreaterThan(4);
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    await r.hover();
    // Only the ⋯, the handle to move it, and the branch list on a worktree row.
    const labels = await r.getByRole("button").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute("aria-label") ?? e.textContent));
    for (const l of labels) expect(l).toMatch(/^(Actions for|Stash actions|Switch branch in|Move )/);
    const more = r.getByRole("button", { name: /^(Actions for|Stash actions)/ });
    if (await more.count()) {
      const [rb, mb] = [await r.boundingBox(), await more.boundingBox()];
      expect(mb!.y - rb!.y).toBeLessThan(10);
      expect(rb!.x + rb!.width - (mb!.x + mb!.width)).toBeLessThan(16);
    }
  }
});

test("long text in the sidebar wraps and is never cut off", async ({ page }) => {
  const long = "Drape building maps onto local terrain and keep the labels readable at every zoom";
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" })], compare_base: "origin/main" }), prs_list: { state: "ok", prs: [{ number: 448, title: long, url: "https://x/448", head: "feat/t", base: "main", author: "Nano112", draft: true, checks: "failing", review: "", from_fork: false }] } });
  for (const t of [long, "every branch in this repository, checked out or not, local and remote", "Every branch here is compared to it."]) {
    const el = sidebar(page).getByText(t, { exact: false }).first();
    const fits = await el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().height > 20);
    expect(fits, t).toBe(true);
  }
});

test("Change base: pick any branch to compare against; it's remembered, and the usual base can come back", async ({ page }) => {
  const branches = [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }), row("develop", { upstream: "origin/develop" }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x"), ahead: 2 })];
  const usual = overview({ branches, compare_base: "origin/main" });
  const onDevelop = overview({ branches: [branches[0], branches[1], row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x"), ahead: 1 })], compare_base: "origin/develop" });
  await open(page, { overview_load: { $by: "base", cases: { "origin/develop": onDevelop }, otherwise: usual } });
  const base = page.getByRole("region", { name: "Base" });
  const x = sidebar(page).locator("div.group", { hasText: "proj-x" }).first().locator('[data-todo="branch"]');
  await expect(x).toContainText("2 commits to merge into origin/main");
  expect((await callsTo(page, "overview_load")).at(-1)).toEqual({ root: ROOT, quick: false, base: null });
  await base.getByRole("button", { name: "Actions for the base" }).click();
  await expect(page.getByRole("menuitem", { name: "Use the usual base again" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Change base…" }).click();
  const list = page.getByRole("dialog", { name: "Change base" });
  // Local branches and remote ones; the one in use can't be picked again.
  await expect(list.getByRole("option")).toHaveText(["main", "develop", "feat/x", "origin/develop", "origin/mainthe base now"]);
  await page.keyboard.type("origin dev");
  await page.keyboard.press("Enter");
  await expect(x).toContainText("1 commit to merge into origin/develop");
  await expect(base).toContainText("origin/develop");
  await expect(base).toContainText("The remote's develop, as of your last fetch. You chose it as the base.");
  expect((await callsTo(page, "overview_load")).at(-1)).toEqual({ root: ROOT, quick: false, base: "origin/develop" });
  // Remembered, from the very first load.
  await page.reload();
  await expect(x).toContainText("1 commit to merge into origin/develop");
  expect((await callsTo(page, "overview_load")).map((c) => c.base)).toEqual(expect.arrayContaining(["origin/develop"]));
  expect((await callsTo(page, "overview_load")).some((c) => c.base === null)).toBe(false);
  // And back.
  await base.getByRole("button", { name: "Actions for the base" }).click();
  await page.getByRole("menuitem", { name: "Use the usual base again" }).click();
  await expect(x).toContainText("2 commits to merge into origin/main");
  await expect(base).not.toContainText("You chose it");
});

test("a chosen base that's gone falls back to the usual one without a fuss", async ({ page }) => {
  await page.addInitScript((k) => { if (!localStorage.getItem(k)) localStorage.setItem(k, "origin/gone"); }, `pando.base:${ROOT}`);
  await open(page, { overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" })], compare_base: "origin/main" }) });
  const base = page.getByRole("region", { name: "Base" });
  await expect(base).toContainText("origin/main");
  await expect(base).not.toContainText("You chose it");
  await expect(page.getByRole("alert")).toHaveCount(0);
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
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
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

test("the sidebar is one text size, and every row's text starts on the same left edge", async ({ page }) => {
  const pr = { number: 9, title: "A change", url: "https://x/9", head: "feat/none", base: "main", author: "Sam", draft: false, checks: "passing", review: "", from_fork: false };
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }), row("feat/x", { worktree: wt(`${ROOT}-x`, "feat/x"), upstream: "origin/feat/x", up: [2, 1], ahead: 3, status: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0 } }), row("spike/old", { ahead: 1 })], compare_base: "origin/main" });
  await open(page, { overview_load: o, prs_list: { state: "ok", prs: [pr, { ...pr, number: 10, head: "feat/x" }] }, tag_list: [{ name: "v1", target: "a".repeat(40), time: 1, summary: "one", annotated: false }] });
  for (const name of [/REMOTE BRANCHES/, /TAGS/]) {
    const h = sidebar(page).getByRole("button", { name }).first();
    if ((await h.textContent())?.includes("▸")) await h.click();
  }
  // Every piece of text in the list, below the New branch and Fetch buttons.
  const sizes = await sidebar(page).locator("[data-section]").evaluateAll((secs) => {
    const out = new Set<string>();
    for (const sec of secs) {
      const walk = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.trim() && !(n.parentElement as HTMLElement).closest("input")) out.add(getComputedStyle(n.parentElement!).fontSize);
    }
    return [...out];
  });
  expect(sizes).toEqual(["13px"]);
  // The first line of every row, and every section's title, start at one x.
  const lefts = await sidebar(page).evaluate((el) => {
    const x = (e: Element) => Math.round(e.getBoundingClientRect().left - el.getBoundingClientRect().left);
    const rows = [...el.querySelectorAll("div.group")].map((r) => x(r.querySelector(".min-w-0")!));
    const titles = [...el.querySelectorAll("span.tracking-wider")].map(x);
    return [...new Set([...rows, ...titles])];
  });
  expect(lefts).toEqual([28]);
});
