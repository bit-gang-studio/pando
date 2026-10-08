import { expect, test, type Page } from "@playwright/test";
import { emit, mockTauri, setReply } from "./mock";
import { overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// The sidebar's sections can be dragged into any order. The order is remembered.

const sidebar = (page: Page) => page.locator("aside").first();
const order = (page: Page) => sidebar(page).locator("[data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
const grip = (page: Page, name: string) => sidebar(page).getByRole("button", { name: `Move ${name}`, exact: true });
const pr = { number: 9, title: "A change", url: "https://x/9", head: "feat/x", base: "main", author: "Sam", draft: false, checks: "passing", review: "", from_fork: false };
const tag = { name: "v1", target: "a".repeat(40), time: 1, summary: "one", annotated: false };

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), overview_load: overview({ branches: [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }), row("spike/old")], compare_base: "origin/main" }), prs_list: { state: "ok", prs: [pr] }, tag_list: [tag], ...extra });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
}
async function dragTo(page: Page, name: string, onto: string, where: "top" | "bottom") {
  const from = (await grip(page, name).boundingBox())!;
  const to = (await sidebar(page).locator(`[data-section="${onto}"]`).boundingBox())!;
  await page.mouse.move(from.x + 4, from.y + 6);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, where === "top" ? to.y + 3 : to.y + to.height - 3, { steps: 6 });
  await page.mouse.up();
}

test("the sections start in the agreed order", async ({ page }) => {
  await open(page);
  expect(await order(page)).toEqual(["base", "worktrees", "branches", "all", "prs", "remote", "tags", "stashes"]);
});

test("drag a section by its handle to move it; the order is remembered", async ({ page }) => {
  await open(page);
  await dragTo(page, "Pull requests", "base", "top");
  expect(await order(page)).toEqual(["prs", "base", "worktrees", "branches", "all", "remote", "tags", "stashes"]);
  await dragTo(page, "Base", "tags", "bottom");
  expect(await order(page)).toEqual(["prs", "worktrees", "branches", "all", "remote", "tags", "base", "stashes"]);
  await page.reload();
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
  expect(await order(page)).toEqual(["prs", "worktrees", "branches", "all", "remote", "tags", "base", "stashes"]);
});

test("while dragging, a line shows where it will land; letting go outside the sidebar moves nothing", async ({ page }) => {
  await open(page);
  const from = (await grip(page, "Tags").boundingBox())!;
  const to = (await sidebar(page).locator('[data-section="worktrees"]').boundingBox())!;
  await page.mouse.move(from.x + 4, from.y + 6);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 3, { steps: 5 });
  await expect(sidebar(page).locator('[data-section="worktrees"]')).toHaveClass(/shadow-\[inset_0_2px/);
  await expect(sidebar(page).locator('[data-section="tags"]')).toHaveClass(/opacity-50/);
  await page.mouse.move(900, 400, { steps: 5 });
  await page.mouse.up();
  expect(await order(page)).toEqual(["base", "worktrees", "branches", "all", "prs", "remote", "tags", "stashes"]);
  await expect(sidebar(page).locator('[data-section="tags"]')).not.toHaveClass(/opacity-50/);
});

test("the handle works from the keyboard, and doesn't fold the section or open anything", async ({ page }) => {
  await open(page);
  await grip(page, "Worktrees").focus();
  await page.keyboard.press("ArrowDown");
  expect((await order(page)).slice(0, 3)).toEqual(["base", "branches", "worktrees"]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect((await order(page)).slice(0, 3)).toEqual(["worktrees", "base", "branches"]);
  // Already first: stays put.
  await page.keyboard.press("ArrowUp");
  expect((await order(page))[0]).toBe("worktrees");
  await grip(page, "Worktrees").click();
  await expect(sidebar(page).locator("div.group", { hasText: "proj" }).first()).toBeVisible();
  await grip(page, "All branches").click();
  await expect(page).toHaveURL(/#\/repo/);
});

test("a section that isn't showing keeps its place, and a broken saved order falls back to the default", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pando.sidebar.order", JSON.stringify(["tags", "nonsense", "tags", "base"])));
  await open(page, { tag_list: [] });
  // No tags yet: nothing shows for it. The rest follow in the default order.
  expect(await order(page)).toEqual(["base", "worktrees", "branches", "all", "prs", "remote", "stashes"]);
  await page.evaluate(() => localStorage.setItem("pando.sidebar.order", "{not json"));
  await page.reload();
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
  expect((await order(page))[0]).toBe("base");
});

// ---- Rows inside Worktrees and Branches -------------------------------------

const many = () => overview({ branches: [row("main", { worktree: wt(ROOT, "main") }), row("feat/a", { worktree: wt(`${ROOT}-a`, "feat/a") }), row("feat/b", { worktree: wt(`${ROOT}-b`, "feat/b") }), row("spike/one"), row("spike/two"), row("spike/three")] });
const names = (page: Page, section: string) => sidebar(page).locator(`[data-section="${section}"] div.group`).evaluateAll((els) => els.map((e) => e.querySelector(".font-mono")!.textContent));
async function dragRow(page: Page, name: string, ontoText: string, where: "top" | "bottom") {
  const target = sidebar(page).locator("div.group", { hasText: ontoText }).first();
  await sidebar(page).locator("div.group", { hasText: name }).first().hover();
  const from = (await grip(page, name).boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 4, from.y + 6);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, where === "top" ? to.y + 3 : to.y + to.height - 3, { steps: 6 });
  await page.mouse.up();
}

test("rows in Worktrees and Branches can be dragged into your own order, remembered for this repository", async ({ page }) => {
  await open(page, { overview_load: many() });
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-a", "proj-b"]);
  await dragRow(page, "proj-b", "proj-a", "top");
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-b", "proj-a"]);
  await dragRow(page, "spike/one", "spike/two", "bottom");
  const moved = await names(page, "branches");
  expect(moved.indexOf("spike/one")).toBeGreaterThan(moved.indexOf("spike/two"));
  // Dragging a row didn't open it.
  await expect(page).toHaveURL(/#\/repo/);
  await page.reload();
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-b", "proj-a"]);
  expect(await names(page, "branches")).toEqual(moved);
});

test("a row can't be dragged into another section, and a new worktree goes after the ones you've placed", async ({ page }) => {
  await open(page, { overview_load: many() });
  await dragRow(page, "proj-b", "proj-a", "top");
  await dragRow(page, "proj-a", "spike/one", "top");
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-b", "proj-a"]);
  const o = many();
  o.branches.splice(1, 0, row("feat/new", { worktree: wt(`${ROOT}-new`, "feat/new") }));
  await setReply(page, "overview_load", o);
  await emit(page, "repo-changed", ROOT);
  await expect(sidebar(page).locator("div.group", { hasText: "proj-new" }).first()).toBeVisible();
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-b", "proj-a", "proj-new"]);
});

test("a row's handle works from the keyboard", async ({ page }) => {
  await open(page, { overview_load: many() });
  await grip(page, "proj-a").focus();
  await page.keyboard.press("ArrowDown");
  expect(await names(page, "worktrees")).toEqual(["proj", "proj-b", "proj-a"]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await names(page, "worktrees")).toEqual(["proj-a", "proj", "proj-b"]);
});
