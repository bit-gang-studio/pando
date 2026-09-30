import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { detail, fileDiff, log, repoUrl, ROOT, typical } from "./fixtures";

const cmp = (head: string, base = "main") => ({ base, head, ahead: 2, behind: 1, merge_base: "c".repeat(40), added: 6, deleted: 1, files: [{ path: "src/a.ts", added: 5, deleted: 1 }, { path: "README.md", added: 1, deleted: 0 }] });
const branchUrl = (name: string) => `/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent(name)}`;
const graph = (page: Page) => page.locator("div[tabindex='0']").first();
const header = (page: Page) => page.getByText(/^All changes on/).first();
const own = log(2), rest = log(6);
own.entries.forEach((e, i) => { e.summary = `Branch work ${i}`; });
rest.entries.forEach((e, i) => { e.summary = `Old history ${i}`; });
/// The branch's own range gets `own`, the shared history gets `rest`.
const logs = { $by: "branch", cases: { "main..feat/login": own, [`${"c".repeat(40)}`]: rest }, otherwise: typical().log_list };

test("a branch opens on all its changes since main, with line totals", async ({ page }) => {
  await mockTauri(page, { ...typical(), log_list: logs, compare: cmp("feat/login"), compare_file_diff: fileDiff("src/a.ts", 6) });
  await page.goto(branchUrl("feat/login"));
  await expect(header(page)).toContainText("All changes on feat/login since main");
  await expect(page.getByTitle("6 lines added, 1 removed")).toHaveText("+6 −1");
  await expect.poll(async () => (await callsTo(page, "compare_file_diff"))[0]).toEqual({ root: ROOT, base: "main", head: "feat/login", path: "src/a.ts" });
  await page.getByRole("button", { name: /README\.md/ }).click();
  await expect.poll(async () => (await callsTo(page, "compare_file_diff")).at(-1)?.path).toBe("README.md");
});

test("the list shows the branch's own commits first, then earlier history, dimmed", async ({ page }) => {
  await mockTauri(page, { ...typical(), log_list: logs, compare: cmp("feat/login") });
  await page.goto(branchUrl("feat/login"));
  await expect(page.getByText("2 commits on this branch")).toBeVisible();
  await expect(graph(page).getByText("Earlier history on main")).toBeVisible();
  const rows = await graph(page).locator("div[data-selected]").allTextContents();
  expect(rows[0]).toContain("Branch work 0");
  expect(rows[1]).toContain("Branch work 1");
  expect(rows[2]).toContain("Old history 0");
  await expect(graph(page).locator("div[data-selected]", { hasText: "Old history 0" }).locator("[data-dim=true]")).toHaveClass(/opacity-60/);
  await expect(graph(page).locator("div[data-selected]", { hasText: "Branch work 0" }).locator("[data-dim=true]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /All changes/ })).toContainText("since main · 2 commits");
});

test("it compares with origin/main when that exists", async ({ page }) => {
  const o = { ...typical().overview_load, compare_base: "origin/main" };
  await mockTauri(page, { ...typical(), overview_load: o, compare: cmp("feat/login", "origin/main") });
  await page.goto(branchUrl("feat/login"));
  await expect.poll(async () => (await callsTo(page, "compare"))[0]).toEqual({ root: ROOT, base: "origin/main", head: "feat/login" });
  await expect(header(page)).toContainText("since main");
});

test("a stacked PR compares with the branch it targets", async ({ page }) => {
  await mockTauri(page, {
    ...typical(),
    prs_list: { state: "ok", prs: [{ number: 9, title: "Step 2", author: "a", draft: false, head: "feat/login", base: "feat/step-1", from_fork: false, url: "u", checks: "none", review: "", updated_at: "" }] },
    compare: cmp("feat/login", "origin/feat/step-1"),
  });
  await page.goto(branchUrl("feat/login"));
  await expect.poll(async () => (await callsTo(page, "compare")).at(-1)?.base).toBe("origin/feat/step-1");
});

test("click the base name to compare with another branch", async ({ page }) => {
  await mockTauri(page, { ...typical(), compare: cmp("feat/login") });
  await page.goto(branchUrl("feat/login"));
  await header(page).getByRole("button", { name: "main" }).click();
  const items = await page.getByRole("menuitem").allTextContents();
  expect(items).toContain("main ✓");
  expect(items).not.toContain("feat/login");
  await page.getByRole("menuitem", { name: "spike/old" }).click();
  await expect.poll(async () => (await callsTo(page, "compare")).at(-1)?.base).toBe("spike/old");
});

test("pick a commit, then go back to all changes", async ({ page }) => {
  await mockTauri(page, { ...typical(), log_list: logs, compare: cmp("feat/login") });
  await page.goto(branchUrl("feat/login"));
  await expect(header(page)).toBeVisible();
  await graph(page).getByText("Branch work 1", { exact: true }).click();
  await expect(header(page)).toBeHidden();
  await expect.poll(async () => (await callsTo(page, "commit_diff")).length).toBeGreaterThan(0);
  await graph(page).getByRole("button", { name: /All changes/ }).click();
  await expect(header(page)).toBeVisible();
});

test("a single commit shows its line totals too", async ({ page }) => {
  await mockTauri(page, typical());
  await page.goto(repoUrl());
  await graph(page).getByText("Commit number 0", { exact: true }).click();
  await expect(page.getByTitle("3 lines added, 1 removed")).toHaveText("+3 −1");
});

test("main itself has no All changes row", async ({ page }) => {
  await mockTauri(page, typical());
  for (const name of ["main", "origin/main"]) {
    await page.goto(branchUrl(name));
    await expect(graph(page).getByText("Commit number 0")).toBeVisible();
    await expect(page.getByRole("button", { name: /All changes/ })).toHaveCount(0);
  }
  expect(await callsTo(page, "compare")).toHaveLength(0);
});

test("on a worktree, All changes sits under Uncommitted changes and only one is picked", async ({ page }) => {
  const WT = `${ROOT}-feat-login`;
  const f = { path: "a.ts", orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false };
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f]), compare: cmp("feat/login") });
  await page.goto(`/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
  const all = page.getByRole("button", { name: /All changes/ });
  const unc = page.getByRole("button", { name: /Uncommitted changes/ });
  await all.click();
  await expect(header(page)).toContainText("since main");
  await expect(all).toHaveClass(/bg-teal-50/);
  await expect(unc).not.toHaveClass(/bg-teal-50/);
  await unc.click();
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
});

test("a compare that fails says so, with Retry", async ({ page }) => {
  await mockTauri(page, { ...typical(), compare: { $error: "git rev-list failed: fatal: ambiguous argument 'main...feat/login'" } });
  await page.goto(branchUrl("feat/login"));
  await expect(page.getByText("Couldn't compare these branches")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("graph lines are never see-through, so rows join without dots", async ({ page }) => {
  await mockTauri(page, { ...typical(), log_list: logs, compare: cmp("feat/login") });
  await page.goto(branchUrl("feat/login"));
  await expect(graph(page).getByText("Earlier history on main")).toBeVisible();
  // Any ancestor with opacity < 1 makes the 1px row overlaps paint twice.
  const faded = await graph(page).locator("svg").evaluateAll((svgs) =>
    svgs.filter((svg) => {
      for (let el: Element | null = svg; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) < 1) return true;
      return false;
    }).length);
  expect(faded).toBe(0);
});
