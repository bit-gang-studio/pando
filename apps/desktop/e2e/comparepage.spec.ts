import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { commitDiff, fileDiff, NOW, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// Compare: the picked branch and another one since they split. The commits
// only one of them has, in one graph, with where they split underneath.

const W = `${ROOT}-spaces`;
const id = (c: string) => c.repeat(40);
const e = (i: string, parents: string[], summary: string, author: string, mins: number, refs: string[] = []) => ({ id: id(i), parents: parents.map(id), author, time: NOW - mins * 60, summary, refs, is_head: false });
// Mine: a3 - a2 - a1 - f.  Theirs: b2 - b1 - f.  Split at f, then e before it.
const both = [e("a", ["b"], "Space page layout", "Chris", 5, ["feat/step-3"]), e("1", ["2"], "Merge #547", "Lach", 10, ["origin/main"]), e("b", ["c"], "Floor table sorting", "Chris", 20), e("2", ["f"], "Restyle terms page", "Lach", 30), e("c", ["f"], "Link rooms", "Chris", 40)];
const shared = [e("f", ["e"], "Merge #541", "Sam", 300), e("e", [], "Start", "Sam", 600)];
const cmp = (base: string, head: string, ahead: number, behind: number, files: string[], fork: string | null = id("f")) => ({ base, head, ahead, behind, merge_base: fork, added: 5, deleted: 1, files: files.map((path) => ({ path, added: 3, deleted: 1 })) });
const repo = () => overview({ branches: [
  row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }),
  row("feat/step-3", { worktree: wt(W, "feat/step-3") }),
  row("feat/step-2", { upstream: "origin/feat/step-2" }),
], compare_base: "origin/main" });
const replies = {
  overview_load: repo(),
  log_among: { entries: both, truncated: false },
  log_fork: id("f"),
  log_list: { $by: "branch", cases: { [id("f")]: { entries: shared, truncated: false } }, otherwise: { entries: [], truncated: false } },
  compare: { $by: "head", cases: { "feat/step-3": cmp("origin/main", "feat/step-3", 3, 2, ["app/Rooms.php", "app/Importer.php", "views/manager.blade.php"]), "origin/main": cmp("feat/step-3", "origin/main", 2, 3, ["app/Importer.php", "views/manager.blade.php", "terms.md"]) }, otherwise: cmp("x", "y", 1, 1, ["other.php"]) },
  commit_diff: commitDiff(["app/Rooms.php"]),
  commit_file_diff: fileDiff("app/Rooms.php", 4),
  compare_file_diff: fileDiff("app/Rooms.php", 6),
};
const wtUrl = (p: string) => `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(p)}`;
const brUrl = (n: string) => `/#/branch?root=${encodeURIComponent(ROOT)}&name=${encodeURIComponent(n)}`;
const rows = (page: Page) => page.locator("[data-row]");
const summary = (page: Page) => page.locator("[data-summary]");
const withChips = (page: Page) => page.getByRole("group", { name: "Compared with" }).locator("[data-with]");

