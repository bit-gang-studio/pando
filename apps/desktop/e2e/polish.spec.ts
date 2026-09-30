import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, NOW, repoUrl, ROOT, typical } from "./fixtures";
import type { FileDiff } from "../src/lib/api";

const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const f = (over: object = {}) => ({ path: "a.ts", orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false, ...over });
/// One hunk: context, del, add, add, context. Line indexes 0..4.
const mixed = (staged = false): FileDiff => ({
  path: "a.ts", staged, binary: false, new_file: false, added: 2, deleted: 1,
  hunks: [{ header: "@@ -1,3 +1,4 @@", old_start: 1, old_count: 3, new_start: 1, new_count: 4, lines: [
    { kind: "context", old_no: 1, new_no: 1, text: "keep", no_newline: false },
    { kind: "del", old_no: 2, new_no: null, text: "gone", no_newline: false },
    { kind: "add", old_no: null, new_no: 2, text: "new one", no_newline: false },
    { kind: "add", old_no: null, new_no: 3, text: "new two", no_newline: false },
    { kind: "context", old_no: 3, new_no: 4, text: "end", no_newline: false },
  ] }],
});
const gutter = (page: Page, text: string) => page.getByRole("checkbox", { name: new RegExp(`line: ${text}$`) });

// ---- Line staging ---------------------------------------------------------------

test("pick one line and stage just it", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f()]), diff_file: mixed(), apply_lines: null });
  await page.goto(wtUrl);
  await expect(page.getByText("Click line numbers to pick lines")).toBeVisible();
  await gutter(page, "new two").click();
  await expect(gutter(page, "new two")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Stage 1 line" }).click();
  const [call] = await callsTo(page, "apply_lines");
  expect(call).toMatchObject({ worktree: WT, path: "a.ts", lines: [3], reverse: false });
});

test("shift-click picks a range, skipping unchanged lines", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f()]), diff_file: mixed(), apply_lines: null });
  await page.goto(wtUrl);
  await gutter(page, "gone").click();
  await gutter(page, "new two").click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Stage 3 lines" }).click();
  expect((await callsTo(page, "apply_lines"))[0].lines).toEqual([1, 2, 3]);
});

test("unchanged lines can't be picked; Clear drops the picks", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f()]), diff_file: mixed() });
  await page.goto(wtUrl);
  await expect(page.getByRole("checkbox", { name: /line: keep$/ })).toHaveCount(0);
  await gutter(page, "new two").click();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: /Stage \\d+ line/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stage hunk" })).toBeVisible();
});

test("on the staged side it offers Unstage", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f({ staged: "M", unstaged: null })]), diff_file: mixed(true), apply_lines: null });
  await page.goto(wtUrl);
  await gutter(page, "new one").click();
  await page.getByRole("button", { name: "Unstage 1 line" }).click();
  expect((await callsTo(page, "apply_lines"))[0]).toMatchObject({ lines: [2], reverse: true });
});

test("no line picking in a commit's diff", async ({ page }) => {
  await mockTauri(page, { ...typical(), commit_file_diff: mixed() });
  await page.goto(repoUrl());
  await page.getByText("Commit number 0", { exact: true }).click();
  await expect(page.getByText("gone")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /line:/ })).toHaveCount(0);
});

test("no line picking on a new file", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f({ untracked: true, unstaged: null })]), diff_file: { ...mixed(), new_file: true } });
  await page.goto(wtUrl);
  await expect(page.getByText("new one")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /line:/ })).toHaveCount(0);
});

test("no line picking in split view", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f()]), diff_file: mixed() });
  await page.goto(wtUrl);
  await page.getByRole("button", { name: "split" }).click();
  await expect(page.getByRole("checkbox", { name: /line:/ })).toHaveCount(0);
});

test("a refused line stage explains itself", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: detail(WT, "feat/login", [f()]), diff_file: mixed(), apply_lines: { $error: "git apply --cached failed: error: patch does not apply" } });
  await page.goto(wtUrl);
  await gutter(page, "new two").click();
  await page.getByRole("button", { name: "Stage 1 line" }).click();
  await expect(page.getByText("Patch does not apply")).toBeVisible();
});

// ---- Fetched … ago --------------------------------------------------------------

test("the sidebar says when it last fetched", async ({ page }) => {
  await mockTauri(page, typical());
  await page.goto(repoUrl());
  await expect(page.getByText("Fetched 4m ago")).toBeVisible();
});

test("never fetched says so", async ({ page }) => {
  await mockTauri(page, { ...typical(), overview_load: { ...typical().overview_load, fetched_at: null } });
  await page.goto(repoUrl());
  await expect(page.getByText("Not fetched yet")).toBeVisible();
});

test("fetching updates it", async ({ page }) => {
  await mockTauri(page, { ...typical(), overview_load: { ...typical().overview_load, fetched_at: NOW - 7200 }, fetch_all: null });
  await page.goto(repoUrl());
  await expect(page.getByText("Fetched 2h ago")).toBeVisible();
  await setReply(page, "overview_load", { ...typical().overview_load, fetched_at: Math.floor(Date.now() / 1000) });
  await page.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(page.getByText("Fetched just now")).toBeVisible();
});

// ---- Appearance -----------------------------------------------------------------

test("the header button cycles Light → Dark → Auto and is remembered", async ({ page }) => {
  await mockTauri(page, typical());
  await page.goto(repoUrl());
  const btn = page.getByRole("button", { name: /^Appearance:/ });
  await expect(btn).toHaveAttribute("aria-label", "Appearance: Auto");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", "Appearance: Light");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", "Appearance: Dark");
  const sets = (await callsTo(page, "plugin:window|set_theme")).map((a) => a.value);
  expect(sets.slice(-2)).toEqual(["light", "dark"]);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Appearance:/ })).toHaveAttribute("aria-label", "Appearance: Dark");
  await expect.poll(async () => (await callsTo(page, "plugin:window|set_theme")).at(-1)?.value).toBe("dark");
  await page.getByRole("button", { name: /^Appearance:/ }).click();
  await expect.poll(async () => (await callsTo(page, "plugin:window|set_theme")).at(-1)?.value).toBe(null);
});
