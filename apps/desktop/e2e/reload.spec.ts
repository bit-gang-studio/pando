import { expect, test, type Page } from "@playwright/test";
import { callsTo, emit, mockTauri, setReply } from "./mock";
import { log, overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// The commit list reloads when a branch, tag or HEAD moved, not on every file
// change, and never shows a commit twice.

const all = log(450);
const page1 = { entries: all.entries.slice(0, 200), truncated: true };
const page2 = { entries: all.entries.slice(200, 400), truncated: true };
const rows = (page: Page) => page.locator("[data-row]");
const ov = (refs_key: string | undefined, extra = {}) => ({ ...overview({ branches: [row("main", { worktree: wt(ROOT, "main") })] }), refs_key, ...extra });
const paged = { $by: "skip", cases: { 0: page1, 200: { $delay: 400, value: page2 } } };

async function open(page: Page, handlers: Record<string, unknown>) {
  await mockTauri(page, { ...typical(), ...handlers });
  await page.goto(repoUrl());
  await expect(rows(page).first()).toBeVisible();
}
const logCalls = async (page: Page) => (await callsTo(page, "log_list")).length;
const refresh = (page: Page) => emit(page, "repo-changed", ROOT);

test("clicking Load more twice loads one page, with no commit twice", async ({ page }) => {
  await open(page, { overview_load: ov("a"), log_list: paged });
  const more = page.getByRole("button", { name: "Load 200 more" });
  await more.dblclick();
  await expect(page.getByRole("button", { name: "Loading…" })).toBeDisabled();
  await expect(rows(page)).toHaveCount(400);
  const ids = await rows(page).evaluateAll((els) => els.map((e) => e.textContent));
  expect(new Set(ids).size).toBe(400);
  expect((await callsTo(page, "log_list")).filter((c) => c.skip === 200)).toHaveLength(1);
});

test("an answer that overlaps what's shown adds only the new commits", async ({ page }) => {
  // The history moved between pages: the next page repeats 50 commits.
  const overlap = { entries: all.entries.slice(150, 350), truncated: false };
  await open(page, { overview_load: ov("a"), log_list: { $by: "skip", cases: { 0: page1, 200: overlap } } });
  await page.getByRole("button", { name: "Load 200 more" }).click();
  await expect(rows(page)).toHaveCount(350);
});

test("file changes don't reload the commit list; a moved ref does", async ({ page }) => {
  await open(page, { overview_load: ov("a"), log_list: page1 });
  await page.waitForTimeout(300);
  const before = await logCalls(page);
  const loads = (await callsTo(page, "overview_load")).length;
  for (let i = 0; i < 3; i++) { await refresh(page); await page.waitForTimeout(150); }
  await expect.poll(async () => (await callsTo(page, "overview_load")).length).toBeGreaterThan(loads);
  expect(await logCalls(page)).toBe(before);
  expect((await callsTo(page, "stash_list")).length).toBeLessThanOrEqual(2);
  // A commit landed: the key changes and the list reloads once.
  await setReply(page, "overview_load", ov("b"));
  await refresh(page);
  await expect.poll(() => logCalls(page)).toBe(before + 1);
  await refresh(page);
  await page.waitForTimeout(300);
  expect(await logCalls(page)).toBe(before + 1);
});

test("a reload keeps the pages already loaded", async ({ page }) => {
  await open(page, { overview_load: ov("a"), log_list: { $by: "limit", cases: { 200: { $by: "skip", cases: { 0: page1, 200: page2 } }, 400: { entries: all.entries.slice(0, 400), truncated: true } } } });
  await page.getByRole("button", { name: "Load 200 more" }).click();
  await expect(rows(page)).toHaveCount(400);
  await setReply(page, "overview_load", ov("b"));
  await refresh(page);
  await expect.poll(async () => (await callsTo(page, "log_list")).at(-1)).toMatchObject({ skip: 0, limit: 400 });
  await expect(rows(page)).toHaveCount(400);
});

test("with no key from core, every refresh reloads as before", async ({ page }) => {
  await open(page, { overview_load: ov(undefined), log_list: page1 });
  await page.waitForTimeout(300);
  const before = await logCalls(page);
  await refresh(page);
  await expect.poll(() => logCalls(page)).toBeGreaterThan(before);
});

test("a slow answer to an old request never replaces a newer one", async ({ page }) => {
  // The first load is slow; a ref moves and the reload answers first.
  const stale = { entries: all.entries.slice(300, 320), truncated: false };
  const fresh = { entries: all.entries.slice(0, 20), truncated: false };
  await mockTauri(page, { ...typical(), overview_load: { $seq: [ov("a"), ov("a"), ov("b")] }, log_list: { $seq: [{ $delay: 1200, value: stale }, fresh] } });
  await page.goto(repoUrl());
  await page.waitForTimeout(300);
  await refresh(page);
  await expect(rows(page).first()).toContainText("Commit number 0");
  await page.waitForTimeout(1400);
  await expect(rows(page).first()).toContainText("Commit number 0");
  await expect(rows(page)).toHaveCount(20);
});

test("a very wide graph never pushes the commit text off screen", async ({ page }) => {
  // 30 branches side by side: 30 lanes.
  const wide = log(90);
  wide.entries.forEach((e, i) => { e.parents = i + 30 < 90 ? [wide.entries[i + 30].id] : []; });
  await open(page, { overview_load: ov("a"), log_list: wide });
  const svgs = page.locator("[data-row] svg");
  const widths = await svgs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(Math.max(...widths)).toBeLessThanOrEqual(12 * 14 + 6);
  expect(Math.max(...await svgs.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-lane")))))).toBeGreaterThan(20);
  for (const n of [0, 29, 60]) {
    const text = page.getByText(`Commit number ${n}`, { exact: true });
    await text.scrollIntoViewIfNeeded();
    const box = (await text.boundingBox())!;
    expect(box.x).toBeLessThan(700);
    await expect(text).toBeInViewport();
  }
  // A commit far out to the right still has its dot inside the graph.
  const far = page.locator('[data-row] svg[data-lane="25"]').first();
  const dot = await far.locator("circle").evaluate((c) => Number(c.getAttribute("cx")));
  expect(dot).toBeLessThan(12 * 14 + 6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the main worktree's line has no stray separator", async ({ page }) => {
  const main = row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main", up: [6, 0], ahead: 6 });
  await open(page, { overview_load: { ...overview({ branches: [main] }), refs_key: "a" }, log_list: page1 });
  const line = page.locator("aside").first().locator("div.group", { hasText: "main worktree" }).first();
  await expect(line).toContainText("main worktree · ↑6");
  await expect(line).not.toContainText("· ·");
});