async function open(page: Page, url: string, extra: Record<string, unknown> = {}) {
  await page.addInitScript(() => { if (!localStorage.getItem("pando.view")) localStorage.setItem("pando.view", "compare"); });
  await mockTauri(page, { ...typical(), ...replies, ...extra });
  await page.goto(url);
  await expect(page.locator("aside").first().getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("Compare is the last choice in the toggle, and it's remembered", async ({ page }) => {
  await mockTauri(page, { ...typical(), ...replies });
  await page.goto(wtUrl(W));
  const toggle = page.getByRole("group", { name: "View" });
  await expect(toggle.getByRole("button")).toHaveText(["Commits", "Files", "Compare"]);
  await toggle.getByRole("button", { name: "Compare" }).click();
  await expect(summary(page)).toBeVisible();
  await page.reload();
  await expect(summary(page)).toBeVisible();
});

test("the picked branch against the base: one graph of what each has since they split, then where they split", async ({ page }) => {
  await open(page, wtUrl(W));
  // Both ways round: what mine changed, and what theirs did.
  expect([...new Set((await callsTo(page, "compare")).map((c) => `${c.base}>${c.head}`))].sort()).toEqual(["feat/step-3>origin/main", "origin/main>feat/step-3"]);
  await expect(page.getByText("proj-spaces · feat/step-3")).toBeVisible();
  await expect(withChips(page)).toHaveText(["origin/main×"]);
  await expect(summary(page)).toContainText("3 commits only on feat/step-3");
  await expect(summary(page)).toContainText("2 commits only on origin/main");
  await expect(summary(page).locator("[data-both]")).toHaveText("⚠ 2 files changed on both sides: app/Importer.php, views/manager.blade.php. A merge may conflict there.");
  // Newest first, both sides mixed in time order, then the shared history.
  expect((await callsTo(page, "log_fork")).at(-1)).toEqual({ root: ROOT, revs: ["origin/main", "feat/step-3"] });
  expect((await callsTo(page, "log_among")).at(-1)).toEqual({ root: ROOT, revs: ["origin/main", "feat/step-3"], not: id("f"), limit: 2000 });
  expect((await callsTo(page, "log_list")).map((c) => c.branch)).toContain(id("f"));
  await expect(rows(page)).toHaveCount(7);
  await expect(rows(page).nth(0)).toContainText("Space page layout");
  await expect(rows(page).nth(1)).toContainText("Merge #547");
  await expect(rows(page).nth(4)).toContainText("Link rooms");
  await expect(page.getByText("Where they split, and the history they share")).toBeVisible();
  await expect(rows(page).nth(5)).toContainText("Merge #541");
  // Each side's tip carries its name.
  await expect(rows(page).nth(0)).toContainText("feat/step-3");
  await expect(rows(page).nth(1)).toContainText("origin/main");
  await expect(page.getByText("feat/step-3 and origin/main since they split")).toBeVisible();
});

test("click a commit for its diff; shift-click for several as one; a side's count for everything it changed", async ({ page }) => {
  await open(page, wtUrl(W), { commit_range: { older: id("c"), newer: id("a"), base: id("f"), ancestor: true, commits: [id("a"), id("b"), id("c")], count: 3, added: 9, deleted: 2, files: [{ path: "app/Rooms.php", added: 9, deleted: 2 }] }, commit_range_file_diff: fileDiff("app/Rooms.php", 8) });
  // The newest commit shows first.
  await expect.poll(async () => (await callsTo(page, "commit_diff")).at(-1)).toEqual({ root: ROOT, id: id("a") });
  await rows(page).nth(2).click();
  await expect.poll(async () => (await callsTo(page, "commit_diff")).at(-1)).toEqual({ root: ROOT, id: id("b") });
  await rows(page).nth(4).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await callsTo(page, "commit_range")).length).toBeGreaterThan(0);
  // Everything one side changed since the split, as one diff: a dashed row on top for each side.
  const total = (k: string) => page.locator(`[data-total="${k}"]`);
  await expect(total("mine")).toHaveText("All changes on feat/step-3since they split · 3 commits");
  await expect(total("theirs")).toHaveText("All changes on origin/mainsince they split · 2 commits");
  await expect(total("mine").locator("span").first()).toHaveClass(/border-dashed/);
  await total("theirs").click();
  await expect.poll(async () => (await callsTo(page, "compare")).at(-1)).toEqual({ root: ROOT, base: "feat/step-3", head: "origin/main" });
  await expect(total("theirs")).toHaveAttribute("aria-pressed", "true");
  await total("mine").click();
  await expect(total("mine")).toHaveAttribute("aria-pressed", "true");
  await expect(total("theirs")).toHaveAttribute("aria-pressed", "false");
  // Picking a commit again leaves that.
  await rows(page).nth(0).click();
  await expect(total("mine")).toHaveAttribute("aria-pressed", "false");
});

test("add up to five to compare with; one is focused for the counts; each can be removed", async ({ page }) => {
  const o = repo();
  o.branches.push(row("feat/a"), row("feat/b"), row("feat/c"), row("feat/d"));
  await open(page, wtUrl(W), { overview_load: o });
  await page.getByRole("button", { name: "Compare with" }).click();
  const list = page.getByRole("dialog", { name: "Compare with" });
  // What's picked and what's already there can't be added again.
  await expect(list.getByRole("option", { name: /feat\/step-3/ })).toContainText("picked in the sidebar");
  await expect(list.getByRole("option", { name: /^origin\/main/ })).toContainText("already compared");
  await expect(list.getByRole("option", { name: /^main/ })).toContainText("in proj");
  await page.keyboard.type("step-2");
  await page.keyboard.press("Enter");
  await expect(withChips(page)).toHaveText(["origin/main×", "feat/step-2×"]);
  // All of them go into one graph, from where they all split.
  await expect.poll(async () => (await callsTo(page, "log_fork")).at(-1)).toEqual({ root: ROOT, revs: ["origin/main", "feat/step-2", "feat/step-3"] });
  await expect.poll(async () => (await callsTo(page, "log_among")).at(-1)).toEqual({ root: ROOT, revs: ["origin/main", "feat/step-2", "feat/step-3"], not: id("f"), limit: 2000 });
  await expect(page.getByText("feat/step-3 and 2 others since they all split")).toBeVisible();
  await expect(page.getByText("Where they all split, and the history they all share")).toBeVisible();
  // The one just added is the focus: the counts are against it, and say so.
  await expect(withChips(page).nth(1).getByRole("button").first()).toHaveAttribute("aria-pressed", "true");
  await expect(summary(page).locator("[data-against]")).toHaveText("Against feat/step-2:");
  expect((await callsTo(page, "compare")).some((c) => c.base === "feat/step-2" && c.head === "feat/step-3")).toBe(true);
  await withChips(page).nth(0).getByRole("button", { name: "origin/main", exact: true }).click();
  await expect(summary(page).locator("[data-against]")).toHaveText("Against origin/main:");
  await expect(page.locator('[data-total="theirs"]')).toContainText("All changes on origin/main");
  // Up to five; then there's no Add.
  for (const n of ["feat/a", "feat/b", "feat/c"]) {
    await page.getByRole("button", { name: "Compare with" }).click();
    await page.keyboard.type(n);
    await page.keyboard.press("Enter");
  }
  await expect(withChips(page)).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Compare with" })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop comparing with feat/b" }).click();
  await expect(withChips(page)).toHaveText(["origin/main×", "feat/step-2×", "feat/a×", "feat/c×"]);
  await expect(page.getByRole("button", { name: "Compare with" })).toHaveText("+ Add");
  // They stay as you pick something else in the sidebar.
  await page.locator("aside").first().locator("div.group", { hasText: "proj" }).first().click();
  await expect(withChips(page)).toHaveCount(4);
});

