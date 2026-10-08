import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { detail, fileDiff, log, NOW, repoUrl, ROOT, typical } from "./fixtures";
import type { Backup } from "../src/lib/api";

const sidebar = (page: Page) => page.locator("aside").first();
const backups: Backup[] = [
  { refname: "refs/pando/backup/feat/gone", kind: "branch", branch: "feat/gone", id: "b".repeat(40), time: NOW - 120, files: [], branch_exists: false },
  { refname: "refs/pando/snapshots/discard/1", kind: "discard", branch: null, id: "d".repeat(40), time: NOW - 60, files: ["a.ts", "b c.ts"], branch_exists: false },
];

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), backups_list: backups, ...extra });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("no backups, no section", async ({ page }) => {
  await open(page, { backups_list: [] });
  await expect(sidebar(page).getByText("BACKUPS")).toHaveCount(0);
});

test("backups start folded and say what they are", async ({ page }) => {
  await open(page);
  await expect(sidebar(page).getByText("BACKUPS")).toBeVisible();
  await expect(sidebar(page).getByText("feat/gone")).toBeHidden();
  await sidebar(page).getByRole("button", { name: /BACKUPS/ }).click();
  await expect(sidebar(page).getByText("deleted branch", { exact: false })).toBeVisible();
  await expect(sidebar(page).getByText("Discarded changes")).toBeVisible();
  await expect(sidebar(page).getByText("2 files", { exact: false })).toBeVisible();
});

test("restore a deleted branch asks first, then calls restore", async ({ page }) => {
  await open(page, { backup_restore_branch: null });
  await sidebar(page).getByRole("button", { name: /BACKUPS/ }).click();
  await sidebar(page).getByRole("button", { name: "Actions for backup feat/gone" }).click();
  await page.getByRole("menuitem", { name: "Restore branch…" }).click();
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "backup_restore_branch")).toHaveLength(0);
  await sidebar(page).getByRole("button", { name: "Actions for backup feat/gone" }).click();
  await page.getByRole("menuitem", { name: "Restore branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore branch" }).click();
  await expect.poll(() => callsTo(page, "backup_restore_branch")).toEqual([{ root: ROOT, refname: "refs/pando/backup/feat/gone" }]);
  await expect(page.getByRole("status").getByText("Restored feat/gone")).toBeVisible();
});

test("restore files goes into the worktree you pick", async ({ page }) => {
  await open(page, { backup_restore_files: null });
  await sidebar(page).getByRole("button", { name: /BACKUPS/ }).click();
  await sidebar(page).getByText("Discarded changes").hover();
  await expect(sidebar(page).getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  await sidebar(page).getByText("Discarded changes").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restore files…" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("a.ts, b c.ts");
  await dlg.getByRole("combobox").selectOption({ label: "feat/login" });
  await dlg.getByRole("button", { name: "Restore files" }).click();
  await expect.poll(() => callsTo(page, "backup_restore_files")).toEqual([{ root: ROOT, refname: "refs/pando/snapshots/discard/1", worktree: `${ROOT}-feat-login` }]);
});

test("a refused restore explains itself", async ({ page }) => {
  await open(page, { backup_restore_branch: { $error: "feat/gone is checked out in /x. Switch that worktree to another branch first." } });
  await sidebar(page).getByRole("button", { name: /BACKUPS/ }).click();
  await sidebar(page).getByRole("button", { name: "Actions for backup feat/gone" }).click();
  await page.getByRole("menuitem", { name: "Restore branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore branch" }).click();
  await expect(page.getByRole("alert")).toContainText("checked out in /x");
});

test("Copy path and Show in Finder on a worktree", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  const row = sidebar(page).locator("div.group", { hasText: "feat/login" }).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ROOT}-feat-login`);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Show in / }).click();
  await expect.poll(async () => (await callsTo(page, "plugin:opener|reveal_item_in_dir")).length).toBe(1);
  expect(JSON.stringify((await callsTo(page, "plugin:opener|reveal_item_in_dir"))[0])).toContain(`${ROOT}-feat-login`);
});

test("tags on a commit can be pushed and deleted", async ({ page }) => {
  const l = log(3, ["main", "tag: v1.0.0"]);
  await open(page, { log_list: l, tag_delete: null, tag_push: null });
  await page.getByText("Commit number 0").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Push tag v1.0.0" }).click();
  await expect.poll(() => callsTo(page, "tag_push")).toEqual([{ root: ROOT, name: "v1.0.0" }]);
  await page.getByText("Commit number 0").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag v1.0.0…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete tag" }).click();
  await expect.poll(() => callsTo(page, "tag_delete")).toEqual([{ root: ROOT, name: "v1.0.0" }]);
  // A commit with no tags has no tag items.
  await page.getByText("Commit number 1").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /tag v/ })).toHaveCount(0);
});

test("arrow keys move through commits and stop at the ends", async ({ page }) => {
  const l = log(5);
  await open(page, { log_list: l });
  await page.getByText("Commit number 0").click();
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[1].id}`));
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[2].id}`));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[0].id}`));
});

test("arrow keys in the staging list pick the next file's diff", async ({ page }) => {
  const WT = `${ROOT}-feat-login`;
  const f = (path: string) => ({ path, orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false });
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f("a.ts"), f("b.ts"), f("c.ts")]), diff_file: fileDiff("x.ts", 3) });
  await page.goto(`/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await page.getByText("a.ts", { exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await callsTo(page, "diff_file")).at(-1)?.path).toBe("c.ts");
  // Typing in the commit box must not move the list.
  await page.getByLabel("Summary", { exact: true }).fill("x");
  await page.keyboard.press("ArrowUp");
  expect((await callsTo(page, "diff_file")).at(-1)?.path).toBe("c.ts");
});

test("a login failure says what to set up", async ({ page }) => {
  await open(page, { fetch_all: { $error: "git fetch --all --prune failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled" } });
  await sidebar(page).getByRole("button", { name: "Fetch" }).click();
  await expect(page.getByRole("alert")).toContainText("Git needs you to log in to this remote");
  await page.getByRole("alert").getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("alert")).toContainText("terminal prompts disabled");
});

test("an SSH key problem says so", async ({ page }) => {
  await open(page, { branch_push: { $error: "git push failed: git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository." } });
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Push/ }).click();
  await expect(page.getByRole("alert")).toContainText("SSH key");
});

test("fetches quietly on open and stays quiet when offline", async ({ page }) => {
  await page.clock.install();
  await open(page, { fetch_all: { $error: "git fetch failed: fatal: unable to access: Could not resolve host" } });
  await page.clock.runFor(4000);
  await expect.poll(async () => (await callsTo(page, "fetch_all")).length).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const before = (await callsTo(page, "fetch_all")).length;
  await page.clock.runFor(5 * 60 * 1000 + 1000);
  await expect.poll(async () => (await callsTo(page, "fetch_all")).length).toBeGreaterThan(before);
});
