import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
import { BASE } from "./playwright.config";

const ROOT = `${BASE}/shop`;
const wtPath = (b: string) => `${BASE}/shop-${b.replace("/", "-")}`;
const git = (cwd: string, args: string) => execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
const gitOk = (cwd: string, args: string) => { try { git(cwd, args); return true; } catch { return false; } };
const exists = (p: string) => gitOk("/", `-C "${p}" rev-parse`);

/// The real frontend, talking to the bridge instead of the Tauri shell.
async function boot(page: Page, hash: string) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const listeners: Record<string, number[]> = {};
    let next = 1;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: (cb: unknown) => { const id = next++; w[`_${id}`] = cb; return id; },
      unregisterCallback: () => {},
      convertFileSrc: (s: string) => s,
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "plugin:event|listen") { (listeners[args.event as string] ??= []).push(args.handler as number); return args.handler; }
        if (cmd.startsWith("plugin:")) return null;
        const r = await fetch("http://127.0.0.1:4599/invoke", { method: "POST", body: JSON.stringify({ cmd, args }) });
        const j = await r.json();
        if ("err" in j) throw j.err;
        return j.ok;
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__emit = (event: string, payload: unknown) => { for (const id of listeners[event] ?? []) (w[`_${id}`] as (e: unknown) => void)?.({ event, id, payload }); };
    // The bridge's real file watcher queues changes; deliver them like the app's events.
    setInterval(async () => {
      try {
        const r = await fetch("http://127.0.0.1:4599/invoke", { method: "POST", body: JSON.stringify({ cmd: "__events", args: {} }) });
        for (const root of ((await r.json()).ok ?? []) as string[]) (w.__emit as (e: string, p: unknown) => void)("repo-changed", root);
      } catch { /* bridge restarting */ }
    }, 300);
  });
  await page.goto(`/${hash}`);
}
const repoPage = (page: Page) => boot(page, `#/repo?root=${encodeURIComponent(ROOT)}`);
const worktreePage = (page: Page, b: string) => boot(page, `#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(wtPath(b))}`);
const sidebar = (page: Page) => page.locator("aside").first();
const rowOf = (page: Page, text: string) => sidebar(page).locator("div.group", { hasText: text }).first();
/// A commit's row in the graph (the same summary can also show in the staging list).
const logRow = (page: Page, summary: string) => page.locator("[data-row]").filter({ has: page.getByText(summary, { exact: true }) });
/// Right-click a commit and pick a menu item. Which items a commit gets is
/// known a moment after the page loads, so reopen the menu until it's there.
async function commitAction(page: Page, summary: string, item: string) {
  await expect(async () => {
    // Only with a menu open: on a bare page Escape means "go back".
    if (await page.getByRole("menu").count()) await page.keyboard.press("Escape");
    await logRow(page, summary).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("menuitem", { name: item }).click();
}
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
const bridge = async (cmd: string) => (await (await fetch("http://127.0.0.1:4599/invoke", { method: "POST", body: JSON.stringify({ cmd, args: {} }) })).json()).ok;

test.beforeEach(async () => {
  // The last test's page is closed, but git it started may still be running.
  await bridge("__idle");
  try { execSync(`bash setup.sh "${BASE}"`, { cwd: HERE, stdio: "pipe", encoding: "utf8" }); }
  catch (e) { throw new Error(`setup.sh failed:\n${(e as { stderr?: string }).stderr}`); }
});

test("the repo page shows real state: merged, ↑2, and after Fetch ↓1", async ({ page }) => {
  await repoPage(page);
  await expect(rowOf(page, "feat/done").getByText("merged")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "feat/dirty").getByText("merged")).toHaveCount(0);
  await expect(rowOf(page, "feat/login").getByTitle(/2 to push/)).toBeVisible();
  await sidebar(page).getByRole("button", { name: "Fetch" }).click();
  await expect(toast(page, "Fetched")).toBeVisible();
  await expect(rowOf(page, "feat/behind").getByTitle(/1 to pull/)).toBeVisible();
});

test("Pull ↓1 on the worktree page really pulls", async ({ page }) => {
  git(ROOT, "fetch -q origin");
  await worktreePage(page, "feat/behind");
  await page.getByRole("button", { name: "Pull ↓1" }).click();
  await expect(toast(page, "Pulled feat/behind")).toBeVisible();
  expect(git(wtPath("feat/behind"), "rev-parse HEAD")).toBe(git(ROOT, "rev-parse origin/feat/behind"));
  await expect(page.getByText("Up to date")).toBeVisible();
});

test("Push ↑2 on the worktree page really pushes", async ({ page }) => {
  await worktreePage(page, "feat/login");
  await page.getByRole("button", { name: "Push ↑2" }).click();
  await expect(toast(page, "Pushed feat/login")).toBeVisible();
  expect(git(`${BASE}/origin.git`, "rev-parse feat/login")).toBe(git(wtPath("feat/login"), "rev-parse HEAD"));
});

test("delete branch, then Undo, brings it back at the same commit", async ({ page }) => {
  const tip = git(ROOT, "rev-parse spike/old");
  await repoPage(page);
  await rowOf(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  await expect(toast(page, "Deleted spike/old")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/old")).toBe(false);
  await toast(page, "Deleted spike/old").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(ROOT, "rev-parse spike/old")).toBe(tip);
  await expect(rowOf(page, "spike/old")).toBeVisible();
});

test("rename, then Undo, renames it back", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill("spike/new");
  await page.getByRole("alertdialog").getByRole("button", { name: "Rename" }).click();
  await expect(toast(page, "Renamed to spike/new")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/new")).toBe(true);
  await toast(page, "Renamed to spike/new").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/old")).toBe(true);
  expect(gitOk(ROOT, "rev-parse --verify spike/new")).toBe(false);
});

test("discard, then Undo, puts the edit back", async ({ page }) => {
  const file = `${wtPath("feat/login")}/app.js`;
  const before = execSync(`cat "${file}"`, { encoding: "utf8" });
  await worktreePage(page, "feat/login");
  const r = page.locator("div.group", { hasText: "app.js" }).first();
  await r.hover();
  await r.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(toast(page, "Discarded changes in app.js")).toBeVisible();
  expect(execSync(`cat "${file}"`, { encoding: "utf8" })).not.toBe(before);
  await toast(page, "Discarded changes in app.js").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(execSync(`cat "${file}"`, { encoding: "utf8" })).toBe(before);
});

test("drop stash, then Undo, puts it back in the list without applying it", async ({ page }) => {
  const readme = execSync(`cat "${ROOT}/README.md"`, { encoding: "utf8" });
  await repoPage(page);
  await rowOf(page, "half done").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Drop…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop stash" }).click();
  await expect(toast(page, "Dropped stash")).toBeVisible();
  expect(git(ROOT, "stash list")).toBe("");
  await toast(page, "Dropped stash").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(ROOT, "stash list")).toContain("half done");
  expect(execSync(`cat "${ROOT}/README.md"`, { encoding: "utf8" })).toBe(readme);
});

test("a merged worktree: Remove worktree, then Undo, puts the folder back", async ({ page }) => {
  await repoPage(page);
  const done = rowOf(page, "feat/done");
  await expect(done.getByText("merged")).toBeVisible({ timeout: 15_000 });
  await done.hover();
  await done.getByRole("button", { name: "Remove worktree" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect(toast(page, "Removed worktree feat/done")).toBeVisible();
  expect(exists(wtPath("feat/done"))).toBe(false);
  await toast(page, "Removed worktree feat/done").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(wtPath("feat/done"), "branch --show-current")).toBe("feat/done");
});

test("forced remove of a dirty worktree, then Undo, brings back the uncommitted work", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "feat/dirty").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Remove worktree/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("saved first, so you can undo");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect(toast(page, "Removed worktree feat/dirty")).toBeVisible();
  expect(exists(wtPath("feat/dirty"))).toBe(false);
  await toast(page, "Removed worktree feat/dirty").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(execSync(`cat "${wtPath("feat/dirty")}/wip.txt"`, { encoding: "utf8" })).toBe("precious\n");
  expect(execSync(`cat "${wtPath("feat/dirty")}/README.md"`, { encoding: "utf8" })).toContain("edited");
});

