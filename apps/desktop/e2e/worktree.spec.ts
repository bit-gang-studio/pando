import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, fileDiff, ROOT, typical } from "./fixtures";

const WT = `${ROOT}-feat-login`;
const url = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const file = (path: string, over: object = {}) => ({ path, orig_path: null, staged: null, unstaged: "M", untracked: false, conflicted: false, ...over });

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, { ...typical(), ...extra });
  await page.goto(url);
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
}

test("a failed commit keeps the message you typed", async ({ page }) => {
  const d = detail(WT, "feat/login", [file("a.ts", { staged: "M", unstaged: null })]);
  await open(page, { detail_load: d, commit_create: { $error: "git commit failed: error: gpg failed to sign the data" } });
  const box = page.getByLabel("Summary", { exact: true });
  await box.fill("Fix the login redirect");
  await page.getByRole("button", { name: /Commit/ }).click();
  await expect(page.getByText("Gpg failed to sign the data")).toBeVisible();
  await expect(box).toHaveValue("Fix the login redirect");
});

test("a good commit clears the message and sends it trimmed", async ({ page }) => {
  const d = detail(WT, "feat/login", [file("a.ts", { staged: "M", unstaged: null })]);
  await open(page, { detail_load: d, commit_create: null });
  const box = page.getByLabel("Summary", { exact: true });
  await box.fill("  Fix it  ");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(() => callsTo(page, "commit_create")).toEqual([{ worktree: WT, message: "Fix it", amend: false }]);
  await expect(box).toHaveValue("");
});

test("commit is off with nothing staged or no message", async ({ page }) => {
  await open(page, { detail_load: detail(WT, "feat/login", [file("a.ts")]) });
  const commit = page.getByRole("button", { name: /Commit/ });
  await expect(commit).toBeDisabled();
  await page.getByLabel("Summary", { exact: true }).fill("message but nothing staged");
  await expect(commit).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  expect(await callsTo(page, "commit_create")).toHaveLength(0);
});

test("discard asks first and Escape doesn't discard", async ({ page }) => {
  await open(page, { detail_load: detail(WT, "feat/login", [file("a.ts")]), discard_paths: null });
  await page.getByText("a.ts").first().hover();
  await page.getByRole("button", { name: /Discard/ }).first().click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeHidden();
  expect(await callsTo(page, "discard_paths")).toHaveLength(0);
});

test("a paused rebase can't continue until conflicts are resolved", async ({ page }) => {
  const d = detail(WT, "feat/login", [file("a.ts", { conflicted: true, unstaged: "U" })]);
  d.operation = { kind: "rebase", applied: 1, total: 3, head_label: "main", incoming_label: "feat/login", conflicted: ["a.ts"], counts: { "a.ts": 1 }, resolved: [], resolved_by_you: [] };
  await open(page, {
    detail_load: d,
    conflict_file: { path: "a.ts", ours: "ours\n", theirs: "theirs\n", base: "base\n", working: "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n", binary: false },
  }).catch(() => {});
  await expect(page.getByText("Rebasing feat/login onto main · commit 1 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue \(1 unresolved\)/ })).toBeDisabled();
});

test("merge is blocked by problems and says why", async ({ page }) => {
  await open(page, {
    merge_preflight: { branch: "feat/login", base: "main", base_local: "main", clean: false, ahead: 2, behind: 0, conflict_predicted: true, conflict_files: ["a.ts"], base_checked_out_in: ROOT, base_worktree_clean: true, has_upstream: false, last_summary: "x", uncommitted: 3, problems: ["Commit or stash the 3 changes in this worktree first."] },
  });
  await page.getByRole("button", { name: /^Merge/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Commit or stash the 3 changes")).toBeVisible();
  await expect(dlg.getByRole("button", { name: /^Merge/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  expect(await callsTo(page, "merge_run")).toHaveLength(0);
});

test("merge sends the chosen style and reports a failed step", async ({ page }) => {
  await open(page, {
    merge_preflight: { branch: "feat/login", base: "main", base_local: "main", clean: true, ahead: 2, behind: 1, conflict_predicted: false, conflict_files: [], base_checked_out_in: ROOT, base_worktree_clean: true, has_upstream: false, last_summary: "Login", uncommitted: 0, problems: [] },
    merge_run: { merged: false, backup_refs: [], steps: [{ name: "Backup refs", ok: true, output: "" }, { name: "Rebase onto main", ok: false, output: "Rebase hit conflicts and was undone." }] },
  });
  await page.getByRole("button", { name: /^Merge/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByText("Rebase and merge").click();
  await dlg.getByRole("button", { name: /^Merge/ }).click();
  const [call] = await callsTo(page, "merge_run");
  expect((call.plan as { strategy: string }).strategy).toBe("rebase");
  await expect(dlg.getByText("Merge stopped.")).toBeVisible();
  await expect(dlg.getByText("Rebase hit conflicts and was undone.")).toBeVisible();
  await expect(dlg.getByRole("button", { name: /^Merge/ })).toHaveCount(0);
});

test("a worktree whose folder is gone shows an error, not a blank page", async ({ page }) => {
  await mockTauri(page, { ...typical(), detail_load: { $error: `no worktree at ${WT}` } });
  await page.goto(url);
  await expect(page.getByText("Couldn't load this worktree")).toBeVisible();
  await setReply(page, "detail_load", detail(WT, "feat/login", [file("a.ts")]));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
});

test("staging a file sends that path", async ({ page }) => {
  await open(page, { detail_load: detail(WT, "feat/login", [file("dir/with space.ts")]), stage_paths: null, diff_file: fileDiff("dir/with space.ts", 3) });
  await page.getByRole("checkbox").first().click();
  await expect.poll(() => callsTo(page, "stage_paths")).toEqual([{ worktree: WT, paths: ["dir/with space.ts"] }]);
});

test("summary and description become one message, and the button names the branch", async ({ page }) => {
  const d = detail(WT, "feat/login", [file("a.ts", { staged: "M", unstaged: null })]);
  await open(page, { detail_load: d, commit_create: null });
  await expect(page.getByRole("button", { name: /Commit 1 file to feat\/login/ })).toBeVisible();
  await page.getByLabel("Summary", { exact: true }).fill("Fix the redirect");
  await page.getByLabel("Description").fill("  Login sent people to /home.\nNow it keeps ?next=.  ");
  await page.getByRole("button", { name: /Commit 1 file/ }).click();
  await expect.poll(async () => (await callsTo(page, "commit_create"))[0]?.message).toBe("Fix the redirect\n\nLogin sent people to /home.\nNow it keeps ?next=.");
  await expect(page.getByLabel("Description")).toHaveValue("");
});

test("a description without a summary can't commit", async ({ page }) => {
  const d = detail(WT, "feat/login", [file("a.ts", { staged: "M", unstaged: null })]);
  await open(page, { detail_load: d });
  await page.getByLabel("Description").fill("details only");
  await expect(page.getByRole("button", { name: /Commit 1 file/ })).toBeDisabled();
});
