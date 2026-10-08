import { expect, test } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { commitDiff, fileDiff, log, repoUrl, ROOT, typical } from "./fixtures";

test.describe("big diffs", () => {
  const id = "c".repeat(40);
  const url = `/#/commit?root=${encodeURIComponent(ROOT)}&id=${id}`;

  test("50,000 lines keep the page small and scroll to the last line", async ({ page }) => {
    await mockTauri(page, { ...typical(), commit_diff: commitDiff(["huge.ts", "small.ts"]), commit_file_diff: fileDiff("huge.ts", 50000) });
    await page.goto(url);
    await expect(page.getByText("line 1 of huge.ts", { exact: true })).toBeVisible();
    expect(await page.locator("*").count()).toBeLessThan(4000);
    const scroller = page.locator("div.overflow-auto.font-mono").last();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText("line 50000 of huge.ts", { exact: true })).toBeVisible();
    await expect(page.getByText("line 1 of huge.ts", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "split" }).click();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await expect(page.getByText(/line 2500\d of huge.ts/).first()).toBeVisible();
    expect(await page.locator("*").count()).toBeLessThan(4000);
  });

  test("switching files starts the new diff at the top", async ({ page }) => {
    await mockTauri(page, { ...typical(), commit_diff: commitDiff(["huge.ts", "small.ts"]), commit_file_diff: fileDiff("huge.ts", 5000) });
    await page.goto(url);
    const scroller = page.locator("div.overflow-auto.font-mono").last();
    await expect(page.getByText("line 1 of huge.ts", { exact: true })).toBeVisible();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await setReply(page, "commit_file_diff", fileDiff("small.ts", 10));
    await page.getByRole("button", { name: /small\.ts/ }).click();
    await expect(page.getByText("line 1 of small.ts", { exact: true })).toBeVisible();
  });

  test("a binary file and an empty diff say so", async ({ page }) => {
    await mockTauri(page, { ...typical(), commit_file_diff: { path: "logo.png", staged: false, binary: true, new_file: false, hunks: [], added: 0, deleted: 0 } });
    await page.goto(url);
    await expect(page.getByText("Binary file.")).toBeVisible();
  });
});

test.describe("repositories page", () => {
  test("no repos yet", async ({ page }) => {
    await mockTauri(page, { repos_list: { repos: [] } });
    await page.goto("/#/repos");
    await expect(page.getByText("No repositories yet")).toBeVisible();
  });

  test("one unreadable repo doesn't hide the others", async ({ page }) => {
    await mockTauri(page, {
      repos_list: { repos: [ROOT, "/gone/repo"] },
      overview_load: { $by: "root", cases: { "/gone/repo": { $error: "not a git repository: /gone/repo" } }, otherwise: typical().overview_load },
    });
    await page.goto("/#/repos");
    await expect(page.getByText("can't read")).toBeVisible();
    await expect(page.getByRole("row", { name: /proj/ })).toContainText("changed");
  });


  test("the repo list failing to load can be retried", async ({ page }) => {
    await mockTauri(page, { repos_list: { $error: "Permission denied (os error 13)" } });
    await page.goto("/#/repos");
    await expect(page.getByText("Couldn't read your repository list")).toBeVisible();
    await setReply(page, "repos_list", { repos: [] });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("No repositories yet")).toBeVisible();
  });

  test("remove asks first and only removes from the list", async ({ page }) => {
    await mockTauri(page, { repos_list: { repos: [ROOT] }, overview_load: typical().overview_load, repos_remove: { repos: [] } });
    await page.goto("/#/repos");
    await page.getByRole("button", { name: "Actions for proj" }).click();
    await page.getByRole("menuitem", { name: "Remove from Pando" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Nothing on disk changes");
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove from Pando" }).click();
    await expect(page.getByText("No repositories yet")).toBeVisible();
  });
});

test.describe("new branch dialog", () => {
  test("a failed create keeps the dialog and what you typed", async ({ page }) => {
    await mockTauri(page, { ...typical(), worktree_path_preview: `${ROOT}-feat-x`, worktree_add: { $error: "git worktree add failed: fatal: a branch named 'feat/x' already exists" } });
    await page.goto(repoUrl());
    await expect(page.getByText("WORKTREES", { exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+n");
    const dlg = page.getByRole("dialog");
    const name = dlg.getByRole("textbox").first();
    await name.fill("feat/x");
    await name.press("Enter");
    await expect(dlg.getByText("A branch named 'feat/x' already exists")).toBeVisible();
    await expect(name).toHaveValue("feat/x");
  });

  test("git's reason is shown, not its progress line", async ({ page }) => {
    // Real git prints "Preparing worktree…" first and the reason after it.
    await mockTauri(page, { ...typical(), worktree_path_preview: `${ROOT}-feat-x`, worktree_add: { $error: "git worktree add -b feat/x /p/proj-feat-x main failed: Preparing worktree (new branch 'feat/x')\nfatal: a branch named 'feat/x' already exists\nhint: try another name" } });
    await page.goto(repoUrl());
    await expect(page.getByText("WORKTREES", { exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+n");
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("textbox").first().fill("feat/x");
    await dlg.getByRole("textbox").first().press("Enter");
    await expect(dlg.getByText("A branch named 'feat/x' already exists")).toBeVisible();
    await expect(dlg.getByText("Preparing worktree", { exact: false })).toHaveCount(0);
  });

  test("unticking the worktree box creates only a branch", async ({ page }) => {
    await mockTauri(page, { ...typical(), worktree_path_preview: `${ROOT}-feat-x`, branch_create: null });
    await page.goto(repoUrl());
    await expect(page.getByText("WORKTREES", { exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+n");
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("textbox").first().fill("feat/x");
    await dlg.getByLabel("Add a worktree for it").uncheck();
    await dlg.getByRole("textbox").first().press("Enter");
    await expect.poll(() => callsTo(page, "branch_create")).toHaveLength(1);
    expect(await callsTo(page, "worktree_add")).toHaveLength(0);
    await expect(dlg).toBeHidden();
  });
});

test("commit menu: create branch here sends that commit", async ({ page }) => {
  const l = log(5);
  await mockTauri(page, { ...typical(), log_list: l, worktree_add: { worktree: {} } });
  await page.goto(repoUrl());
  await page.getByText("Commit number 3").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create branch here…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill("from-3");
  await page.getByRole("alertdialog").getByRole("button", { name: "Create branch" }).click();
  await expect.poll(async () => (await callsTo(page, "worktree_add"))[0]?.req).toMatchObject({ branch: "from-3", base: l.entries[3].id });
});
