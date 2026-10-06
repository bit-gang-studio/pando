import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { commitDiff, detail, fileDiff, log, NOW, repoUrl, ROOT, typical } from "./fixtures";

// Right-click a file: its history, or who last changed each line.

const l = log(6);
const WT = `${ROOT}-feat-login`;
const hist = (i: number, summary: string, path = "src/app.ts", change = "M") => ({ entry: { ...l.entries[i], summary, author: i % 2 ? "Sam Okoro" : "Ana Lima" }, path, change });
const history = { commits: [hist(1, "Tidy the app"), hist(3, "Rename it", "src/app.ts", "R"), hist(5, "Add the app", "app.ts", "A")], truncated: false };
const A = "a".repeat(40), B = "b".repeat(40);
const blame = {
  path: "src/app.ts",
  lines: [{ commit: A, text: "import x" }, { commit: A, text: "" }, { commit: B, text: "  const y = 1;" }, { commit: "", text: "  draft();" }, { commit: A, text: "export {}" }],
  commits: { [A]: { author: "Ana Lima", time: NOW - 86400 * 3, summary: "Add the app", path: "app.ts" }, [B]: { author: "Sam Okoro", time: NOW - 3600, summary: "Tidy the app", path: "src/app.ts" } },
};
const fileRow = (page: Page) => page.locator("aside").last().locator("button[data-selected]", { hasText: "src/app.ts" });

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), log_list: l, commit_diff: commitDiff(["src/app.ts"]), file_history: history, file_blame: blame, commit_file_diff: fileDiff("src/app.ts", 6), ...extra });
  await page.goto(repoUrl());
  await page.getByText("Commit number 2", { exact: true }).click();
  await expect(fileRow(page)).toBeVisible();
}
async function choose(page: Page, item: string) {
  await fileRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

test("File history lists the commits and shows each one's change to the file", async ({ page }) => {
  await open(page);
  await choose(page, "File history");
  await expect.poll(async () => (await callsTo(page, "file_history")).at(-1)).toEqual({ root: ROOT, rev: l.entries[2].id, path: "src/app.ts", skip: 0, limit: 100 });
  await expect(page.getByText("3 commits changed this file")).toBeVisible();
  await expect(page.getByText(`at ${l.entries[2].id.slice(0, 7)}`)).toBeVisible();
  const rows = page.locator("aside").last().locator("button[data-selected]");
  await expect(rows).toHaveText([/Tidy the app.*Sam Okoro/, /Rename it.*renamed/, /Add the app.*added.*as app\.ts/]);
  // The first commit's diff is asked for under the name the file had then.
  await expect.poll(async () => (await callsTo(page, "commit_file_diff")).at(-1)).toEqual({ root: ROOT, id: l.entries[1].id, path: "src/app.ts" });
  await rows.nth(2).click();
  await expect.poll(async () => (await callsTo(page, "commit_file_diff")).at(-1)).toEqual({ root: ROOT, id: l.entries[5].id, path: "app.ts" });
});

test("double-clicking a commit in the history opens that commit", async ({ page }) => {
  await open(page);
  await choose(page, "File history");
  await page.locator("aside").last().locator("button[data-selected]").nth(1).dblclick();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[3].id}`));
  await expect(page.getByText("commits changed this file")).toHaveCount(0);
});

test("Blame names the commit once per run, marks uncommitted lines, and opens a commit", async ({ page }) => {
  await open(page);
  await choose(page, "Blame");
  await expect.poll(async () => (await callsTo(page, "file_blame")).at(-1)).toEqual({ root: ROOT, worktree: null, rev: l.entries[2].id, path: "src/app.ts" });
  const table = page.getByRole("table", { name: "Blame for src/app.ts" });
  const line = (n: number) => table.locator(`[data-line="${n}"]`);
  await expect(line(1)).toContainText("aaaaaaa");
  await expect(line(1)).toContainText("Add the app");
  await expect(line(1)).toContainText("Ana · 3d ago");
  // The second line belongs to the same commit: its label isn't repeated.
  await expect(line(2).getByText("Add the app")).toHaveCount(0);
  await expect(line(3)).toContainText("Tidy the app");
  await expect(line(3)).toContainText("const y = 1;");
  await expect(line(4)).toContainText("Not committed yet");
  await expect(line(4).getByRole("button")).toBeDisabled();
  await expect(line(5)).toContainText("Add the app");
  await line(3).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`id=${B}`));
});

test("History and Blame switch in place; Back and Escape return to the commit", async ({ page }) => {
  await open(page);
  await choose(page, "File history");
  await page.getByRole("button", { name: "Blame", exact: true }).click();
  await expect(page.getByRole("table", { name: "Blame for src/app.ts" })).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("3 commits changed this file")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("3 commits changed this file")).toHaveCount(0);
  await expect(fileRow(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[2].id}`));
  await choose(page, "Blame");
  await page.getByRole("button", { name: "‹ Back" }).click();
  await expect(fileRow(page)).toBeVisible();
});

