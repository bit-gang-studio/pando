import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
import { BASE } from "./playwright.config";

const ROOT = `${BASE}/shop`;
const wtPath = (b: string) => `${BASE}/shop-${b.replace("/", "-")}`;
const git = (cwd: string, args: string) => execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
const gitOk = (cwd: string, args: string) => { try { git(cwd, args); return true; } catch { return false; } };
const exists = (p: string) => gitOk("/", `-C "${p}" rev-parse`);

/// The real frontend, talking to the bridge instead of the Tauri shell.
async function boot(page: Page, hash: string) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const listeners: Record<string, number[]> = {};
    let next = 1;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: (cb: unknown) => { const id = next++; w[`_${id}`] = cb; return id; },
      unregisterCallback: () => {},
      convertFileSrc: (s: string) => s,
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "plugin:event|listen") { (listeners[args.event as string] ??= []).push(args.handler as number); return args.handler; }
        if (cmd.startsWith("plugin:")) return null;
        const r = await fetch("http://127.0.0.1:4599/invoke", { method: "POST", body: JSON.stringify({ cmd, args }) });
        const j = await r.json();
        if ("err" in j) throw j.err;
        return j.ok;
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__emit = (event: string, payload: unknown) => { for (const id of listeners[event] ?? []) (w[`_${id}`] as (e: unknown) => void)?.({ event, id, payload }); };
  });
  await page.goto(`/${hash}`);
}
const repoPage = (page: Page) => boot(page, `#/repo?root=${encodeURIComponent(ROOT)}`);
const worktreePage = (page: Page, b: string) => boot(page, `#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(wtPath(b))}`);
const sidebar = (page: Page) => page.locator("aside").first();
const rowOf = (page: Page, text: string) => sidebar(page).locator("div.group", { hasText: text }).first();
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
const bridge = async (cmd: string) => (await (await fetch("http://127.0.0.1:4599/invoke", { method: "POST", body: JSON.stringify({ cmd, args: {} }) })).json()).ok;

test.beforeEach(() => {
  execSync(`bash setup.sh "${BASE}"`, { cwd: HERE, stdio: "ignore" });
});

test("the repo page shows real state: merged, ↑1, and after Fetch ↓1", async ({ page }) => {
  await repoPage(page);
  await expect(rowOf(page, "feat/done").getByText("merged")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "feat/dirty").getByText("merged")).toHaveCount(0);
  await expect(rowOf(page, "feat/login").getByTitle(/1 to push/)).toBeVisible();
  await sidebar(page).getByRole("button", { name: "Fetch" }).click();
  await expect(toast(page, "Fetched")).toBeVisible();
  await expect(rowOf(page, "feat/behind").getByTitle(/1 to pull/)).toBeVisible();
});

test("Pull ↓1 on the worktree page really pulls", async ({ page }) => {
  git(ROOT, "fetch -q origin");
  await worktreePage(page, "feat/behind");
  await page.getByRole("button", { name: "Pull ↓1" }).click();
  await expect(toast(page, "Pulled feat/behind")).toBeVisible();
  expect(git(wtPath("feat/behind"), "rev-parse HEAD")).toBe(git(ROOT, "rev-parse origin/feat/behind"));
  await expect(page.getByText("Up to date")).toBeVisible();
});

test("Push ↑1 on the worktree page really pushes", async ({ page }) => {
  await worktreePage(page, "feat/login");
  await page.getByRole("button", { name: "Push ↑1" }).click();
  await expect(toast(page, "Pushed feat/login")).toBeVisible();
  expect(git(`${BASE}/origin.git`, "rev-parse feat/login")).toBe(git(wtPath("feat/login"), "rev-parse HEAD"));
});

test("delete branch, then Undo, brings it back at the same commit", async ({ page }) => {
  const tip = git(ROOT, "rev-parse spike/old");
  await repoPage(page);
  await rowOf(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete branch…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete branch" }).click();
  await expect(toast(page, "Deleted spike/old")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/old")).toBe(false);
  await toast(page, "Deleted spike/old").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(ROOT, "rev-parse spike/old")).toBe(tip);
  await expect(rowOf(page, "spike/old")).toBeVisible();
});

test("rename, then Undo, renames it back", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "spike/old").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("alertdialog").getByRole("textbox").fill("spike/new");
  await page.getByRole("alertdialog").getByRole("button", { name: "Rename" }).click();
  await expect(toast(page, "Renamed to spike/new")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/new")).toBe(true);
  await toast(page, "Renamed to spike/new").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(gitOk(ROOT, "rev-parse --verify spike/old")).toBe(true);
  expect(gitOk(ROOT, "rev-parse --verify spike/new")).toBe(false);
});

