import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, overview, remote, repoUrl, ROOT, row, typical, wt } from "./fixtures";

// Create pull request: offered for a pushed branch with no open pull request.

const WT = `${ROOT}-feat-login`;
const wtUrl = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const URL = "https://github.com/me/proj/pull/7";
const sidebar = (page: Page) => page.locator("aside").first();
const button = (page: Page) => page.getByRole("button", { name: "Create pull request…" });
const dlg = (page: Page) => page.getByRole("dialog");
const pr = (head: string) => ({ number: 3, title: "Existing", author: "sam", draft: false, head, base: "main", from_fork: false, url: URL, checks: "none", review: "", updated_at: "" });

function setup(over: { upstream?: string | null; prs?: unknown; up?: [number, number] } = {}) {
  const login = row("feat/login", { worktree: wt(WT, "feat/login"), upstream: over.upstream === undefined ? "origin/feat/login" : over.upstream, up: over.up ?? [0, 0] });
  const d = detail(WT, "feat/login", [{ path: "a.ts", orig_path: null, staged: "M", unstaged: null, untracked: false, conflicted: false }]);
  d.branch = login.branch;
  return {
    ...typical(),
    overview_load: overview({
      branches: [row("main", { worktree: wt(ROOT, "main"), upstream: "origin/main" }), login, row("spike/old", { upstream: "origin/spike/old" }), row("local/only")],
      remote_only: [remote("origin/release/1.x")],
      compare_base: "origin/main",
    }),
    detail_load: d,
    prs_list: over.prs === undefined ? { state: "ok", prs: [] } : over.prs,
    pr_draft: { $by: "base", cases: { main: { title: "Add the login page", body: "It keeps ?next=.", commits: 2 }, "release/1.x": { title: "For the release", body: "", commits: 5 } } },
    pr_create: URL,
    commit_create: null,
  };
}
async function open(page: Page, handlers: Record<string, unknown>, url = wtUrl) {
  await mockTauri(page, handlers);
  await page.goto(url);
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
}

test("the form starts from the commits, and creating sends exactly what's shown", async ({ page }) => {
  await open(page, setup());
  await button(page).click();
  await expect(dlg(page)).toContainText("feat/login into");
  await expect(dlg(page).getByLabel("Base")).toHaveValue("main");
  await expect(dlg(page)).toContainText("2 commits");
  await expect(dlg(page).getByLabel("Title")).toHaveValue("Add the login page");
  await expect(dlg(page).getByLabel("Description")).toHaveValue("It keeps ?next=.");
  // The base list: the usual base first, then other branches on origin, never itself.
  await expect(dlg(page).getByLabel("Base").locator("option")).toHaveText(["main", "spike/old", "release/1.x"]);
  const before = (await callsTo(page, "prs_list")).length;
  await dlg(page).getByRole("button", { name: /^Create pull request/ }).click();
  await expect.poll(() => callsTo(page, "pr_create")).toEqual([{ root: ROOT, req: { branch: "feat/login", base: "main", title: "Add the login page", body: "It keeps ?next=.", draft: false } }]);
  await expect(dlg(page)).toHaveCount(0);
  // The list of pull requests is asked for again, so the #N badge can show.
  await expect.poll(async () => (await callsTo(page, "prs_list")).length).toBeGreaterThan(before);
  const toast = page.getByRole("status").filter({ hasText: "Created a pull request for feat/login" });
  await toast.getByRole("button", { name: "Open on GitHub" }).click();
  await expect.poll(async () => JSON.stringify(await callsTo(page, "plugin:opener|open_url"))).toContain(URL);
});

test("a draft, with edited text, trimmed", async ({ page }) => {
  await open(page, setup());
  await button(page).click();
  await dlg(page).getByLabel("Title").fill("  My own title ");
  await dlg(page).getByLabel("Description").fill("\n- one\n- two\n\n");
  await dlg(page).getByRole("checkbox", { name: /Draft/ }).check();
  await dlg(page).getByRole("button", { name: /^Create draft/ }).click();
  await expect.poll(async () => (await callsTo(page, "pr_create"))[0]?.req).toEqual({ branch: "feat/login", base: "main", title: "My own title", body: "- one\n- two", draft: true });
});

