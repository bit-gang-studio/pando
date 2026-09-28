import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";
import type { PullRequest } from "../src/lib/api";

const sidebar = (page: Page) => page.locator("aside").first();
const pr = (over: Partial<PullRequest>): PullRequest => ({
  number: 1, title: "A change", author: "ana", draft: false, head: "feat/x", from_fork: false,
  url: "https://github.com/o/r/pull/1", checks: "passing", review: "", updated_at: "2026-09-27T00:00:00Z", ...over,
});
const list = (prs: PullRequest[]) => ({ state: "ok", prs });

async function open(page: Page, extra: Record<string, unknown>) {
  await mockTauri(page, { ...typical(), ...extra });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
}

for (const state of ["no_gh", "signed_out", "not_git_hub"]) {
  test(`no pull requests section when gh says ${state}`, async ({ page }) => {
    await open(page, { prs_list: { state } });
    await page.waitForTimeout(300);
    await expect(sidebar(page).getByText("PULL REQUESTS")).toHaveCount(0);
  });
}

test("gh failing outright doesn't break the page", async ({ page }) => {
  await open(page, { prs_list: { $error: "spawn failed" } });
  await expect(sidebar(page).getByText("feat/login")).toBeVisible();
  await expect(sidebar(page).getByText("PULL REQUESTS")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("open PRs list with checks, draft, review and forks", async ({ page }) => {
  await open(page, { prs_list: list([
    pr({ number: 475, title: "Add login", checks: "failing", review: "CHANGES_REQUESTED" }),
    pr({ number: 476, title: "Docs", draft: true, checks: "pending", head: "docs/x" }),
    pr({ number: 477, title: "From outside", from_fork: true, head: "main", checks: "none" }),
  ]) });
  const s = sidebar(page);
  await expect(s.getByText("PULL REQUESTS")).toBeVisible();
  await expect(s.getByText("#475")).toBeVisible();
  await expect(s.getByLabel("Checks failing")).toBeVisible();
  await expect(s.getByText("changes requested", { exact: false })).toBeVisible();
  await expect(s.getByText("draft", { exact: false })).toBeVisible();
  await expect(s.getByLabel("Checks running")).toBeVisible();
  await expect(s.getByText("from a fork", { exact: false })).toBeVisible();
});

test("no open PRs says so", async ({ page }) => {
  await open(page, { prs_list: list([]) });
  await expect(sidebar(page).getByText("No open pull requests.")).toBeVisible();
});

test("Add worktree checks out the PR and goes to it", async ({ page }) => {
  const made = { worktree: wt(`${ROOT}-feat-x`, "feat/x") };
  await open(page, { prs_list: list([pr({ number: 9, head: "feat/x" })]), pr_add_worktree: made });
  await sidebar(page).getByText("A change").hover();
  await sidebar(page).getByRole("button", { name: "Add worktree" }).click();
  await expect.poll(async () => ((await callsTo(page, "pr_add_worktree"))[0]?.pr as PullRequest | undefined)?.number).toBe(9);
  await expect(page).toHaveURL(/#\/worktree\?/);
});

test("a PR whose branch has a worktree shows its dot and badge, no Add worktree", async ({ page }) => {
  const o = overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/x", { worktree: wt(`${ROOT}-feat-x`, "feat/x") })] });
  await open(page, { overview_load: o, prs_list: list([pr({ number: 12, head: "feat/x" })]) });
  // The worktree row gets the badge.
  const wtRow = sidebar(page).locator("div.group", { hasText: `feat/x` }).first();
  await expect(wtRow.getByText("#12")).toBeVisible();
  // The PR row has no Add worktree, and its menu offers a new window instead.
  await sidebar(page).getByRole("button", { name: "Actions for #12" }).click();
  await expect(page.getByRole("menuitem", { name: "Add worktree" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
});

test("a failed checkout explains itself", async ({ page }) => {
  await open(page, { prs_list: list([pr({ number: 5 })]), pr_add_worktree: { $error: "git fetch failed: fatal: couldn't find remote ref refs/pull/5/head" } });
  await sidebar(page).getByRole("button", { name: "Actions for #5" }).click();
  await page.getByRole("menuitem", { name: "Add worktree" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't find remote ref");
});

test("hostile PR titles render as text", async ({ page }) => {
  const evil = `<img src=x onerror="window.__pwned=1">`;
  await open(page, { prs_list: list([pr({ title: evil, author: evil })]) });
  await expect(sidebar(page).getByText(evil).first()).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
});

test("PR loads once on open, not on every refresh", async ({ page }) => {
  await open(page, { prs_list: list([pr({})]) });
  await page.evaluate(() => (window as unknown as { __emit: (e: string, p: string) => void }).__emit("repo-changed", "/Users/me/code/proj"));
  await page.waitForTimeout(500);
  expect((await callsTo(page, "prs_list")).length).toBeLessThanOrEqual(2); // dev mode runs effects twice
});
