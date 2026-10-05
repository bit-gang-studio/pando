import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { commitDiff, detail, log, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// Force push: only offered when the branch was rewritten here.

const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const l = log(6);
const gone = { entries: [
  { id: "a".repeat(40), parents: [], author: "Sam", time: 1, summary: "Old wording", refs: [], is_head: false },
  { id: "b".repeat(40), parents: [], author: "Sam", time: 1, summary: "Another old one", refs: [], is_head: false },
], truncated: false };
const sidebar = (page: Page) => page.locator("aside").first();

function setup(rewritten: boolean, up: [number, number] = [2, 2]) {
  const login = row("feat/login", { worktree: wt(WT, "feat/login"), upstream: "origin/feat/login", up, rewritten });
  const d = detail(WT, "feat/login", []);
  d.branch = login.branch;
  return {
    ...typical(),
    overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), login, row("spike/old", { upstream: "origin/spike/old", up: [1, 3], rewritten: true })] }),
    detail_load: d,
    log_list: { $by: "branch", cases: { "feat/login..origin/feat/login": gone, "spike/old..origin/spike/old": gone }, otherwise: l },
    branch_force_push: null, branch_pull: null, branch_push: null,
  };
}
async function open(page: Page, handlers: Record<string, unknown>, url = wtUrl) {
  await mockTauri(page, handlers);
  await page.goto(url);
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
}

test("a rewritten branch offers Force push, not Pull, and names what's replaced", async ({ page }) => {
  await open(page, setup(true));
  await expect(page.getByRole("button", { name: /^Pull/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Force push…" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("origin/feat/login will match feat/login");
  await expect(dlg).toContainText("aaaaaaa Old wording · Sam");
  await expect(dlg).toContainText("Another old one");
  await expect(dlg).toContainText("Anyone else using this branch will have to reset to it.");
  // Enter must not push: Cancel has the focus on a dangerous confirm.
  await page.keyboard.press("Enter");
  await expect(dlg).toHaveCount(0);
  expect(await callsTo(page, "branch_force_push")).toHaveLength(0);
  await page.getByRole("button", { name: "Force push…" }).click();
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "branch_force_push")).toHaveLength(0);
  await page.getByRole("button", { name: "Force push…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Force push" }).click();
  await expect.poll(() => callsTo(page, "branch_force_push")).toEqual([{ root: ROOT, name: "feat/login" }]);
  await expect(page.getByRole("status").filter({ hasText: "Force pushed feat/login" })).toBeVisible();
  expect(await callsTo(page, "branch_pull")).toHaveLength(0);
  expect(await callsTo(page, "branch_push")).toHaveLength(0);
});

test("ahead and behind because a teammate pushed: Pull as before, no Force push anywhere", async ({ page }) => {
  await open(page, setup(false));
  await expect(page.getByRole("button", { name: "Pull ↓2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Force push…" })).toHaveCount(0);
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Pull" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Force push…" })).toHaveCount(0);
});

test("more replaced commits than fit are counted", async ({ page }) => {
  const many = { entries: Array.from({ length: 6 }, (_, i) => ({ ...gone.entries[0], id: `${i}`.repeat(40), summary: `Old ${i}` })), truncated: true };
  const h = setup(true, [9, 9]);
  await open(page, { ...h, log_list: { $by: "branch", cases: { "feat/login..origin/feat/login": many }, otherwise: l } });
  await page.getByRole("button", { name: "Force push…" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("Old 4");
  await expect(dlg).not.toContainText("Old 5");
  await expect(dlg).toContainText("and 4 more");
});

test("a refused force push says why and claims nothing", async ({ page }) => {
  await open(page, { ...setup(true), branch_force_push: { $error: "origin/feat/login has commits this branch never had. Someone else may have pushed. Pull first, or look at them." } });
  await page.getByRole("button", { name: "Force push…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Force push" }).click();
  await expect(page.getByRole("alert")).toContainText("Someone else may have pushed");
  await expect(page.getByRole("status").filter({ hasText: "Force pushed" })).toHaveCount(0);
});

test("the sidebar menus swap Pull and Push for Force push on a rewritten branch", async ({ page }) => {
  await open(page, setup(true), repoUrl());
  await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Force push…" })).toBeVisible();
  for (const name of ["Pull", "Push"]) await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A branch with no worktree too.
  await sidebar(page).locator("div.group", { hasText: "spike/old" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Force push…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("origin/spike/old will match spike/old");
  await page.getByRole("alertdialog").getByRole("button", { name: "Force push" }).click();
  await expect.poll(() => callsTo(page, "branch_force_push")).toEqual([{ root: ROOT, name: "spike/old" }]);
  // main isn't rewritten: plain Push.
  await sidebar(page).locator("div.group", { hasText: "main" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Push/ })).toBeVisible();
});

test("rewording a commit that's already pushed says a force push follows", async ({ page }) => {
  const h = setup(false, [1, 0]);
  await open(page, { ...h, log_list: l, rewrite_editable: [l.entries[0].id, l.entries[1].id], rewrite_pushed: [l.entries[1].id], commit_diff: commitDiff() });
  await page.getByText("Commit number 1", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reword…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Already on origin/feat/login, so you'll force push afterwards.");
  await page.keyboard.press("Escape");
  // The unpushed one has no such note; squashing it into the pushed one does.
  await page.getByText("Commit number 0", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reword…" }).click();
  await expect(page.getByRole("dialog")).not.toContainText("force push");
  await page.keyboard.press("Escape");
  await page.getByText("Commit number 0", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Squash into previous…" }).click();
  await expect(page.getByRole("dialog")).toContainText("you'll force push afterwards");
});