test("discard, then Undo, puts the edit back", async ({ page }) => {
  const file = `${wtPath("feat/login")}/app.js`;
  const before = execSync(`cat "${file}"`, { encoding: "utf8" });
  await worktreePage(page, "feat/login");
  const r = page.locator("div.group", { hasText: "app.js" }).first();
  await r.hover();
  await r.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(toast(page, "Discarded changes in app.js")).toBeVisible();
  expect(execSync(`cat "${file}"`, { encoding: "utf8" })).not.toBe(before);
  await toast(page, "Discarded changes in app.js").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(execSync(`cat "${file}"`, { encoding: "utf8" })).toBe(before);
});

test("drop stash, then Undo, puts it back in the list without applying it", async ({ page }) => {
  const readme = execSync(`cat "${ROOT}/README.md"`, { encoding: "utf8" });
  await repoPage(page);
  await rowOf(page, "half done").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Drop…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drop stash" }).click();
  await expect(toast(page, "Dropped stash")).toBeVisible();
  expect(git(ROOT, "stash list")).toBe("");
  await toast(page, "Dropped stash").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(ROOT, "stash list")).toContain("half done");
  expect(execSync(`cat "${ROOT}/README.md"`, { encoding: "utf8" })).toBe(readme);
});

test("a merged worktree: Remove worktree, then Undo, puts the folder back", async ({ page }) => {
  await repoPage(page);
  const done = rowOf(page, "feat/done");
  await expect(done.getByText("merged")).toBeVisible({ timeout: 15_000 });
  await done.hover();
  await done.getByRole("button", { name: "Remove worktree" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect(toast(page, "Removed worktree feat/done")).toBeVisible();
  expect(exists(wtPath("feat/done"))).toBe(false);
  await toast(page, "Removed worktree feat/done").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(git(wtPath("feat/done"), "branch --show-current")).toBe("feat/done");
});

test("forced remove of a dirty worktree, then Undo, brings back the uncommitted work", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "feat/dirty").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("saved first, so you can undo");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove worktree" }).click();
  await expect(toast(page, "Removed worktree feat/dirty")).toBeVisible();
  expect(exists(wtPath("feat/dirty"))).toBe(false);
  await toast(page, "Removed worktree feat/dirty").getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Undone")).toBeVisible();
  expect(execSync(`cat "${wtPath("feat/dirty")}/wip.txt"`, { encoding: "utf8" })).toBe("precious\n");
  expect(execSync(`cat "${wtPath("feat/dirty")}/README.md"`, { encoding: "utf8" })).toContain("edited");
});

test("Open in Terminal asks for the worktree's folder (recorded, not opened)", async ({ page }) => {
  await repoPage(page);
  await rowOf(page, "feat/login").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in Terminal" }).click();
  await expect.poll(async () => JSON.stringify(await bridge("__opened"))).toContain(wtPath("feat/login"));
});

test("a branch opens on All changes with the real files", async ({ page }) => {
  await boot(page, `#/branch?root=${encodeURIComponent(ROOT)}&name=feat%2Flogin`);
  await expect(page.getByText("All changes on feat/login vs main")).toBeVisible();
  await expect(page.getByRole("button", { name: /login\.js/ })).toBeVisible();
});

test("New branch with Open in Terminal makes a real worktree and asks for that folder", async ({ page }) => {
  await repoPage(page);
  await expect(sidebar(page).getByText("WORKTREES")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("textbox").first().fill("feat/agent-task");
  await dlg.getByLabel("Open in Terminal when it's ready").check();
  await dlg.getByRole("textbox").first().press("Enter");
  await expect(dlg).toBeHidden();
  const p = `${BASE}/shop-feat-agent-task`;
  expect(git(p, "branch --show-current")).toBe("feat/agent-task");
  await expect.poll(async () => JSON.stringify(await bridge("__opened"))).toContain(p);
});
