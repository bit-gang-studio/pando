import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { detail, log, repoUrl, ROOT, typical } from "./fixtures";

// One rule: only the top layer hears a key. These try to make a key reach
// something behind a dialog, confirm or menu.

const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const staged = { path: "a.ts", orig_path: null, staged: "M", unstaged: null, untracked: false, conflicted: false };
const unstaged = { ...staged, staged: null, unstaged: "M" };
const sidebar = (page: Page) => page.locator("aside").first();
const onWorktree = (page: Page) => expect(page).toHaveURL(/#\/worktree/);

async function worktree(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [staged, { ...unstaged, path: "b.ts" }]), worktree_path_preview: `${ROOT}-x`, commit_create: null, ...extra });
  await page.goto(wtUrl);
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
}
async function commitSelected(page: Page) {
  const l = log(5);
  await mockTauri(page, { ...typical(), log_list: l, worktree_path_preview: `${ROOT}-x` });
  await page.goto(repoUrl());
  await page.getByText("Commit number 1").click();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[1].id}`));
  return l.entries[1].id;
}

test("Escape in New branch closes only the dialog, not the commit behind it", async ({ page }) => {
  const id = await commitSelected(page);
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("dialog").getByRole("textbox").first().fill("feat/x");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${id}`));
});

test("a commit open on a worktree page: Escape in New branch, even mid-typing, leaves it open", async ({ page }) => {
  await worktree(page);
  await page.getByText("Commit number 2", { exact: true }).click();
  const back = page.getByRole("button", { name: "‹ Back to list" });
  await expect(back).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("dialog").getByRole("textbox").first().fill("feat/x");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(back).toBeVisible();
  // With nothing on top, Escape goes back to the list, then to the repo.
  await page.keyboard.press("Escape");
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
  await onWorktree(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/repo/);
});

test("Escape in New branch with focus on a checkbox or nothing stays on the worktree", async ({ page }) => {
  await worktree(page);
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("checkbox").first().focus();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await onWorktree(page);
  await page.keyboard.press("ControlOrMeta+n");
  await dlg.locator("h2").click();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await onWorktree(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/repo/);
});

test("Escape closes a menu, not the page behind it", async ({ page }) => {
  await worktree(page);
  await sidebar(page).locator("div.group", { hasText: "fix/typo" }).first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await onWorktree(page);
});

test("Escape in a confirm cancels it and nothing else", async ({ page }) => {
  await worktree(page, { discard_paths: null });
  await page.getByText("b.ts").first().hover();
  await page.getByRole("button", { name: /Discard/ }).first().click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await onWorktree(page);
  expect(await callsTo(page, "discard_paths")).toHaveLength(0);
});

test("⌘N with a menu open doesn't open a dialog under it", async ({ page }) => {
  await worktree(page);
  await sidebar(page).locator("div.group", { hasText: "fix/typo" }).first().click({ button: "right" });
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeVisible();
});

test("⌘↵ in a dialog or confirm never commits behind it", async ({ page }) => {
  await worktree(page, { worktree_add: { $error: "stop here" } });
  await page.getByLabel("Summary", { exact: true }).fill("Ready to commit");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("dialog").getByRole("textbox").first().fill("feat/x");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await callsTo(page, "worktree_add")).length).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByText("b.ts").first().hover();
  await page.getByRole("button", { name: /Discard/ }).first().click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "commit_create")).toHaveLength(0);
  // And with nothing on top it still commits.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await callsTo(page, "commit_create")).length).toBe(1);
});

test("⌘N and ⌘L do nothing while a dialog or confirm is open", async ({ page }) => {
  await worktree(page);
  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(await callsTo(page, "merge_preflight")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.getByText("b.ts").first().hover();
  await page.getByRole("button", { name: /Discard/ }).first().click();
  await page.keyboard.press("ControlOrMeta+n");
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toBeVisible();
});

test("Escape while typing a commit message stays on the worktree", async ({ page }) => {
  await worktree(page);
  await page.getByLabel("Summary", { exact: true }).fill("half a thought");
  await page.keyboard.press("Escape");
  await page.getByLabel("Description").fill("more");
  await page.keyboard.press("Escape");
  await onWorktree(page);
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("half a thought");
});

test("Escape can't close New branch while it's working", async ({ page }) => {
  await worktree(page, { worktree_add: { $delay: 1500, value: { worktree: { path: `${ROOT}-x` } } } });
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox").first().fill("feat/x");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dlg.getByText("Working…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeVisible();
  await onWorktree(page);
});

test("Escape in the Merge dialog closes it and stays on the worktree", async ({ page }) => {
  await worktree(page, { merge_preflight: { branch: "feat/login", base: "main", base_local: "main", clean: true, ahead: 2, behind: 0, conflict_predicted: false, conflict_files: [], base_checked_out_in: ROOT, base_worktree_clean: true, has_upstream: false, last_summary: "x", uncommitted: 0, problems: [] } });
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await onWorktree(page);
});

test("Escape in Clone closes it and nothing else", async ({ page }) => {
  await mockTauri(page, { ...typical(), github_repos: { repos: [] } });
  await page.goto("/");
  await page.getByRole("button", { name: "Clone repository" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clone repository" })).toBeVisible();
});
