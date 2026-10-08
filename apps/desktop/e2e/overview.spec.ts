import { expect, test, type Page } from "@playwright/test";
import { callsTo, emit, mockTauri, setReply } from "./mock";
import { NOW, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// The Overview: how the picked branch stands next to the base and the
// branches around it. What it's built on, and what's built on top of it.

const W = `${ROOT}-spaces`, STUDIO = `${ROOT}-studio`;
const pr = { number: 544, title: "Spaces step 2", url: "https://x/544", head: "feat/step-2", base: "main", author: "Chris", draft: false, checks: "passing", review: "", from_fork: false };
const repo = () => overview({ branches: [
  row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }),
  row("feat/step-3", { worktree: wt(W, "feat/step-3"), status: { staged: 0, unstaged: 13, untracked: 0, conflicts: 0 } }),
  row("feat/step-2", { upstream: "origin/feat/step-2", up: [1, 2] }),
  row("feat/studio", { worktree: wt(STUDIO, "feat/studio") }),
  row("spike/on-3"),
], compare_base: "origin/main" });
const fork = { id: "f".repeat(40), summary: "Merge #541", author: "Sam", time: NOW - 86400 * 3 };
const stacked = { target: "feat/step-3", base: "origin/main", fork, ahead: 5, behind: 14, below: [{ name: "feat/step-2", remote: false, commits: 3 }], own: 2, above: [{ name: "spike/on-3", remote: false, commits: 1 }, { name: "origin/theirs", remote: true, commits: 12 }] };
const plain = (target: string, extra: object = {}) => ({ target, base: "origin/main", fork, ahead: 1, behind: 0, below: [], own: 1, above: [], ...extra });
const wtUrl = (p: string) => `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(p)}`;
const brUrl = (n: string) => `/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent(n)}`;
const line = (page: Page) => page.getByRole("list", { name: /^What .* is built on$/ });
const link = (page: Page, name: string) => line(page).locator(`[data-link="${name}"]`);

async function open(page: Page, url: string, extra: Record<string, unknown> = {}) {
  await page.addInitScript(() => { if (!localStorage.getItem("pando.view")) localStorage.setItem("pando.view", "overview"); });
  await mockTauri(page, { ...typical(), overview_load: repo(), prs_list: { state: "ok", prs: [pr] }, overlaps: [{ a: W, b: STUDIO, files: ["a.php", "b.php", "c.php", "d.php", "e.php"] }], relate_load: stacked, ...extra });
  await page.goto(url);
  await expect(page.locator("aside").first().getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("Overview is the last choice in the toggle, and it's remembered", async ({ page }) => {
  await mockTauri(page, { ...typical(), overview_load: repo(), relate_load: stacked });
  await page.goto(wtUrl(W));
  const toggle = page.getByRole("group", { name: "View" });
  await expect(toggle.getByRole("button")).toHaveText(["Commits", "Files", "Overview"]);
  await toggle.getByRole("button", { name: "Overview" }).click();
  await expect(line(page)).toBeVisible();
  await page.reload();
  await expect(line(page)).toBeVisible();
});

test("a stacked branch: the base, what it's built on, itself, and what's built on top, in that order", async ({ page }) => {
  await open(page, wtUrl(W));
  expect((await callsTo(page, "relate_load")).at(-1)).toEqual({ root: ROOT, target: "feat/step-3", base: "origin/main" });
  await expect(page.locator("[data-summary]")).toHaveText("feat/step-3 is built on feat/step-2, which leads back to origin/main. origin/main has moved on by 14 commits since.");
  await expect(line(page).locator("[data-link]")).toHaveCount(5);
  expect(await line(page).locator("[data-link]").evaluateAll((els) => els.map((e) => e.getAttribute("data-link")))).toEqual(["origin/main", "feat/step-2", "feat/step-3", "spike/on-3", "origin/theirs"]);
  await expect(link(page, "origin/main")).toContainText("forked here 3d ago");
  await expect(link(page, "origin/main")).toContainText("14 commits on origin/main since, that feat/step-3 doesn't have");
  // Its pull request and whether it has a folder.
  await expect(link(page, "feat/step-2")).toContainText("#544");
  await expect(link(page, "feat/step-2")).toContainText("3 commits · no folder");
  await expect(link(page, "origin/theirs")).toContainText("12 commits · on the remote only, not checked out here");
  // The picked one: its own commits, its folder, and its remote copy.
  const me = link(page, "feat/step-3");
  await expect(me).toContainText("selected");
  await expect(me).toContainText("2 commits of its own");
  await expect(me).toContainText("Folder: proj-spaces · 13 files to commit");
  await expect(me).toContainText("Remote: not pushed yet.");
  // Each deeper step sits further in.
  const xs = await line(page).locator("[data-link]").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).paddingLeft)));
  expect(xs[1]).toBeGreaterThan(xs[0]);
  expect(xs[2]).toBeGreaterThan(xs[1]);
  expect(xs[3]).toBeGreaterThan(xs[2]);
  // What follows from it, in words.
  await expect(page.locator('[data-note="below"]')).toHaveText("If feat/step-2 changes, feat/step-3 has to follow it.");
  await expect(page.locator('[data-note="above"]')).toHaveText("2 branches are built on top of this one. If you rewrite its commits, they have to follow.");
  await expect(page.locator('[data-note="shared"]')).toHaveText("⚠ Changes 5 files that proj-studio also changes: a.php, b.php, c.php, d.php and 1 more");
});

