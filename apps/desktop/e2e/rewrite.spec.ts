import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { commitDiff, detail, log, repoUrl, ROOT, typical } from "./fixtures";

// Reword, squash and drop: only on commits that haven't been pushed.

const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const l = log(6);
const id = (i: number) => l.entries[i].id;
const unpushed = [id(0), id(1), id(2)];
const done = { branch: "feat/login", old_tip: id(0), new_tip: "f".repeat(40), paused: false };
const messages = { $by: "id", cases: Object.fromEntries(l.entries.map((e, i) => [e.id, { ...commitDiff(), message: `Commit number ${i}\n\nBody of ${i}.` }])) };
const row = (page: Page, i: number) => page.getByText(`Commit number ${i}`, { exact: true });
const menu = (page: Page, i: number) => row(page, i).click({ button: "right" });
const item = (page: Page, name: string | RegExp) => page.getByRole("menuitem", { name });
const dlg = (page: Page) => page.getByRole("dialog");

async function open(page: Page, extra: Record<string, unknown> = {}, url = wtUrl) {
  await mockTauri(page, {
    ...typical(), log_list: l, detail_load: detail(WT, "feat/login", []), rewrite_editable: unpushed, commit_diff: messages,
    commit_reword: done, commit_squash: done, commit_drop: done, rewrite_undo: null,
    commit_range: { older: id(2), newer: id(0), base: "b".repeat(40), ancestor: true, commits: [id(0), id(1), id(2)], count: 3, added: 1, deleted: 0, files: [] },
    ...extra,
  });
  await page.goto(url);
  await expect(row(page, 0)).toBeVisible();
}

