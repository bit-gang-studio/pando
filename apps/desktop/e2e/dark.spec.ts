import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockTauri } from "./mock";
import { repoUrl, typical } from "./fixtures";

// Runs in the "dark" project (colorScheme: dark).

/// Relative luminance 0..1 of a CSS colour, via a canvas so any format (oklch, rgb) works.
const LUM = `(css) => {
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = css; c.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
  return { lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, alpha: a / 255 };
}`;
const lumOf = (page: Page, css: string) => page.evaluate(`(${LUM})(${JSON.stringify(css)})`) as Promise<{ lum: number; alpha: number }>;
const colorOf = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);

test("dark mode: dark surfaces, readable text, no white panels", async ({ page }) => {
  await mockTauri(page, { ...typical(), fetch_all: { $error: "git fetch failed: fatal: offline" } });
  await page.goto(repoUrl());
  await expect(page.getByText("WORKTREES")).toBeVisible();
  await page.getByRole("button", { name: "Fetch" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  expect((await lumOf(page, await page.evaluate(() => getComputedStyle(document.body).backgroundColor))).lum).toBeLessThan(0.15);

  const backgrounds: string[] = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > 5000; })
      .map((el) => getComputedStyle(el).backgroundColor));
  for (const bg of new Set(backgrounds)) {
    const { lum, alpha } = await lumOf(page, bg);
    if (alpha > 0.5) expect(lum, `large panel painted ${bg}`).toBeLessThan(0.5);
  }

  expect((await lumOf(page, await colorOf(page.getByText("feat/login").first()))).lum).toBeGreaterThan(0.7);
  expect((await lumOf(page, await colorOf(page.getByText("3 changed", { exact: false }).first()))).lum).toBeGreaterThan(0.35);
  expect((await lumOf(page, await colorOf(page.getByText("3 uncommitted")))).lum).toBeGreaterThan(0.5);
  expect((await lumOf(page, await colorOf(page.getByRole("alert")))).lum).toBeGreaterThan(0.7);
});