test("Open in Terminal asks for the worktree's folder (recorded, not opened)", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "feat/login").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in Terminal" }).click();
  await expect.poll(async () => JSON.stringify(await bridge("__opened"))).toContain(wtPath("feat/login"));
});

test("Open in an editor asks for that editor and the worktree's folder (recorded, not opened)", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "feat/login").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in VS Code" }).click();
  // Each entry is the call's arguments, as JSON text.
  await expect.poll(async () => ((await bridge("__opened")) as string[]).map((x) => JSON.parse(x))).toContainEqual({ name: "VS Code", path: wtPath("feat/login") });
});

test("a branch opens on All changes with the real files", async ({ page }) => {
  await boot(page, `#/branch?root=${encodeURIComponent(ROOT)}&name=feat%2Flogin`);
  await expect(page.getByText(/All changes on feat\/login since/)).toBeVisible();
  await expect(page.getByRole("button", { name: /login\.js/ })).toBeVisible();
});

test("New branch with Open in Terminal makes a real worktree and asks for that folder", async ({ page }) => {
  await repoPage(page);
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox").first().fill("feat/agent-task");
  await dlg.getByLabel("Open in Terminal when it's ready").check();
  await dlg.getByRole("textbox").first().press("Enter");
  await expect(dlg).toBeHidden();
  const p = `${BASE}/shop-feat-agent-task`;
  expect(git(p, "branch --show-current")).toBe("feat/agent-task");
  await expect.poll(async () => JSON.stringify(await bridge("__opened"))).toContain(p);
});

