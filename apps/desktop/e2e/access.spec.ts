import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { repoUrl, ROOT, typical } from "./fixtures";

/// Every command the app sent, in order.
const allCalls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { cmd: string }[] }).__calls.map((c) => c.cmd));
const GIT = ["overview_load", "log_list", "stash_list", "backups_list", "detail_load", "fetch_all", "watch_repo", "commit_diff"];

test("denied access: one clear screen and no git at all", async ({ page }) => {
  await mockTauri(page, { ...typical(), access_check: [ROOT] });
  await page.goto(repoUrl());
  await expect(page.getByText("Pando can't read your repositories")).toBeVisible();
  await expect(page.getByText(ROOT)).toBeVisible();
  await page.waitForTimeout(4000); // past the first auto-fetch
  const sent = await allCalls(page);
  expect(sent.filter((c) => GIT.includes(c))).toEqual([]);
  expect(sent.filter((c) => c === "access_check")).toHaveLength(1);

  await setReply(page, "access_check", []);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("aside").first().getByText("feat/login")).toBeVisible();
});

test("the access check runs before any git command", async ({ page }) => {
  await mockTauri(page, typical());
  await page.goto(repoUrl());
  await expect(page.locator("aside").first().getByText("feat/login")).toBeVisible();
  const sent = await allCalls(page);
  const first = sent.findIndex((c) => GIT.includes(c));
  expect(sent.indexOf("access_check")).toBeGreaterThanOrEqual(0);
  expect(sent.indexOf("access_check")).toBeLessThan(first);
});

test("the repo in the address is checked even if it isn't in the list", async ({ page }) => {
  await mockTauri(page, { ...typical(), repos_list: { repos: [] } });
  await page.goto(repoUrl());
  await expect.poll(async () => (await callsTo(page, "access_check"))[0]?.paths).toEqual([ROOT]);
});

test("the Repositories page is gated too", async ({ page }) => {
  await mockTauri(page, { ...typical(), access_check: [ROOT, "/Users/me/Desktop/other"] });
  await page.goto("/#/repos");
  await expect(page.getByText("/Users/me/Desktop/other")).toBeVisible();
  expect((await allCalls(page)).filter((c) => c === "overview_load")).toEqual([]);
});