test("one dot per commit, so a longer line means more; past eight a number says the rest", async ({ page }) => {
  await open(page, wtUrl(W));
  const dots = (name: string) => link(page, name).locator("span.rounded-full.h-2.w-2");
  await expect(dots("feat/step-2")).toHaveCount(3);
  await expect(dots("feat/step-3")).toHaveCount(2);
  await expect(dots("origin/theirs")).toHaveCount(8);
  await expect(link(page, "origin/theirs")).toContainText("+4");
  await expect(dots("origin/main")).toHaveCount(8);
  await expect(link(page, "origin/main")).toContainText("+6");
});

test("a branch built straight on the base says so, with no notes that don't apply", async ({ page }) => {
  await open(page, wtUrl(STUDIO), { relate_load: plain("feat/studio") });
  await expect(page.locator("[data-summary]")).toHaveText("feat/studio is built straight on origin/main. Nothing new on origin/main since.");
  await expect(line(page).locator("[data-link]")).toHaveCount(2);
  await expect(page.locator("[data-note]")).toHaveCount(1);
  await expect(page.locator('[data-note="shared"]')).toContainText("proj-spaces");
  await expect(link(page, "feat/studio")).toContainText("1 commit of its own");
  await expect(link(page, "feat/studio")).toContainText("nothing to commit");
});

test("a branch with no folder, and its remote copy in words", async ({ page }) => {
  await open(page, brUrl("feat/step-2"), { relate_load: plain("feat/step-2", { own: 3, ahead: 3 }) });
  const me = link(page, "feat/step-2");
  await expect(me).toContainText("No folder: not checked out in any worktree.");
  await expect(me).toContainText("Remote: 1 commit to push · 2 commits to pull (origin/feat/step-2).");
  await expect(me).toContainText("#544");
  // No folder, so nothing to say about shared files.
  await expect(page.locator('[data-note="shared"]')).toHaveCount(0);
});

test("clicking a branch on the line goes to it: its worktree if it has one", async ({ page }) => {
  await open(page, wtUrl(W));
  await link(page, "feat/step-2").getByRole("button", { name: "feat/step-2" }).click();
  await expect(page).toHaveURL(/#\/branch\?.*name=feat%2Fstep-2/);
  await setReply(page, "relate_load", plain("feat/step-2", { above: [{ name: "feat/step-3", remote: false, commits: 2 }] }));
  await emit(page, "repo-changed", ROOT);
  await link(page, "feat/step-3").getByRole("button", { name: "feat/step-3" }).click();
  await expect(page).toHaveURL(new RegExp(`#/worktree\\?.*path=${encodeURIComponent(W)}`));
});

test("nothing picked, the base itself, and a worktree with no branch each say what they are", async ({ page }) => {
  await open(page, repoUrl());
  await expect(page.getByText("Pick a worktree or a branch in the sidebar to see what it's built on, and what's built on it.")).toBeVisible();
  expect(await callsTo(page, "relate_load")).toHaveLength(0);
  await page.goto(brUrl("origin/main"));
  await expect(page.getByText("origin/main is the base. Every other branch is compared to it.")).toBeVisible();
  await page.goto(wtUrl(ROOT));
  await expect(page.getByText("main is the base. Every other branch is compared to it.")).toBeVisible();
  expect(await callsTo(page, "relate_load")).toHaveLength(0);
});

test("a worktree with no branch is looked at by its commit", async ({ page }) => {
  const head = "d".repeat(40);
  const o = repo();
  o.detached = [{ worktree: wt(`${ROOT}-loose`, null, { head }), status: null, is_main_worktree: false }];
  await open(page, wtUrl(`${ROOT}-loose`), { overview_load: o, relate_load: plain(head) });
  expect((await callsTo(page, "relate_load")).at(-1)).toEqual({ root: ROOT, target: head, base: "origin/main" });
  await expect(page.locator("[data-summary]")).toContainText("commit ddddddd is built straight on origin/main.");
  await expect(link(page, head)).toContainText("No branch: this is a commit on its own.");
});

test("no shared history, a failed load with Retry, and it follows a changed base", async ({ page }) => {
  await open(page, wtUrl(W), { relate_load: { $error: "fatal: bad revision" } });
  await expect(page.getByText("Couldn't work this out")).toBeVisible();
  await setReply(page, "relate_load", plain("feat/step-3", { fork: null }));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("[data-summary]")).toHaveText("feat/step-3 shares no history with origin/main.");
  await expect(link(page, "origin/main")).toContainText("no shared commit");
  // The base changes: it asks again, against the new one.
  await setReply(page, "overview_load", { ...repo(), compare_base: "feat/step-2" });
  await setReply(page, "relate_load", { ...plain("feat/step-3"), base: "feat/step-2" });
  await emit(page, "repo-changed", ROOT);
  await expect.poll(async () => (await callsTo(page, "relate_load")).at(-1)).toEqual({ root: ROOT, target: "feat/step-3", base: "feat/step-2" });
  await expect(page.locator("[data-summary]")).toContainText("is built straight on feat/step-2.");
});

test("it never scrolls the page sideways, even with long names", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const long = `feat/${"a-very-long-branch-name-".repeat(6)}end`;
  await open(page, wtUrl(W), { relate_load: { ...stacked, below: [{ name: long, remote: false, commits: 40 }], above: Array.from({ length: 12 }, (_, i) => ({ name: `${long}-${i}`, remote: true, commits: i + 1 })) } });
  await expect(line(page).locator("[data-link]")).toHaveCount(15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