test("two worktrees editing login.js both show ⚠, and it clears when one is removed", async ({ page }) => {
  await repoPage(page);
  const login = rowOf(page, "feat/login"), collide = rowOf(page, "feat/collide");
  await expect(login.getByText(/⚠/)).toBeVisible({ timeout: 15_000 });
  await expect(login.getByText(/⚠/)).toHaveAttribute("title", /Also changed in feat\/collide: .*login\.js/);
  await expect(collide.getByText(/⚠/)).toHaveAttribute("title", /Also changed in feat\/login: .*login\.js/);
  await expect(rowOf(page, "feat/behind").getByText(/⚠/)).toHaveCount(0);
  await collide.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Remove worktree/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect(login.getByText(/⚠/)).toHaveCount(0, { timeout: 15_000 });
});

test("stage one of two new lines: git has exactly that line staged", async ({ page }) => {
  await worktreePage(page, "feat/login");
  await page.locator("div.group", { hasText: "lines.txt" }).first().click();
  await page.getByRole("checkbox", { name: /line: keep this$/ }).click();
  await page.getByRole("button", { name: "Stage 1 line" }).click();
  await expect.poll(() => git(wtPath("feat/login"), "show :lines.txt")).toBe("one\nkeep this\ntwo\nthree");
  expect(execSync(`cat "${wtPath("feat/login")}/lines.txt"`, { encoding: "utf8" })).toBe("one\nkeep this\ntwo\nnot this\nthree\n");
});

test("a branch lists exactly its own commits, then the earlier history", async ({ page }) => {
  const count = Number(git(ROOT, "rev-list --count origin/main..feat/login"));
  await boot(page, `#/branch?root=${encodeURIComponent(ROOT)}&name=feat%2Flogin`);
  await expect(page.getByText(`${count} commits on this branch`)).toBeVisible();
  await expect(page.getByText("Earlier history on main")).toBeVisible();
  await expect(page.getByText(/All changes on feat\/login since/)).toBeVisible();
});

test("Fetch updates the Fetched line", async ({ page }) => {
  await repoPage(page);
  await sidebar(page).getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(sidebar(page).getByText("Fetched just now")).toBeVisible();
});