test("only unpushed commits get Reword, Squash and Drop", async ({ page }) => {
  await open(page);
  await menu(page, 1);
  await expect(item(page, "Reword…")).toBeVisible();
  await expect(item(page, "Squash into previous…")).toBeVisible();
  await expect(item(page, "Drop…")).toBeVisible();
  await page.keyboard.press("Escape");
  // The oldest unpushed commit sits on a pushed one: nothing to squash into.
  await menu(page, 2);
  await expect(item(page, "Reword…")).toBeVisible();
  await expect(item(page, /Squash/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menu(page, 4);
  await expect(item(page, "Cherry-pick…")).toBeVisible();
  for (const name of ["Reword…", /Squash/, "Drop…"]) await expect(item(page, name)).toHaveCount(0);
});

test("the All branches page offers none of them and never asks", async ({ page }) => {
  await open(page, {}, repoUrl());
  await menu(page, 0);
  await expect(item(page, "Cherry-pick…")).toBeVisible();
  for (const name of ["Reword…", /Squash/, "Drop…"]) await expect(item(page, name)).toHaveCount(0);
  expect(await callsTo(page, "rewrite_editable")).toHaveLength(0);
});

test("a branch with no worktree can reword and squash, but not drop", async ({ page }) => {
  await open(page, {}, `/#/branch?root=${encodeURIComponent(ROOT)}&name=spike%2Fold`);
  await expect.poll(async () => (await callsTo(page, "rewrite_editable")).at(-1)).toEqual({ root: ROOT, branch: "spike/old" });
  await menu(page, 1);
  await expect(item(page, "Reword…")).toBeVisible();
  await expect(item(page, "Squash into previous…")).toBeVisible();
  await expect(item(page, "Drop…")).toHaveCount(0);
});

test("Reword starts from the old message, sends the new one, and can be undone", async ({ page }) => {
  await open(page);
  await menu(page, 1);
  await item(page, "Reword…").click();
  await expect(dlg(page).getByLabel("Summary")).toHaveValue("Commit number 1");
  await expect(dlg(page).getByLabel("Description")).toHaveValue("Body of 1.");
  await dlg(page).getByLabel("Summary").fill("  A better summary ");
  await dlg(page).getByLabel("Description").fill("");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(() => callsTo(page, "commit_reword")).toEqual([{ root: ROOT, branch: "feat/login", id: id(1), message: "A better summary" }]);
  await expect(dlg(page)).toHaveCount(0);
  const toast = page.getByRole("status").filter({ hasText: `Reworded ${id(1).slice(0, 7)}` });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => callsTo(page, "rewrite_undo")).toEqual([{ root: ROOT, branch: "feat/login", from: done.new_tip, to: done.old_tip }]);
  // The commit box behind the dialog never got that ⌘↵.
  expect(await callsTo(page, "commit_create")).toHaveLength(0);
});

test("a refused reword stays open with what you typed", async ({ page }) => {
  await open(page, { commit_reword: { $error: "abc1234 is already pushed to origin/feat/login. Pando only changes commits that haven't been pushed." } });
  await menu(page, 0);
  await item(page, "Reword…").click();
  await dlg(page).getByLabel("Summary").fill("Typed with care");
  await dlg(page).getByRole("button", { name: /^Reword/ }).click();
  await expect(dlg(page).getByText("already pushed to origin/feat/login")).toBeVisible();
  await expect(dlg(page).getByLabel("Summary")).toHaveValue("Typed with care");
  await expect(page.getByRole("status").filter({ hasText: "Reworded" })).toHaveCount(0);
  // An empty summary can't be sent.
  await dlg(page).getByLabel("Summary").fill("   ");
  await expect(dlg(page).getByRole("button", { name: /^Reword/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  expect(await callsTo(page, "commit_reword")).toHaveLength(1);
  // Escape closes only the dialog.
  await page.keyboard.press("Escape");
  await expect(dlg(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/worktree/);
});

test("Squash into previous joins this commit and the one before, oldest message first", async ({ page }) => {
  await open(page);
  await menu(page, 0);
  await item(page, "Squash into previous…").click();
  await expect(dlg(page).getByText("Squash 2 commits")).toBeVisible();
  await expect(dlg(page).getByLabel("Summary")).toHaveValue("Commit number 1");
  await expect(dlg(page).getByLabel("Description")).toHaveValue("Body of 1.\n\nCommit number 0\n\nBody of 0.");
  await dlg(page).getByRole("button", { name: /^Squash/ }).click();
  await expect.poll(() => callsTo(page, "commit_squash")).toEqual([{ root: ROOT, branch: "feat/login", older: id(1), newer: id(0), message: "Commit number 1\n\nBody of 1.\n\nCommit number 0\n\nBody of 0." }]);
  await expect(page.getByRole("status").filter({ hasText: "Squashed 2 commits" })).toBeVisible();
});

test("commits picked with shift-click squash together", async ({ page }) => {
  await open(page);
  await row(page, 0).click();
  await row(page, 2).click({ modifiers: ["Shift"] });
  await expect(page.locator('[data-picked="true"]')).toHaveCount(3);
  await menu(page, 1);
  await item(page, "Squash 3 commits…").click();
  await expect(dlg(page).getByLabel("Summary")).toHaveValue("Commit number 2");
  await dlg(page).getByLabel("Summary").fill("One tidy commit");
  await dlg(page).getByLabel("Description").fill("");
  await dlg(page).getByRole("button", { name: /^Squash/ }).click();
  await expect.poll(() => callsTo(page, "commit_squash")).toEqual([{ root: ROOT, branch: "feat/login", older: id(2), newer: id(0), message: "One tidy commit" }]);
  await expect(page.locator('[data-picked="true"]')).toHaveCount(0);
});

test("a pick that reaches a pushed commit can't be squashed as a group", async ({ page }) => {
  await open(page, { commit_range: { older: id(3), newer: id(1), base: "b".repeat(40), ancestor: true, commits: [id(1), id(2), id(3)], count: 3, added: 1, deleted: 0, files: [] } });
  await row(page, 1).click();
  await row(page, 3).click({ modifiers: ["Shift"] });
  await expect(page.locator('[data-picked="true"]')).toHaveCount(3);
  await menu(page, 2);
  await expect(item(page, "Reword…")).toBeVisible();
  await expect(item(page, /Squash \d/)).toHaveCount(0);
});

test("Drop asks first; Escape drops nothing", async ({ page }) => {
  await open(page);
  await menu(page, 1);
  await item(page, "Drop…").click();
  await expect(page.getByRole("alertdialog")).toContainText(`Remove ${id(1).slice(0, 7)} Commit number 1 and its changes from feat/login?`);
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "commit_drop")).toHaveLength(0);
  await menu(page, 1);
  await item(page, "Drop…").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop commit" }).click();
  await expect.poll(() => callsTo(page, "commit_drop")).toEqual([{ root: ROOT, branch: "feat/login", id: id(1) }]);
  await page.getByRole("status").filter({ hasText: `Dropped ${id(1).slice(0, 7)}` }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await callsTo(page, "rewrite_undo")).length).toBe(1);
});

test("a drop that pauses on conflicts says so and offers no Undo", async ({ page }) => {
  await open(page, { commit_drop: { ...done, new_tip: done.old_tip, paused: true } });
  await menu(page, 1);
  await item(page, "Drop…").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop commit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Later commits conflict without it" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Dropped" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("a refused drop says why", async ({ page }) => {
  await open(page, { commit_drop: { $error: "Commit or stash your changes before dropping a commit." } });
  await menu(page, 0);
  await item(page, "Drop…").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop commit" }).click();
  await expect(page.getByRole("alert")).toContainText("Commit or stash your changes");
  await setReply(page, "commit_drop", done);
});
