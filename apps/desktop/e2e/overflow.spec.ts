import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./mock";
import { commitDiff, detail, repoUrl, ROOT, typical } from "./fixtures";
import type { FileDiff } from "../src/lib/api";

const long = "| 1 | Rollout strategy | " + "a very long markdown table cell that keeps going ".repeat(12) + "|";
const wide: FileDiff = {
  path: "docs/zero-downtime-deploy-plan.md", staged: false, binary: false, new_file: true, added: 3, deleted: 0,
  hunks: [{ header: "@@ -0,0 +1,3 @@", old_start: 0, old_count: 0, new_start: 1, new_count: 3, lines: [
    { kind: "add", old_no: null, new_no: 1, text: "# Title", no_newline: false },
    { kind: "add", old_no: null, new_no: 2, text: long, no_newline: false },
    { kind: "add", old_no: null, new_no: 3, text: long + long, no_newline: false },
  ] }],
};

/// The window itself must never scroll sideways; only the diff may.
async function noPageOverflow(page: Page) {
  const over = await page.evaluate(() => {
    const out: string[] = [];
    const W = window.innerWidth;
    if (document.documentElement.scrollWidth > W) out.push(`document ${document.documentElement.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const r = el.getBoundingClientRect();
      const scrollsItself = /(auto|scroll|hidden)/.test(getComputedStyle(el).overflowX);
      const insideScroller = el.closest(".overflow-auto, .overflow-x-auto");
      if (r.right > W + 1 && !scrollsItself && !insideScroller) out.push(`${el.tagName}.${el.className.toString().slice(0, 60)} right=${Math.round(r.right)}`);
    }
    return out.slice(0, 5);
  });
  expect(over).toEqual([]);
}

test("a very wide line in a worktree diff doesn't widen the page", async ({ page }) => {
  const WT = `${ROOT}-feat-login`;
  const f = { path: wide.path, orig_path: null, staged: null, unstaged: null, untracked: true, conflicted: false };
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f]), diff_file: wide });
  await page.goto(`/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await expect(page.getByText("# Title")).toBeVisible();
  await noPageOverflow(page);
  for (const mode of ["split", "unified"]) {
    await page.getByRole("button", { name: mode }).click();
    await noPageOverflow(page);
  }
});

test("a very wide line in a commit diff doesn't widen the page", async ({ page }) => {
  await mockTauri(page, { ...typical(), commit_diff: commitDiff([wide.path]), commit_file_diff: wide });
  await page.goto(repoUrl());
  await page.getByText("Commit number 0").click();
  await expect(page.getByText("# Title")).toBeVisible();
  await noPageOverflow(page);
});

test("a very wide line in uncommitted changes doesn't widen the page", async ({ page }) => {
  await mockTauri(page, { ...typical(), diff_file: wide });
  await page.goto(repoUrl());
  await page.getByText("Uncommitted changes").first().click();
  await expect(page.getByText("# Title")).toBeVisible();
  await noPageOverflow(page);
});
