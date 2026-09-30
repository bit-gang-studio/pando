import { expect, test, type Page } from "@playwright/test";
import { callsTo, mockTauri, setReply } from "./mock";
import { detail, ROOT, typical } from "./fixtures";
import type { ConflictFile, Detail, Operation } from "../src/lib/api";

const WT = `${ROOT}-pr486`;
const url = `/#/worktree?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(WT)}`;
const conflicted = (path: string) => ({ path, orig_path: null, staged: null, unstaged: "U", untracked: false, conflicted: true });
const auto = Array.from({ length: 238 }, (_, i) => `src/auto/file${i}.ts`);

function merging(op: Partial<Operation> = {}): Detail {
  const d = detail(WT, "pr486", [conflicted("app.ts"), conflicted("gone.ts"), conflicted("logo.png")]);
  d.operation = {
    kind: "merge", applied: 0, total: 0, head_label: "pr486", incoming_label: "main",
    conflicted: ["app.ts", "gone.ts", "logo.png"], counts: { "app.ts": 3, "gone.ts": 0, "logo.png": 0 },
    resolved: [...auto, "done.ts"], resolved_by_you: ["done.ts"], ...op,
  };
  return d;
}

const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");
const appTs: ConflictFile = {
  path: "app.ts", ours: "", theirs: "", base: null, working: "(markers)", binary: false, deleted: null,
  parts: [
    { kind: "text", text: text(20) },
    { kind: "conflict", ours: "const a = 1;\nshared\n", base: "const a = 0;\nshared\n", theirs: "const a = 2;\nshared\n" },
    { kind: "text", text: "between\n" },
    { kind: "conflict", ours: "ours two\n", base: null, theirs: "theirs two\n" },
    { kind: "text", text: text(12) },
    { kind: "conflict", ours: "", base: "old\n", theirs: "added by main\n" },
    { kind: "text", text: "end\n" },
  ],
};
const byPath = (files: Record<string, unknown>) => ({ $by: "path", cases: files });

async function open(page: Page, extra: Record<string, unknown> = {}) {
  await mockTauri(page, {
    ...typical(),
    detail_load: merging(),
    conflict_file: byPath({
      "app.ts": appTs,
      "gone.ts": { ...appTs, path: "gone.ts", parts: [{ kind: "text", text: "changed on pr486\n" }], working: "changed on pr486\n", deleted: "theirs" },
      "logo.png": { ...appTs, path: "logo.png", parts: [], binary: true },
      "done.ts": { ...appTs, path: "done.ts", parts: [{ kind: "text", text: "resolved text\n" }], working: "resolved text\n" },
    }),
    conflict_choose: null,
    ...extra,
  });
  await page.goto(url);
  await expect(page.getByRole("group", { name: "Conflict 1 of 3" })).toBeVisible();
}
const files = (page: Page) => page.locator("aside").last();
const card = (page: Page, n: number) => page.getByRole("group", { name: `Conflict ${n} of 3` });

test("the header names the branches and offers only Abort and Continue", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Merging main into pr486")).toBeVisible();
  await expect(page.getByText("3 files left")).toBeVisible();
  await expect(page.getByText(/remotes\/origin\/HEAD/)).toHaveCount(0);
  for (const name of [/^Merge/, /^Push/, /^Sync/]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue \(3 unresolved\)/ })).toBeDisabled();
  await expect(page.getByText("238 changed")).toHaveCount(0);
});

test("the list: conflicted with counts, resolved by you, and 238 merged automatically folded", async ({ page }) => {
  await open(page);
  const side = files(page);
  await expect(side.getByText("CONFLICTED · 3")).toBeVisible();
  await expect(side.locator("[data-selected]", { hasText: "app.ts" }).getByText("3", { exact: true })).toBeVisible();
  await expect(side.getByText("RESOLVED BY YOU · 1")).toBeVisible();
  await expect(side.getByText("done.ts")).toBeVisible();
  await expect(side.getByText("238 MERGED AUTOMATICALLY")).toBeVisible();
  await expect(side.getByText("src/auto/file7.ts")).toHaveCount(0);
  await expect(side.getByText(/^STAGED/)).toHaveCount(0);
  await expect(side.getByRole("button", { name: "Stage all" })).toHaveCount(0);
  await side.getByText("238 MERGED AUTOMATICALLY").click();
  await side.getByText("src/auto/file7.ts").click();
  // A file git merged itself shows its plain diff, not the conflict screen.
  await expect.poll(async () => (await callsTo(page, "diff_file")).at(-1)).toMatchObject({ path: "src/auto/file7.ts", staged: true });
  await expect(page.getByRole("group", { name: /Conflict/ })).toHaveCount(0);
});