test("changes made outside Pando show up by themselves", async ({ page }) => {
  await repoPage(page);
  await expect(rowOf(page, "feat/login")).toBeVisible();
  const outside = `${BASE}/shop-feat-outside`;

  // A worktree added from a terminal appears.
  git(ROOT, `worktree add -q -b feat/outside "${outside}"`);
  await expect(rowOf(page, "feat/outside")).toBeVisible({ timeout: 10_000 });

  // A commit made in it, from a terminal, reaches the graph.
  execSync(`echo hi > outside.txt && git -c user.name=T -c user.email=t@e -c commit.gpgsign=false add outside.txt && git -c user.name=T -c user.email=t@e -c commit.gpgsign=false commit -q -m "Made outside Pando"`, { cwd: outside, shell: "/bin/bash" });
  await expect(page.getByText("Made outside Pando")).toBeVisible({ timeout: 10_000 });

  // Removed from a terminal: it goes.
  git(ROOT, `worktree remove "${outside}"`);
  await expect(sidebar(page).locator("div.group", { hasText: "feat/outside" }).filter({ has: page.locator("span.rounded-full") })).toHaveCount(0, { timeout: 10_000 });

  // A worktree folder deleted by hand shows as missing.
  execSync(`rm -rf "${wtPath("feat/behind")}"`);
  await expect(rowOf(page, "feat/behind").getByText("folder missing")).toBeVisible({ timeout: 10_000 });
});

test("a branch switched inside a worktree from a terminal shows up, with the folder named", async ({ page }) => {
  await repoPage(page);
  await expect(rowOf(page, "feat/behind")).toBeVisible();
  git(wtPath("feat/behind"), "switch -q spike/old");
  const row = sidebar(page).locator("div.group", { hasText: "spike/old" }).filter({ has: page.locator("span.rounded-full") });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText("in shop-feat-behind")).toBeVisible();
  // feat/behind no longer has a worktree, so it moves to Branches.
  await expect(sidebar(page).locator("div.group", { hasText: "feat/behind" }).filter({ has: page.locator("span.rounded-full") })).toHaveCount(0);
  // A worktree whose folder matches its branch doesn't repeat the folder.
  await expect(rowOf(page, "feat/login").getByText(/^in /)).toHaveCount(0);
});

test("a folder moved in Finder: missing, then Repair worktree reconnects it", async ({ page }) => {
  const moved = `${BASE}/moved somewhere`;
  await repoPage(page);
  await expect(rowOf(page, "feat/dirty")).toBeVisible();
  execSync(`mv "${wtPath("feat/dirty")}" "${moved}"`);
  await expect(rowOf(page, "feat/dirty").getByText("folder missing")).toBeVisible({ timeout: 10_000 });
  await rowOf(page, "feat/dirty").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Repair worktree…" }).click();
  // A wrong folder is refused and nothing changes.
  await page.getByRole("alertdialog").getByRole("textbox").fill(wtPath("feat/login"));
  await page.getByRole("alertdialog").getByRole("button", { name: "Repair worktree" }).click();
  await expect(rowOf(page, "feat/dirty").getByText("folder missing")).toBeVisible();
  // The right one works; the uncommitted work is still there.
  await rowOf(page, "feat/dirty").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Repair worktree…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill(moved);
  await page.getByRole("alertdialog").getByRole("button", { name: "Repair worktree" }).click();
  await expect(toast(page, "Repaired worktree feat/dirty")).toBeVisible();
  await expect(rowOf(page, "feat/dirty").getByText("folder missing")).toHaveCount(0);
  await expect(rowOf(page, "feat/dirty").getByText("in moved somewhere")).toBeVisible();
  expect(git(moved, "status --porcelain")).toContain("wip.txt");
  expect(git(ROOT, "worktree list")).toContain("moved somewhere");
});

