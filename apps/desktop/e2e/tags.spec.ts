import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { NOW, repoUrl, ROOT, typical } from "./fixtures";

// The Tags section in the sidebar.

const tag = (name: string, i: number, over: object = {}) => ({ name, target: `${i}`.repeat(40), object: `${i}`.repeat(40), annotated: false, time: NOW - i * 86400, summary: `Release ${name}`, ...over });
const few = [tag("v1.2.0", 1, { annotated: true, object: "a".repeat(40) }), tag("v1.1.0", 2), tag("rel/ünï-🎉", 3)];
const many = Array.from({ length: 40 }, (_, i) => tag(`v0.${40 - i}.0`, (i % 8) + 1));
const sidebar = (page: Page) => page.locator("aside").first();
const section = (page: Page) => sidebar(page).getByRole("button", { name: /^▸?▾?\s*TAGS/ });

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), tag_list: few, tag_delete: null, tag_push: null, tag_restore: null, ...extra });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("no tags, or a list that failed to load: no section", async ({ page }) => {
  await open(page, { tag_list: [] });
  await expect(sidebar(page).getByText("STASHES")).toBeVisible();
  await expect(sidebar(page).getByText("TAGS")).toHaveCount(0);
});

test("a tag list that fails to load shows no section and no error", async ({ page }) => {
  await open(page, { tag_list: { $error: "boom" } });
  await expect(sidebar(page).getByText("STASHES")).toBeVisible();
  await expect(sidebar(page).getByText("TAGS")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("with tags it starts folded and counts them", async ({ page }) => {
  await open(page);
  await expect(section(page)).toContainText("3");
  await expect(sidebar(page).getByText("v1.2.0", { exact: true })).toHaveCount(0);
  await section(page).click();
  await expect(sidebar(page).getByText("v1.2.0", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText("rel/ünï-🎉", { exact: true })).toBeVisible();
  await expect(sidebar(page).locator("div.group", { hasText: "v1.1.0" })).toContainText("2222222 · 2d ago · Release v1.1.0");
});

test("clicking a tag shows its commit", async ({ page }) => {
  await open(page);
  await section(page).click();
  await sidebar(page).getByText("v1.1.0", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/commit\\?.*id=${"2".repeat(40)}`));
});

test("many tags: the newest eight, and a search for the rest", async ({ page }) => {
  await open(page, { tag_list: many });
  await section(page).click();
  await expect(sidebar(page).getByText("Showing the newest 8 of 40. Type to search.")).toBeVisible();
  await expect(sidebar(page).getByText("v0.40.0", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText("v0.32.0", { exact: true })).toHaveCount(0);
  await sidebar(page).getByLabel("Search tags").fill("V0.3");
  await expect(sidebar(page).getByText("v0.32.0", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText("v0.40.0", { exact: true })).toHaveCount(0);
  await sidebar(page).getByLabel("Search tags").fill("nothing like it");
  await expect(sidebar(page).getByText("No match.")).toBeVisible();
});

test("push, and delete with Undo that restores the exact tag", async ({ page }) => {
  await open(page);
  await section(page).click();
  const row = sidebar(page).locator("div.group", { hasText: "v1.2.0" });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Push tag" }).click();
  await expect.poll(() => callsTo(page, "tag_push")).toEqual([{ root: ROOT, name: "v1.2.0" }]);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag…" }).click();
  await page.keyboard.press("Escape");
  expect(await callsTo(page, "tag_delete")).toHaveLength(0);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete tag" }).click();
  await expect.poll(() => callsTo(page, "tag_delete")).toEqual([{ root: ROOT, name: "v1.2.0" }]);
  await page.getByRole("status").filter({ hasText: "Deleted tag v1.2.0" }).getByRole("button", { name: "Undo" }).click();
  // The tag's own object, not the commit: an annotated tag comes back whole.
  await expect.poll(() => callsTo(page, "tag_restore")).toEqual([{ root: ROOT, name: "v1.2.0", object: "a".repeat(40) }]);
});

test("a failed delete says why and offers no Undo", async ({ page }) => {
  await open(page, { tag_delete: { $error: "git tag -d v1.2.0 failed: error: tag 'v1.2.0' not found." } });
  await section(page).click();
  await sidebar(page).locator("div.group", { hasText: "v1.2.0" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete tag" }).click();
  await expect(page.getByRole("alert")).toContainText("Tag 'v1.2.0' not found.");
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});
