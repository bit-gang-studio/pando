import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { overview, repoUrl, ROOT, row, typical, wt } from "./fixtures";

const sidebar = (page: Page) => page.locator("aside").first();
const A = `${ROOT}-feat-a`, B = `${ROOT}-feat-b`, C = `${ROOT}-feat-c`;
const repo = overview({ branches: [
  row("main", { worktree: wt(ROOT, "main") }),
  row("feat/a", { worktree: wt(A, "feat/a") }),
  row("feat/b", { worktree: wt(B, "feat/b") }),
  row("feat/c", { worktree: wt(C, "feat/c") }),
] });

async function open(page: Page, overlaps: unknown) {
  await mockTauri(page, { ...typical(), overview_load: repo, overlaps });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
}

test("⚠ on both worktrees, naming the other and the files", async ({ page }) => {
  await open(page, [{ a: A, b: B, files: ["src/login.ts", "README.md"] }]);
  const a = sidebar(page).locator("div.group", { hasText: "feat/a" }).first();
  const b = sidebar(page).locator("div.group", { hasText: "feat/b" }).first();
  await expect(a.getByText("⚠ 2 files overlap")).toBeVisible();
  await expect(a.getByText("⚠ 2 files overlap")).toHaveAttribute("title", "Also changed in feat/b: src/login.ts, README.md");
  await expect(b.getByText("⚠ 2 files overlap")).toHaveAttribute("title", "Also changed in feat/a: src/login.ts, README.md");
  await expect(sidebar(page).locator("div.group", { hasText: "feat/c" }).first().getByText(/⚠/)).toHaveCount(0);
});

test("one worktree overlapping two others lists both, counts files once", async ({ page }) => {
  await open(page, [{ a: A, b: B, files: ["x.ts"] }, { a: A, b: C, files: ["x.ts", "y.ts"] }]);
  const a = sidebar(page).locator("div.group", { hasText: "feat/a" }).first();
  await expect(a.getByText("⚠ 2 files overlap")).toHaveAttribute("title", "Also changed in feat/b: x.ts\nAlso changed in feat/c: x.ts, y.ts");
});

test("long file lists are cut short", async ({ page }) => {
  await open(page, [{ a: A, b: B, files: Array.from({ length: 9 }, (_, i) => `f${i}.ts`) }]);
  await expect(sidebar(page).getByText("⚠ 9 files overlap").first()).toHaveAttribute("title", /and 4 more$/);
});

test("no overlaps, or a failed check, shows nothing", async ({ page }) => {
  await open(page, []);
  await page.waitForTimeout(2000);
  await expect(sidebar(page).getByText(/⚠/)).toHaveCount(0);
  await open(page, { $error: "boom" });
  await page.waitForTimeout(2000);
  await expect(sidebar(page).getByText(/⚠/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("not checked until change counts are in", async ({ page }) => {
  const quick = { ...repo, status_loaded: false, branches: repo.branches.map((b) => ({ ...b, status: null })) };
  await mockTauri(page, { ...typical(), overview_load: quick, overlaps: [] });
  await page.goto(repoUrl());
  await expect(sidebar(page).getByText("WORKTREES", { exact: true })).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await callsTo(page, "overlaps")).toHaveLength(0);
});
