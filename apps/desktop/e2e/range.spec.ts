import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, fileDiff, log, repoUrl, ROOT, typical } from "./fixtures";

// Shift-click in the commit list: several commits, one diff.

const l = log(8);
const id = (i: number) => l.entries[i].id;
const range = (older: number, newer: number, over: object = {}) => ({
  older: id(older), newer: id(newer), base: "b".repeat(40), ancestor: true,
  commits: l.entries.slice(newer, older + 1).map((e) => e.id), count: older - newer + 1,
  added: 12, deleted: 3, files: [{ path: "src/sum.ts", added: 12, deleted: 3 }], ...over,
});
const row = (page: Page, i: number) => page.getByText(`Commit number ${i}`, { exact: true });
const picked = (page: Page) => page.locator('[data-picked="true"]');

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), log_list: l, commit_range: range(4, 1), commit_range_file_diff: fileDiff("src/sum.ts", 6), ...extra });
  await page.goto(repoUrl());
  await expect(row(page, 0)).toBeVisible();
}

test("shift-click picks the commits in between and shows them as one diff", async ({ page }) => {
  await open(page);
  await row(page, 1).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(4), newer: id(1) });
  expect(new Set((await callsTo(page, "commit_range")).map((c) => JSON.stringify(c))).size).toBe(1);
  await expect(page.getByText("Changes in 4 commits")).toBeVisible();
  await expect(page.getByText(`${id(4).slice(0, 7)} to ${id(1).slice(0, 7)}`)).toBeVisible();
  await expect(picked(page)).toHaveCount(4);
  await expect(page.getByText("src/sum.ts").first()).toBeVisible();
  // The file's diff is asked for with what core returned, not rebuilt here.
  await expect.poll(async () => (await callsTo(page, "commit_range_file_diff")).at(-1)).toEqual({ root: ROOT, base: "b".repeat(40), newer: id(1), path: "src/sum.ts" });
  expect(await callsTo(page, "commit_file_diff")).not.toContainEqual(expect.objectContaining({ path: "src/sum.ts" }));
});

test("shift-clicking upwards is the same range", async ({ page }) => {
  await open(page);
  await row(page, 4).click();
  await row(page, 1).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(4), newer: id(1) });
  expect(new Set((await callsTo(page, "commit_range")).map((c) => JSON.stringify(c))).size).toBe(1);
});

test("a second shift-click re-picks from the same starting commit", async ({ page }) => {
  await open(page);
  await row(page, 2).click();
  await row(page, 5).click({ modifiers: ["Shift"] });
  await row(page, 0).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(2), newer: id(0) });
});

test("a plain click or Escape goes back to one commit", async ({ page }) => {
  await open(page);
  await row(page, 1).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect(picked(page)).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(picked(page)).toHaveCount(0);
  await expect(page.getByText("Changes in 4 commits")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${id(1)}`));
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect(picked(page)).toHaveCount(4);
  await row(page, 6).click();
  await expect(picked(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${id(6)}`));
  // Clicking the starting commit while a range is picked keeps it selected.
  await row(page, 4).click({ modifiers: ["Shift"] });
  await row(page, 6).click();
  await expect(page).toHaveURL(new RegExp(`id=${id(6)}`));
});

test("shift-click with no commit selected just selects it", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Uncommitted changes")).toBeVisible();
  await row(page, 3).click({ modifiers: ["Shift"] });
  await expect(page).toHaveURL(new RegExp(`id=${id(3)}`));
  expect(await callsTo(page, "commit_range")).toHaveLength(0);
  // Shift-clicking the selected commit itself is not a range either.
  await row(page, 3).click({ modifiers: ["Shift"] });
  expect(await callsTo(page, "commit_range")).toHaveLength(0);
});

test("Shift+Down grows the pick, Shift+Up shrinks it back to one", async ({ page }) => {
  await open(page);
  await row(page, 2).click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(4), newer: id(2) });
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(3), newer: id(2) });
  await page.keyboard.press("Shift+ArrowUp");
  await expect(picked(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${id(2)}`));
  // And past the start, upwards.
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(2), newer: id(1) });
  // It stops at the ends of the list.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await callsTo(page, "commit_range")).at(-1)).toEqual({ root: ROOT, older: id(2), newer: id(0) });
});

test("two commits on different lines say so, and only those two light up", async ({ page }) => {
  await open(page, { commit_range: range(4, 1, { ancestor: false, commits: [id(1), id(4)], count: 2 }) });
  await row(page, 1).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect(page.getByText("Difference between 2 commits")).toBeVisible();
  await expect(page.getByText("on different lines of history")).toBeVisible();
  await expect(picked(page)).toHaveCount(2);
});

test("a failed range says why and Retry works", async ({ page }) => {
  await open(page, { commit_range: { $error: "git diff failed: fatal: bad object" } });
  await row(page, 1).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect(page.getByText("Couldn't load these commits")).toBeVisible();
  await setReply(page, "commit_range", range(4, 1));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Changes in 4 commits")).toBeVisible();
});

test("on a worktree page: back to the one commit, then back to the list", async ({ page }) => {
  const WT = `${ROOT}-feat-login`;
  await mockTauri(page, { ...typical(), log_list: l, commit_range: range(3, 1), commit_range_file_diff: fileDiff("src/sum.ts", 6), detail_load: detail(WT, "feat/login", []) });
  await page.goto(`/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
  await row(page, 1).click();
  await row(page, 3).click({ modifiers: ["Shift"] });
  await expect(page.getByText("Changes in 3 commits")).toBeVisible();
  await page.getByRole("button", { name: "‹ Back to one commit" }).click();
  await expect(page.getByText("Changes in 3 commits")).toHaveCount(0);
  await page.getByRole("button", { name: "‹ Back to list" }).click();
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
});