test("done in a terminal: a detached checkout and a renamed branch both show up", async ({ page }) => {
  await repoPage(page);
  await expect(rowOf(page, "feat/behind")).toBeVisible();
  git(ROOT, "branch -m feat/behind feat/renamed");
  await expect(rowOf(page, "feat/renamed").getByText("in shop-feat-behind")).toBeVisible({ timeout: 10_000 });
  git(wtPath("feat/behind"), "switch -q --detach");
  await expect(sidebar(page).locator("div.group", { hasText: /detached/ }).first()).toBeVisible({ timeout: 10_000 });
});

test("shift-click two real commits: one diff with both commits' files", async ({ page }) => {
  await boot(page, `#/branch?root=${encodeURIComponent(ROOT)}&name=feat%2Flogin`);
  await page.getByText("Add lines", { exact: true }).click();
  await expect(page.getByText("lines.txt").first()).toBeVisible();
  await page.getByText("Add login", { exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.getByText("Changes in 3 commits")).toBeVisible();
  await expect(page.locator('[data-picked="true"]')).toHaveCount(3);
  const files = page.locator("aside").last();
  await expect(files.getByText("login.js")).toBeVisible();
  await expect(files.getByText("lines.txt")).toBeVisible();
  // login.js was added then improved: the range shows its final content once.
  await files.getByText("login.js").click();
  await expect(page.getByText("login v2")).toBeVisible();
  await expect(page.getByText("login v1")).toHaveCount(0);
  await expect(files.getByText("app.js")).toHaveCount(0);
});

test("a real merge conflict: pick a side, Continue makes the merge commit", async ({ page }) => {
  const wt = wtPath("feat/collide");
  const before = git(wt, "rev-parse HEAD");
  expect(gitOk(wt, "merge feat/login")).toBe(false);
  await worktreePage(page, "feat/collide");
  await expect(page.getByText("Merging feat/login into feat/collide")).toBeVisible();
  const card = page.getByRole("group", { name: "Conflict 1 of 1" });
  await expect(card.getByText("a different login")).toBeVisible();
  await card.getByRole("button", { name: "Keep feat/login" }).click();
  await expect(page.getByText("✓ Resolved")).toBeVisible();
  await expect(page.getByText("RESOLVED BY YOU · 1")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText(/^Merging/)).toHaveCount(0);
  expect(git(wt, "cat-file -p HEAD:login.js")).toBe("login v2");
  expect(git(wt, "rev-parse HEAD^1")).toBe(before);
  expect(git(wt, "rev-parse HEAD^2")).toBe(git(ROOT, "rev-parse feat/login"));
});

test("a real conflict: Back to conflicted, then Abort puts the branch back", async ({ page }) => {
  const wt = wtPath("feat/collide");
  const before = git(wt, "rev-parse HEAD");
  gitOk(wt, "merge feat/login");
  await worktreePage(page, "feat/collide");
  await page.getByRole("group", { name: "Conflict 1 of 1" }).getByRole("button", { name: "Keep both" }).click();
  await expect(page.getByText("✓ Resolved")).toBeVisible();
  expect(execSync(`cat "${wt}/login.js"`, { encoding: "utf8" })).toBe("a different login\nlogin v2\n");
  await page.getByRole("button", { name: "Back to conflicted" }).click();
  await expect(page.getByRole("group", { name: "Conflict 1 of 1" })).toBeVisible();
  expect(execSync(`cat "${wt}/login.js"`, { encoding: "utf8" })).toContain("<<<<<<<");
  await page.getByRole("button", { name: "Abort" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Abort" }).click();
  await expect(page.getByText(/^Merging/)).toHaveCount(0);
  expect(git(wt, "rev-parse HEAD")).toBe(before);
  expect(git(wt, "status --porcelain")).toBe("");
});

test("reword a real unpushed commit: message changes, uncommitted work stays, Undo puts it back", async ({ page }) => {
  const wt = wtPath("feat/login");
  const before = git(wt, "rev-parse HEAD");
  const status = git(wt, "status --porcelain");
  await worktreePage(page, "feat/login");
  // "Add app" is on origin/main, which others build on: no Reword for it.
  await logRow(page, "Add app").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Cherry-pick…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reword…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await commitAction(page, "Improve login", "Reword…");
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("Summary")).toHaveValue("Improve login");
  await dlg.getByLabel("Summary").fill("Make login better");
  await dlg.getByRole("button", { name: /^Reword/ }).click();
  await expect(toast(page, "Reworded")).toBeVisible();
  expect(git(wt, "log --format=%s -2")).toBe("Add lines\nMake login better");
  expect(git(wt, "status --porcelain")).toBe(status);
  await expect(logRow(page, "Make login better")).toBeVisible();
  await toast(page, "Reworded").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(wt, "rev-parse HEAD")).toBe(before);
  expect(git(wt, "status --porcelain")).toBe(status);
});

test("squash two real commits into one: same files, one commit", async ({ page }) => {
  const wt = wtPath("feat/login");
  const tree = git(wt, "rev-parse HEAD^{tree}");
  const status = git(wt, "status --porcelain");
  await worktreePage(page, "feat/login");
  await commitAction(page, "Add lines", "Squash into previous…");
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("Summary")).toHaveValue("Improve login");
  await dlg.getByLabel("Summary").fill("Login v2 with lines");
  await dlg.getByRole("button", { name: /^Squash/ }).click();
  await expect(toast(page, "Squashed 2 commits")).toBeVisible();
  expect(git(wt, "log --format=%s origin/feat/login..HEAD")).toBe("Login v2 with lines");
  expect(git(wt, "rev-parse HEAD^{tree}")).toBe(tree);
  expect(git(wt, "status --porcelain")).toBe(status);
});

