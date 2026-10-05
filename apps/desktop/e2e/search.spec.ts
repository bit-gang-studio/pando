import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, log, repoUrl, ROOT, typical } from "./fixtures";

// The search box above the commit list: message, author or commit id.

const l = log(8);
const hit = (i: number, summary: string) => ({ ...l.entries[i], summary, refs: [] });
const results = { entries: [hit(5, "Fix the login redirect"), hit(2, "Login page polish")], truncated: false };
const box = (page: Page) => page.getByLabel("Search commits");
const row = (page: Page, text: string) => page.locator("[data-row]").filter({ has: page.getByText(text, { exact: true }) });

async function open(page: Page, extra: Record<string, unknown> = {}, url = repoUrl()) {
  await mockTauri(page, { ...typical(), log_list: l, log_search: results, ...extra });
  await page.goto(url);
  await expect(row(page, "Commit number 0")).toBeVisible();
}

test("typing searches the current scope and shows plain results", async ({ page }) => {
  await open(page);
  await box(page).fill("  login ");
  await expect(row(page, "Fix the login redirect")).toBeVisible();
  await expect(page.getByText("2 commits match “login”")).toBeVisible();
  await expect(row(page, "Commit number 0")).toHaveCount(0);
  await expect(page.getByText("Uncommitted changes")).toHaveCount(0);
  // No graph is drawn for results.
  await expect(page.locator("[data-row] svg")).toHaveCount(0);
  expect((await callsTo(page, "log_search")).at(-1)).toEqual({ root: ROOT, branch: null, query: "login", skip: 0, limit: 200 });
});

test("it waits for a pause, so fast typing asks once", async ({ page }) => {
  await open(page);
  await box(page).pressSequentially("login", { delay: 20 });
  await expect(row(page, "Login page polish")).toBeVisible();
  const asked = [...new Set((await callsTo(page, "log_search")).map((c) => c.query))];
  expect(asked).toEqual(["login"]);
});

test("clicking a result opens that commit; clicking it again keeps it", async ({ page }) => {
  await open(page);
  await box(page).fill("login");
  await row(page, "Login page polish").click();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[2].id}`));
  await row(page, "Login page polish").click();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[2].id}`));
  // Still showing results, with the box's text intact.
  await expect(box(page)).toHaveValue("login");
  await expect(row(page, "Fix the login redirect")).toBeVisible();
});

test("Escape clears the search and brings the graph back, without leaving the page", async ({ page }) => {
  await open(page);
  await row(page, "Commit number 3").click();
  await box(page).fill("login");
  await expect(row(page, "Login page polish")).toBeVisible();
  await box(page).press("Escape");
  await expect(box(page)).toHaveValue("");
  await expect(row(page, "Commit number 0")).toBeVisible();
  await expect(page.locator("[data-row] svg").first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[3].id}`));
  // The Clear link does the same.
  await box(page).fill("login");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(row(page, "Commit number 0")).toBeVisible();
});

test("⌘F focuses the box, but not while a dialog is open", async ({ page }) => {
  await open(page, { worktree_path_preview: `${ROOT}-x` });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(box(page)).toBeFocused();
  await box(page).blur();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(box(page)).not.toBeFocused();
});

test("no matches says so, naming the branch", async ({ page }) => {
  const WT = `${ROOT}-feat-login`;
  await open(page, { log_search: { entries: [], truncated: false }, detail_load: detail(WT, "feat/login", []) }, `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`);
  await box(page).fill("zzz");
  await expect(page.getByText("No commits match “zzz” on feat/login.")).toBeVisible();
  expect((await callsTo(page, "log_search")).at(-1)).toMatchObject({ branch: "feat/login", query: "zzz" });
  await expect(page.locator("[data-row]")).toHaveCount(0);
});

test("a failed search says why and Retry works", async ({ page }) => {
  await open(page, { log_search: { $error: "git log failed: fatal: bad revision" } });
  await box(page).fill("login");
  await expect(page.getByText("Bad revision")).toBeVisible();
  await setReply(page, "log_search", results);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(row(page, "Login page polish")).toBeVisible();
});

test("more results load on demand, after the ones shown", async ({ page }) => {
  await open(page, { log_search: { $seq: [{ entries: [hit(1, "needle one")], truncated: true }, { entries: [hit(4, "needle two")], truncated: false }] } });
  await box(page).fill("needle");
  await expect(page.getByText("1+ commits match “needle”")).toBeVisible();
  await page.getByRole("button", { name: "Load 200 more" }).click();
  await expect(row(page, "needle two")).toBeVisible();
  await expect(row(page, "needle one")).toBeVisible();
  expect((await callsTo(page, "log_search")).at(-1)).toMatchObject({ query: "needle", skip: 1 });
  await expect(page.getByRole("button", { name: "Load 200 more" })).toHaveCount(0);
});

test("results can't be picked as a range, and arrows move through them", async ({ page }) => {
  await open(page);
  await box(page).fill("login");
  await row(page, "Fix the login redirect").click();
  await row(page, "Login page polish").click({ modifiers: ["Shift"] });
  expect(await callsTo(page, "commit_range")).toHaveLength(0);
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[2].id}`));
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(new RegExp(`id=${l.entries[5].id}`));
});

test("odd text is sent as typed, and blank text doesn't search", async ({ page }) => {
  await open(page);
  await box(page).fill("   ");
  await page.waitForTimeout(400);
  expect(await callsTo(page, "log_search")).toHaveLength(0);
  await expect(row(page, "Commit number 0")).toBeVisible();
  await box(page).fill("--all \"x\" .* ünï");
  await expect.poll(async () => (await callsTo(page, "log_search")).at(-1)?.query).toBe("--all \"x\" .* ünï");
});