test("removing the last one asks what to compare with", async ({ page }) => {
  await open(page, wtUrl(W));
  await page.getByRole("button", { name: "Stop comparing with origin/main" }).click();
  await expect(page.getByText("Choose what to compare feat/step-3 with.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare with" })).toHaveText("choose a branch ▾");
});

test("Swap picks the other side and compares it with this one", async ({ page }) => {
  await open(page, wtUrl(W));
  await page.getByRole("button", { name: /Swap/ }).click();
  await expect(page).toHaveURL(/#\/branch\?.*name=origin%2Fmain/);
  await expect(withChips(page)).toHaveText(["feat/step-3×"]);
  // And back: a branch with a worktree goes to that worktree.
  await page.getByRole("button", { name: /Swap/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/worktree\\?.*path=${encodeURIComponent(W)}`));
  await expect(withChips(page)).toHaveText(["origin/main×"]);
});

test("the base itself asks what to compare it with; nothing picked asks you to pick", async ({ page }) => {
  await open(page, brUrl("origin/main"));
  await expect(page.getByText("Choose what to compare origin/main with.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare with" })).toHaveText("choose a branch ▾");
  expect(await callsTo(page, "compare")).toHaveLength(0);
  await page.goto(repoUrl());
  await expect(page.getByText("Pick a worktree or a branch in the sidebar, then choose what to compare it with.")).toBeVisible();
});

test("two branches at the same commit say so", async ({ page }) => {
  await open(page, wtUrl(W), { compare: cmp("origin/main", "feat/step-3", 0, 0, []) });
  await expect(summary(page)).toHaveText("These two are at the same commit. Nothing differs.");
});

test("two branches with no shared history say so", async ({ page }) => {
  await open(page, wtUrl(W), { compare: cmp("origin/main", "feat/step-3", 2, 5, ["a.php"], null) });
  await expect(summary(page)).toContainText("These two share no history.");
});

test("a side with nothing new gets no row of its own, and the page says why there's one line", async ({ page }) => {
  await open(page, wtUrl(W), { compare: { $by: "head", cases: { "feat/step-3": cmp("origin/main", "feat/step-3", 0, 4, []), "origin/main": cmp("feat/step-3", "origin/main", 4, 0, ["x.md"]) } } });
  await expect(summary(page)).toContainText("0 commits only on feat/step-3 · 4 commits only on origin/main");
  await expect(summary(page).locator("[data-still]")).toHaveText("feat/step-3 hasn't moved since they split, so it has no line of its own below. Its newest commit is where they split.");
  await expect(page.locator("[data-total]")).toHaveCount(1);
  await expect(page.locator('[data-total="theirs"]')).toBeVisible();
  await expect(summary(page).locator("[data-both]")).toHaveCount(0);
});

test("a failed comparison says why and Retry works; long names don't widen the page", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await open(page, wtUrl(W), { compare: { $error: "fatal: bad revision" } });
  await expect(page.getByText("Couldn't compare these")).toBeVisible();
  const many = Array.from({ length: 30 }, (_, i) => `app/Some/Very/Long/Path/To/A/File/Number${i}.php`);
  await setReply(page, "compare", cmp("origin/main", "feat/step-3", 3, 2, many));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(summary(page).locator("[data-both]")).toContainText("30 files changed on both sides");
  await expect(summary(page).locator("[data-both]")).toContainText("and 26 more");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
