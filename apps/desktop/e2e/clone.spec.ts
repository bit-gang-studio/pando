import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri } from "./mock";
import { typical } from "./fixtures";
import type { RemoteRepo } from "../src/lib/api";

const rr = (name: string, extra: Partial<RemoteRepo> = {}): RemoteRepo => ({ name, description: "", private: false, url: `https://github.com/${name}`, updated_at: "", ...extra });
const REPOS = { repos: ["/Users/me/code/proj", "/Users/me/code/other", "/Users/me/elsewhere/x"] };

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), repos_list: REPOS, remote_repos: [rr("me/alpha", { private: true, description: "First" }), rr("team/beta")], ...extra });
  await page.goto("/#/repos");
  await page.getByRole("button", { name: "Clone repository" }).click();
  return page.getByRole("dialog");
}

test("defaults to where most repos live and shows the exact path", async ({ page }) => {
  const dlg = await open(page);
  await expect(dlg.getByRole("textbox").nth(1)).toHaveValue("/Users/me/code");
  await dlg.getByText("team/beta").click();
  await expect(dlg.getByText("Clones to /Users/me/code/beta")).toBeVisible();
});

test("search filters, picking clones there, and the location is remembered", async ({ page }) => {
  const dlg = await open(page, { repo_clone: { repos: [...REPOS.repos, "/tmp/pick/alpha"] } });
  await dlg.getByRole("textbox").first().fill("alp");
  await expect(dlg.getByText("team/beta")).toBeHidden();
  await expect(dlg.getByText("private")).toBeVisible();
  await dlg.getByText("me/alpha").click();
  await dlg.getByRole("textbox").nth(1).fill("/tmp/pick");
  await dlg.getByRole("button", { name: "Clone", exact: true }).click();
  await expect.poll(() => callsTo(page, "repo_clone")).toEqual([{ source: "me/alpha", parent: "/tmp/pick" }]);
  await expect(dlg).toBeHidden();
  await page.getByRole("button", { name: "Clone repository" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox").nth(1)).toHaveValue("/tmp/pick");
});

test("a pasted URL clones as typed, Enter works", async ({ page }) => {
  const dlg = await open(page, { repo_clone: REPOS });
  const search = dlg.getByRole("textbox").first();
  await search.fill("git@github.com:someone/their-repo.git");
  await expect(dlg.getByText("Clones to /Users/me/code/their-repo")).toBeVisible();
  await search.press("Enter");
  await expect.poll(async () => (await callsTo(page, "repo_clone"))[0]?.source).toBe("git@github.com:someone/their-repo.git");
});

test("without gh you can still paste a URL", async ({ page }) => {
  const dlg = await open(page, { remote_repos: null });
  await expect(dlg.getByText("Sign in to GitHub's gh tool")).toBeVisible();
  await dlg.getByRole("textbox").first().fill("https://github.com/o/r");
  await expect(dlg.getByRole("button", { name: "Clone", exact: true })).toBeEnabled();
});

test("nothing picked, nothing to clone", async ({ page }) => {
  const dlg = await open(page);
  await expect(dlg.getByRole("button", { name: "Clone", exact: true })).toBeDisabled();
  await dlg.getByRole("textbox").first().fill("just words");
  await expect(dlg.getByRole("button", { name: "Clone", exact: true })).toBeDisabled();
});

test("a repo already in Pando isn't cloned again", async ({ page }) => {
  const dlg = await open(page, { remote_repos: [rr("me/proj")] });
  await dlg.getByText("me/proj").click();
  await expect(dlg.getByText("/Users/me/code/proj is already in Pando")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Clone", exact: true })).toBeDisabled();
});

test("a failed clone keeps the dialog and says why", async ({ page }) => {
  const dlg = await open(page, { repo_clone: { $error: "/Users/me/code/beta already exists. Pick another location." } });
  await dlg.getByText("team/beta").click();
  await dlg.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(dlg.getByText("already exists. Pick another location.")).toBeVisible();
  await expect(dlg).toBeVisible();
});

test("the dialog keeps its shape while loading and with hundreds of repos", async ({ page }) => {
  const many = Array.from({ length: 300 }, (_, i) => rr(`org/repo-${i}`, { description: "d".repeat(200) }));
  await mockTauri(page, { ...typical(), repos_list: REPOS, remote_repos: { $delay: 800, value: many } });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/#/repos");
  await page.getByRole("button", { name: "Clone repository" }).click();
  const dlg = page.getByRole("dialog");
  const search = dlg.getByRole("textbox").first();
  const before = { search: (await search.boundingBox())!, dialog: (await dlg.boundingBox())! };
  await expect(dlg.getByText("org/repo-0", { exact: true })).toBeVisible();
  const after = { search: (await search.boundingBox())!, dialog: (await dlg.boundingBox())! };
  expect(after.search.height).toBe(before.search.height);
  expect(Math.round(after.search.height)).toBe(32);
  expect(after.dialog.height).toBe(before.dialog.height);
  expect(after.dialog.y + after.dialog.height).toBeLessThanOrEqual(720);
});