test("drop a real commit: its file goes, Undo brings it back; a dirty worktree is refused", async ({ page }) => {
  const wt = wtPath("feat/collide");
  const before = git(wt, "rev-parse HEAD");
  await worktreePage(page, "feat/collide");
  await commitAction(page, "Rewrite login", "Drop…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop commit" }).click();
  await expect(toast(page, "Dropped")).toBeVisible();
  expect(git(wt, "rev-parse HEAD")).toBe(git(wt, `rev-parse ${before}^`));
  expect(gitOk(wt, "cat-file -e HEAD:login.js")).toBe(false);
  await toast(page, "Dropped").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(wt, "rev-parse HEAD")).toBe(before);
  expect(execSync(`cat "${wt}/login.js"`, { encoding: "utf8" })).toBe("a different login\n");

  // feat/login has uncommitted changes: drop is refused and nothing moves.
  const login = wtPath("feat/login");
  const tip = git(login, "rev-parse HEAD");
  await worktreePage(page, "feat/login");
  await commitAction(page, "Add lines", "Drop…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop commit" }).click();
  await expect(page.getByRole("alert")).toContainText("Commit or stash your changes");
  expect(git(login, "rev-parse HEAD")).toBe(tip);
});

test("reword a pushed commit, then Force push updates the real remote", async ({ page }) => {
  const wt = wtPath("feat/login");
  const origin = `${BASE}/origin.git`;
  const before = git(origin, "rev-parse feat/login");
  await worktreePage(page, "feat/login");
  await commitAction(page, "Add login", "Reword…");
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Already on origin/feat/login, so you'll force push afterwards.");
  await dlg.getByLabel("Summary").fill("Add the login page");
  await dlg.getByRole("button", { name: /^Reword/ }).click();
  await expect(toast(page, "Reworded")).toBeVisible();
  expect(git(origin, "rev-parse feat/login")).toBe(before);
  // Not Pull: that would bring the old commit back.
  await expect(page.getByRole("button", { name: /^Pull/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Force push…" }).click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("origin/feat/login will match feat/login");
  await expect(ask).toContainText("Add login");
  await ask.getByRole("button", { name: "Force push" }).click();
  await expect(toast(page, "Force pushed feat/login")).toBeVisible();
  expect(git(origin, "rev-parse feat/login")).toBe(git(wt, "rev-parse HEAD"));
  expect(git(origin, "log --format=%s feat/login -3")).toBe("Add lines\nImprove login\nAdd the login page");
  await expect(page.getByText("Up to date")).toBeVisible();
  // The remote's old commit is still kept in this repository.
  expect(git(ROOT, "for-each-ref '--format=%(objectname)' refs/pando/snapshots/force-push")).toBe(before);
});

test("a teammate's unpulled commit: pushed commits can't be reworded, and nothing is overwritten", async ({ page }) => {
  const origin = `${BASE}/origin.git`;
  git(ROOT, "fetch -q origin");
  const theirs = git(origin, "rev-parse feat/behind");
  const mine = git(wtPath("feat/behind"), "rev-parse HEAD");
  await worktreePage(page, "feat/behind");
  await expect(page.getByRole("button", { name: "Pull ↓1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Force push…" })).toHaveCount(0);
  await commitAction(page, "Start behind", "Reword…");
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Summary").fill("Should not happen");
  await dlg.getByRole("button", { name: /^Reword/ }).click();
  await expect(dlg).toContainText("rigin/feat/behind has commits you haven't pulled. Pull first");
  expect(git(wtPath("feat/behind"), "rev-parse HEAD")).toBe(mine);
  expect(git(origin, "rev-parse feat/behind")).toBe(theirs);
});

test("Create pull request starts from the branch's real commits (gh is stubbed)", async ({ page }) => {
  await worktreePage(page, "feat/login");
  await page.getByRole("button", { name: "Create pull request…" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("3 commits");
  await expect(dlg.getByLabel("Base")).toHaveValue("main");
  await expect(dlg.getByLabel("Title")).toHaveValue("Login");
  await expect(dlg.getByLabel("Description")).toHaveValue("- Add login\n- Improve login\n- Add lines");
  await dlg.getByLabel("Title").fill("Login, done properly");
  await dlg.getByRole("button", { name: /^Create pull request/ }).click();
  await expect(toast(page, "Created a pull request for feat/login")).toBeVisible();
  await expect.poll(async () => ((await bridge("__opened")) as string[]).map((x) => JSON.parse(x).req).filter(Boolean)).toContainEqual({ branch: "feat/login", base: "main", title: "Login, done properly", body: "- Add login\n- Improve login\n- Add lines", draft: false });
  // The base itself, and a branch that was never pushed, don't get the button.
  await worktreePage(page, "feat/dirty");
  await expect(page.getByRole("button", { name: "Push to origin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create pull request…" })).toHaveCount(0);
});

test("search real commits by message, author and id, inside the branch", async ({ page }) => {
  const box = page.getByLabel("Search commits");
  await repoPage(page);
  await expect(logRow(page, "Main moves on")).toBeVisible();
  await box.fill("LOGIN");
  for (const s of ["Add login", "Improve login", "Rewrite login"]) await expect(logRow(page, s)).toBeVisible();
  await expect(logRow(page, "Main moves on")).toHaveCount(0);
  // A short commit id finds exactly that commit.
  const id = git(wtPath("feat/collide"), "rev-parse HEAD");
  await box.fill(id.slice(0, 8));
  await expect(logRow(page, "Rewrite login")).toBeVisible();
  await expect(page.locator("[data-row]")).toHaveCount(1);
  // The author every setup commit has.
  await box.fill("test");
  await expect(logRow(page, "Initial commit")).toBeVisible();
  await box.press("Escape");
  await expect(logRow(page, "Main moves on")).toBeVisible();

  // On a worktree page the search stays on that branch.
  await worktreePage(page, "feat/collide");
  await expect(logRow(page, "Rewrite login")).toBeVisible();
  await box.fill("login");
  await expect(logRow(page, "Rewrite login")).toBeVisible();
  await expect(logRow(page, "Improve login")).toHaveCount(0);
  await expect(page.getByText("1 commit matches “login” on feat/collide")).toBeVisible();
});

test("switch a real linked worktree to another branch, keep its changes, and Undo", async ({ page }) => {
  const wt = wtPath("feat/dirty");
  await repoPage(page);
  await rowOf(page, "feat/dirty").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  const dlg = page.getByRole("alertdialog");
  // feat/login has a worktree, so it isn't offered; spike/old is free.
  await expect(dlg.getByRole("combobox").locator("option", { hasText: "feat/login" })).toHaveCount(0);
  await dlg.getByRole("combobox").selectOption("spike/old");
  await dlg.getByRole("button", { name: "Switch branch" }).click();
  await expect(toast(page, "Switched shop-feat-dirty to spike/old")).toBeVisible();
  expect(git(wt, "branch --show-current")).toBe("spike/old");
  // Its uncommitted work came along, and the row now names the folder.
  expect(execSync(`cat "${wt}/wip.txt"`, { encoding: "utf8" })).toBe("precious\n");
  await expect(rowOf(page, "spike/old").getByText("in shop-feat-dirty")).toBeVisible({ timeout: 10_000 });
  expect(gitOk(ROOT, "rev-parse --verify feat/dirty")).toBe(true);
  await toast(page, "Switched shop-feat-dirty to spike/old").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(wt, "branch --show-current")).toBe("feat/dirty");
  expect(execSync(`cat "${wt}/wip.txt"`, { encoding: "utf8" })).toBe("precious\n");
});

test("the Tags section lists the real tag; delete it, Undo brings it back", async ({ page }) => {
  const at = git(ROOT, "rev-parse v1");
  await repoPage(page);
  await sidebar(page).getByRole("button", { name: /TAGS/ }).click();
  const row = sidebar(page).locator("div.group", { hasText: "v1" }).filter({ hasText: at.slice(0, 7) });
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete tag" }).click();
  await expect(toast(page, "Deleted tag v1")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify -q refs/tags/v1")).toBe(false);
  await expect(sidebar(page).getByText("TAGS")).toHaveCount(0, { timeout: 10_000 });
  await toast(page, "Deleted tag v1").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(ROOT, "rev-parse v1")).toBe(at);
  await expect(sidebar(page).getByRole("button", { name: /TAGS/ })).toBeVisible({ timeout: 10_000 });
});

test("a real file's history and blame, from a commit and from a worktree's working copy", async ({ page }) => {
  const files = page.locator("aside").last();
  await boot(page, `#/branch?root=${encodeURIComponent(ROOT)}&name=feat%2Flogin`);
  await logRow(page, "Improve login").click();
  await files.locator("button[data-selected]", { hasText: "login.js" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "File history" }).click();
  // login.js at that commit: added, then improved. "Rewrite login" is on another branch.
  await expect(page.getByText("2 commits changed this file")).toBeVisible();
  await expect(files.locator("button[data-selected]")).toHaveText([/Improve login/, /Add login.*added/]);
  await files.locator("button[data-selected]").nth(1).click();
  await expect(page.getByText("login v1")).toBeVisible();
  await page.getByRole("button", { name: "Blame", exact: true }).click();
  const table = page.getByRole("table", { name: "Blame for login.js" });
  await expect(table.locator("[data-line='1']")).toContainText("Improve login");
  await expect(table.locator("[data-line='1']")).toContainText("login v2");

  // On the worktree page the working copy is blamed: the unsaved line isn't committed.
  await worktreePage(page, "feat/login");
  await page.locator("div.group", { hasText: "app.js" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Blame" }).click();
  const wc = page.getByRole("table", { name: "Blame for app.js" });
  await expect(wc.locator("[data-line='1']")).toContainText("Add app");
  await expect(wc.locator("[data-line='2']")).toContainText("Not committed yet");
  await expect(wc.locator("[data-line='2']")).toContainText("unsaved");
  // notes.txt is brand new: nothing to show history for.
  await page.getByRole("button", { name: "‹ Back" }).click();
  await page.locator("div.group", { hasText: "notes.txt" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "File history" })).toHaveCount(0);
});