test("changing the base refills the form, unless you've typed", async ({ page }) => {
  await open(page, setup());
  await button(page).click();
  await dlg(page).getByLabel("Base").selectOption("release/1.x");
  await expect(dlg(page).getByLabel("Title")).toHaveValue("For the release");
  await expect(dlg(page)).toContainText("5 commits");
  await dlg(page).getByLabel("Title").fill("Typed by hand");
  await dlg(page).getByLabel("Base").selectOption("main");
  await expect(dlg(page)).toContainText("2 commits");
  await expect(dlg(page).getByLabel("Title")).toHaveValue("Typed by hand");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await callsTo(page, "pr_create"))[0]?.req).toMatchObject({ base: "main", title: "Typed by hand" });
});

test("a refusal stays open with what you typed and claims nothing", async ({ page }) => {
  await open(page, { ...setup(), pr_create: { $error: "feat/login already has a pull request." } });
  await button(page).click();
  await dlg(page).getByLabel("Title").fill("Typed with care");
  await dlg(page).getByRole("button", { name: /^Create pull request/ }).click();
  await expect(dlg(page).getByText("Feat/login already has a pull request.")).toBeVisible();
  await expect(dlg(page).getByLabel("Title")).toHaveValue("Typed with care");
  await expect(page.getByRole("status").filter({ hasText: "Created a pull request" })).toHaveCount(0);
  // It can be tried again.
  await setReply(page, "pr_create", URL);
  await dlg(page).getByRole("button", { name: /^Create pull request/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Created a pull request" })).toBeVisible();
});

test("nothing to merge, or no title: Create is off", async ({ page }) => {
  const h = setup();
  await open(page, { ...h, pr_draft: { title: "Login", body: "", commits: 0 } });
  await button(page).click();
  await expect(dlg(page)).toContainText("main already has everything on feat/login");
  await expect(dlg(page).getByRole("button", { name: /^Create pull request/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.press("Escape");
  await setReply(page, "pr_draft", { title: "Login", body: "", commits: 1 });
  await button(page).click();
  await dlg(page).getByLabel("Title").fill("   ");
  await expect(dlg(page).getByRole("button", { name: /^Create pull request/ })).toBeDisabled();
  await dlg(page).getByLabel("Title").press("Enter");
  expect(await callsTo(page, "pr_create")).toHaveLength(0);
});

test("the keys belong to the dialog: ⌘↵ never commits behind it, Escape closes only it", async ({ page }) => {
  await open(page, setup());
  await page.getByLabel("Summary", { exact: true }).fill("Ready to commit");
  await button(page).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await callsTo(page, "pr_create")).length).toBe(1);
  expect(await callsTo(page, "commit_create")).toHaveLength(0);
  await button(page).click();
  await page.keyboard.press("Escape");
  await expect(dlg(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/worktree/);
});

for (const [why, over] of [
  ["gh isn't installed", { prs: { state: "no_gh" } }],
  ["gh is signed out", { prs: { state: "signed_out" } }],
  ["the branch already has a pull request", { prs: { state: "ok", prs: [pr("feat/login")] } }],
  ["the branch was never pushed", { upstream: null }],
] as const) {
  test(`not offered when ${why}`, async ({ page }) => {
    await open(page, setup(over as Parameters<typeof setup>[0]));
    await expect(page.getByText("COMMIT MESSAGE")).toBeVisible();
    await expect(button(page)).toHaveCount(0);
    await sidebar(page).locator("div.group", { hasText: "feat/login" }).first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open in new window" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Create pull request…" })).toHaveCount(0);
  });
}

test("the sidebar offers it per branch: pushed ones only, never the base", async ({ page }) => {
  await open(page, setup(), repoUrl());
  const menuOf = async (name: string) => { await sidebar(page).locator("div.group", { hasText: name }).first().click({ button: "right" }); };
  const item = page.getByRole("menuitem", { name: "Create pull request…" });
  await menuOf("main");
  await expect(page.getByRole("menuitem", { name: /^Push/ })).toBeVisible();
  await expect(item).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menuOf("local/only");
  await expect(page.getByRole("menuitem", { name: "Push to origin" })).toBeVisible();
  await expect(item).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menuOf("spike/old");
  await item.click();
  await expect(dlg(page)).toContainText("spike/old into");
  await expect(dlg(page).getByLabel("Base").locator("option")).toHaveText(["main", "feat/login", "release/1.x"]);
  await dlg(page).getByRole("button", { name: /^Create pull request/ }).click();
  await expect.poll(async () => (await callsTo(page, "pr_create"))[0]?.req).toMatchObject({ branch: "spike/old", base: "main" });
});