test("each conflict is a card; picking all three saves them in order", async ({ page }) => {
  await open(page);
  await expect(page.getByText("File 1 of 4")).toBeVisible();
  await expect(page.getByText("· Conflict 1 of 3")).toBeVisible();
  // Long plain runs fold.
  await expect(page.getByText("⋯ 17 unchanged lines")).toBeVisible();
  await expect(page.getByText("⋯ 6 unchanged lines")).toBeVisible();
  await card(page, 1).getByRole("button", { name: "Keep both" }).click();
  await expect(card(page, 1).getByText("✓ Kept both")).toBeVisible();
  await expect(page.getByText("· Conflict 2 of 3")).toBeVisible();
  await card(page, 2).getByRole("button", { name: "Keep main" }).click();
  expect(await callsTo(page, "conflict_choose")).toHaveLength(0);
  await card(page, 3).getByRole("button", { name: "Keep pr486" }).click();
  await expect.poll(() => callsTo(page, "conflict_choose")).toEqual([
    { worktree: WT, path: "app.ts", choices: [{ kind: "both" }, { kind: "theirs" }, { kind: "ours" }] },
  ]);
});

test("Change undoes a pick before it's saved", async ({ page }) => {
  await open(page);
  await card(page, 1).getByRole("button", { name: "Keep pr486" }).click();
  await card(page, 1).getByRole("button", { name: "Change" }).click();
  await expect(card(page, 1).getByRole("button", { name: "Keep main" })).toBeVisible();
  await card(page, 1).getByRole("button", { name: "Keep main" }).click();
  await card(page, 2).getByRole("button", { name: "Keep main" }).click();
  await card(page, 3).getByRole("button", { name: "Keep main" }).click();
  await expect.poll(async () => (await callsTo(page, "conflict_choose"))[0]?.choices).toEqual([{ kind: "theirs" }, { kind: "theirs" }, { kind: "theirs" }]);
});

test("Edit starts from both sides and sends your text with a final newline", async ({ page }) => {
  await open(page);
  await card(page, 1).getByRole("button", { name: "Edit" }).click();
  const box = page.getByLabel("Edit conflict 1");
  await expect(box).toHaveValue("const a = 1;\nshared\nconst a = 2;\nshared\n");
  await box.fill("const a = 3;");
  await card(page, 1).getByRole("button", { name: "Use this" }).click();
  await expect(card(page, 1).getByText("✓ Edited")).toBeVisible();
  await card(page, 2).getByRole("button", { name: "Keep pr486" }).click();
  await card(page, 3).getByRole("button", { name: "Keep main" }).click();
  await expect.poll(async () => (await callsTo(page, "conflict_choose"))[0]?.choices).toEqual([{ kind: "text", text: "const a = 3;\n" }, { kind: "ours" }, { kind: "theirs" }]);
});

test("typing in Edit doesn't trigger shortcuts, and an empty side says so", async ({ page }) => {
  await open(page);
  await expect(card(page, 3).getByText("(nothing)")).toBeVisible();
  await card(page, 1).getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Edit conflict 1").press("Alt+ArrowDown");
  await expect(page.getByText("· Conflict 1 of 3")).toBeVisible();
});

test("Show original adds the base and Keep original, only where there is one", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Keep original" })).toHaveCount(0);
  await page.getByLabel("Show original").check();
  await expect(card(page, 1).getByText("const a = 0;")).toBeVisible();
  await expect(card(page, 1).getByRole("button", { name: "Keep original" })).toBeVisible();
  await expect(card(page, 2).getByRole("button", { name: "Keep original" })).toHaveCount(0);
  await card(page, 1).getByRole("button", { name: "Keep original" }).click();
  await expect(card(page, 1).getByText("✓ Kept the original")).toBeVisible();
});

test("Next conflict and ⌥↓ move through cards, then to the next file", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByText("· Conflict 2 of 3")).toBeVisible();
  await page.getByRole("button", { name: /Next conflict/ }).click();
  await expect(page.getByText("· Conflict 3 of 3")).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByText("· Conflict 2 of 3")).toBeVisible();
  // Decided cards are skipped.
  await card(page, 3).getByRole("button", { name: "Keep main" }).click();
  await card(page, 1).click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByText("· Conflict 2 of 3")).toBeVisible();
  // Nothing undecided after this one: on to the next file.
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByText("main deleted this file.")).toBeVisible();
});

