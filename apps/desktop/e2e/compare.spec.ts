import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { detail, fileDiff, repoUrl, ROOT, typical } from "./fixtures";

const cmp = (head: string) => ({ base: "main", head, ahead: 2, behind: 1, files: [{ path: "src/a.ts", added: 5, deleted: 1 }, { path: "README.md", added: 1, deleted: 0 }] });
const branchUrl = (name: string) => `/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent(name)}`;
const graph = (page: Page) => page.locator("div[tabindex='0']").first();

test("a branch opens on all its changes vs main", async ({ page }) => {
  await mockTauri(page, { ...typical(), compare: cmp("feat/login"), compare_file_diff: fileDiff("src/a.ts", 6) });
  await page.goto(branchUrl("feat/login"));
  await expect(page.getByText("All changes on feat/login vs main")).toBeVisible();
  await expect(page.getByText("2 commits", { exact: false }).first()).toBeVisible();
  await expect.poll(async () => (await callsTo(page, "compare_file_diff"))[0]).toEqual({ root: ROOT, base: "main", head: "feat/login", path: "src/a.ts" });
  await page.getByRole("button", { name: /README\.md/ }).click();
  await expect.poll(async () => (await callsTo(page, "compare_file_diff")).at(-1)?.path).toBe("README.md");
});

test("pick a commit, then go back to all changes", async ({ page }) => {
  await mockTauri(page, { ...typical(), compare: cmp("feat/login") });
  await page.goto(branchUrl("feat/login"));
  await expect(page.getByText("All changes on feat/login vs main")).toBeVisible();
  await graph(page).getByText("Commit number 1", { exact: true }).click();
  await expect(page.getByText("All changes on feat/login vs main")).toBeHidden();
  await expect.poll(async () => (await callsTo(page, "commit_diff")).length).toBeGreaterThan(0);
  await graph(page).getByRole("button", { name: /All changes/ }).click();
  await expect(page.getByText("All changes on feat/login vs main")).toBeVisible();
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
  await expect(page.getByText("All changes on feat/login vs main")).toBeVisible();
  await expect(all).toHaveClass(/bg-teal-50/);
  await expect(unc).not.toHaveClass(/bg-teal-50/);
  await unc.click();
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
});

test("a PR row lands on its changes", async ({ page }) => {
  await mockTauri(page, {
    ...typical(),
    prs_list: { state: "ok", prs: [{ number: 8, title: "Big feature", author: "a", draft: false, head: "feat/big", from_fork: false, url: "u", checks: "passing", review: "", updated_at: "" }] },
    compare: cmp("origin/feat/big"),
  });
  await page.goto(repoUrl());
  await page.locator("aside").first().getByText("Big feature").click();
  await expect(page.getByText("All changes on origin/feat/big vs main")).toBeVisible();
});

test("a compare that fails says so, with Retry", async ({ page }) => {
  await mockTauri(page, { ...typical(), compare: { $error: "git rev-list failed: fatal: ambiguous argument 'main...feat/login'" } });
  await page.goto(branchUrl("feat/login"));
  await expect(page.getByText("Couldn't compare these branches")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