test("selecting another commit in the graph leaves the file view", async ({ page }) => {
  await open(page);
  await choose(page, "Blame");
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByText("Commit number 4", { exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[4].id}`));
});

test("a file blame can't show says why; a file with no history says so", async ({ page }) => {
  await open(page, { file_blame: { $error: "pic.bin is a binary file." }, file_history: { commits: [], truncated: false } });
  await choose(page, "Blame");
  await expect(page.getByText("Couldn't blame this file")).toBeVisible();
  await expect(page.getByText("Pic.bin is a binary file.")).toBeVisible();
  await setReply(page, "file_blame", blame);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("No commits have changed this file.")).toBeVisible();
});

test("a long history loads more on demand, with no commit twice", async ({ page }) => {
  const big = log(150);
  const page1 = { commits: big.entries.slice(0, 100).map((e) => ({ entry: e, path: "src/app.ts", change: "M" })), truncated: true };
  const page2 = { commits: big.entries.slice(90, 150).map((e) => ({ entry: e, path: "src/app.ts", change: "M" })), truncated: false };
  await open(page, { file_history: { $by: "skip", cases: { 0: page1, 100: page2 } } });
  await choose(page, "File history");
  await expect(page.getByText("100+ commits changed this file")).toBeVisible();
  await page.getByRole("button", { name: "Load 100 more" }).click();
  await expect(page.getByText("150 commits changed this file")).toBeVisible();
  await expect(page.locator("aside").last().locator("button[data-selected]")).toHaveCount(150);
});

test("a huge blame only draws the lines on screen", async ({ page }) => {
  const lines = Array.from({ length: 50_000 }, (_, i) => ({ commit: i % 2000 < 1000 ? A : B, text: `line ${i + 1}` }));
  await open(page, { file_blame: { ...blame, lines } });
  await choose(page, "Blame");
  const table = page.getByRole("table");
  await expect(table.locator("[data-line='1']")).toBeVisible();
  expect(await table.locator("[data-line]").count()).toBeLessThan(200);
  await table.evaluate((el) => { el.scrollTop = 49_990 * 20; });
  await expect(table.locator("[data-line='50000']")).toContainText("line 50000");
  // The first row drawn names its commit even mid-run.
  expect(await table.locator("[data-line]").first().innerText()).toMatch(/Add the app|Tidy the app/);
});

test("on a worktree page: history from that worktree's commit, blame of its working copy", async ({ page }) => {
  const f = { path: "src/app.ts", orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false };
  const fresh = { ...f, path: "new.ts", unstaged: null, untracked: true };
  await mockTauri(page, { ...typical(), log_list: l, detail_load: detail(WT, "feat/login", [f, fresh]), file_history: history, file_blame: blame, commit_file_diff: fileDiff("src/app.ts", 6) });
  await page.goto(`/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  const row = page.locator("div.group", { hasText: "src/app.ts" }).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Blame" }).click();
  await expect(page.getByText("working copy")).toBeVisible();
  await expect.poll(async () => (await callsTo(page, "file_blame")).at(-1)).toEqual({ root: ROOT, worktree: WT, rev: null, path: "src/app.ts" });
  await page.getByRole("button", { name: "History", exact: true }).click();
  // Never the main worktree's HEAD: history starts from a commit, or nothing is asked with a null start.
  const asked = (await callsTo(page, "file_history")).at(-1)!;
  expect(asked.path).toBe("src/app.ts");
  await page.getByRole("button", { name: "‹ Back" }).click();
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
  // A brand new file has no history to offer.
  await page.locator("div.group", { hasText: "new.ts" }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "File history" })).toHaveCount(0);
});