test("picks survive going to another file and back", async ({ page }) => {
  await open(page);
  await card(page, 1).getByRole("button", { name: "Keep main" }).click();
  const side = files(page);
  await side.getByText("logo.png").click();
  await expect(page.getByText("Binary file. Pick a side.")).toBeVisible();
  await side.getByText("app.ts").click();
  await expect(card(page, 1).getByText("✓ Kept main")).toBeVisible();
  await expect(page.getByText("· Conflict 2 of 3")).toBeVisible();
});

test("a file that changed underneath shows the error and keeps the picks", async ({ page }) => {
  await open(page, { conflict_choose: { $error: "app.ts changed since it was opened. Reload it and pick again." } });
  for (const n of [1, 2, 3]) await card(page, n).getByRole("button", { name: "Keep main" }).click();
  await expect(page.getByText("changed since it was opened")).toBeVisible();
  await expect(card(page, 3).getByText("✓ Kept main")).toBeVisible();
});

test("deleted on one side: keep or delete the file", async ({ page }) => {
  await open(page, { conflict_take: null });
  await files(page).getByText("gone.ts").click();
  await expect(page.getByText("deleted this file.")).toContainText("main deleted this file. pr486 changed it.");
  await page.getByRole("button", { name: "Delete the file" }).click();
  await expect.poll(() => callsTo(page, "conflict_take")).toEqual([{ worktree: WT, path: "gone.ts", side: "theirs" }]);
  await page.getByRole("button", { name: "Keep the file" }).click();
  await expect.poll(async () => (await callsTo(page, "conflict_take"))[1]).toEqual({ worktree: WT, path: "gone.ts", side: "ours" });
});

test("binary: pick a side by branch name", async ({ page }) => {
  await open(page, { conflict_take: null });
  await files(page).getByText("logo.png").click();
  await page.getByRole("button", { name: "Keep main" }).click();
  await expect.poll(() => callsTo(page, "conflict_take")).toEqual([{ worktree: WT, path: "logo.png", side: "theirs" }]);
});

test("a file you resolved offers Back to conflicted and Next file", async ({ page }) => {
  await open(page, { conflict_reset: null });
  await files(page).getByText("done.ts").click();
  await expect(page.getByText("✓ Resolved")).toBeVisible();
  await expect(page.getByText("resolved text")).toBeVisible();
  await page.getByRole("button", { name: "Back to conflicted" }).click();
  await expect.poll(() => callsTo(page, "conflict_reset")).toEqual([{ worktree: WT, path: "done.ts" }]);
  await page.getByRole("button", { name: "Next file →" }).click();
  await expect(page.getByText("main deleted this file.")).toBeVisible();
});

test("Edit whole file won't save with markers left", async ({ page }) => {
  await open(page, { conflict_resolve: null });
  await page.getByRole("button", { name: "Edit whole file" }).click();
  const box = page.getByLabel("Whole file");
  await box.fill("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n");
  await expect(page.getByRole("button", { name: "Save and mark resolved" })).toBeDisabled();
  await box.fill("a\n<<<<<<<< not a marker\nx\n");
  await page.getByRole("button", { name: "Save and mark resolved" }).click();
  await expect.poll(() => callsTo(page, "conflict_resolve")).toEqual([{ worktree: WT, path: "app.ts", content: "a\n<<<<<<<< not a marker\nx\n" }]);
});

test("a rebase names your commit and the branch it's going onto", async ({ page }) => {
  await open(page, { detail_load: merging({ kind: "rebase", applied: 2, total: 5, head_label: "main", incoming_label: "pr486" }) });
  await expect(page.getByText("Rebasing pr486 onto main · commit 2 of 5")).toBeVisible();
  await expect(card(page, 1).getByText("your commit")).toBeVisible();
  await expect(card(page, 1).getByText("already there")).toBeVisible();
});

test("after the last file, Continue turns on", async ({ page }) => {
  await open(page);
  const done = merging({ conflicted: [], counts: {}, resolved: [...auto, "done.ts", "app.ts", "gone.ts", "logo.png"], resolved_by_you: ["app.ts", "done.ts", "gone.ts", "logo.png"] });
  await setReply(page, "detail_load", done);
  for (const n of [1, 2, 3]) await card(page, n).getByRole("button", { name: "Keep main" }).click();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await expect(page.getByText("All conflicts resolved")).toBeVisible();
  await expect(page.getByText("RESOLVED BY YOU · 4")).toBeVisible();
});
