# Pando: AI operating manual

Read `docs/architecture.md` first. The plan and status are the Crunchy board (project Pando, board General, via MCP). Never write a changelog or status here.

## Layout

- `crates/core` — `pando-core`. All git and worktree logic. Typed serde API.
- `crates/cli` — `pando` binary. Thin over core.
- `apps/desktop` — Tauri 2 shell + React 19 UI. Thin over core. `src/screens` (Repos, RepoScreen with RepoSidebar and CommitLog, Detail, CommitDetail, UncommittedPanel, DiffView, ConflictView, FileView, FilesPage, OverviewPage), `src/dialogs`, `src/ui`, `src/lib` (api, routes, windows, graph, zoom).

## Rules

- Desktop and CLI call `pando-core` only. No git calls outside core.
- Mutations shell out to the git CLI. Reads use gix. No libgit2.
- Every public core type is serde. No raw git output crosses the API.
- Before any change that can lose work: back up every branch that moves (`refs/pando/backup/<branch>`), and snapshot files about to be thrown away (`refs/pando/snapshots/`). See `backup.rs`.
- Only `cmd.rs` spawns git. Reads run with `GIT_OPTIONAL_LOCKS=0` so Pando never blocks the user's own git.
- Tests try to break things: failure paths, odd names, empty repos, concurrency. `crates/core/tests/common` has the helpers.
- Git floor is 2.39. Feature-detect newer flags.
- Keep docs minimal. Plain language. No filler.
- Use git's words in the UI and CLI: "add worktree", "remove worktree", "merge", "branch". Never invent verbs (no land, open, close, workspace).
- Layout is Chris's call: Repositories table → repo page (sidebar of worktrees/branches/remote branches, commit graph on top, details below) → worktree page (same sidebar, graph scoped to its branch, staging below). Don't add screens, filters, or rails without Chris asking.
- The header's `Commits | Files | Overview` toggle picks what the centre shows for whatever is picked in the sidebar (`src/lib/view.ts`). Commits is the default. Files is read-only. Overview shows what one branch is built on (`relate.rs`).
- Sidebar rows have no buttons: every action is in the row's ⋯ menu. Status says what it counts ("3 files to commit"), and names the base it compares to (`origin/main`, or one the user chose: `src/lib/base.ts`).
- No settings, no config file, no ports, no hooks. Pando adds nothing to a repo. New worktrees go next to the repo as `<repo>-<branch>`. Chris removed all of this on 27 Sep 2026; don't bring it back.

## Commands

`just setup`, `just dev`, `just cli <args>`, `just test`, `just test-real` (before releases), `just lint`, `just build`.

## Gotchas

- Worktree listing uses `git worktree list --porcelain -z`, not gix. gix does not report lock or prunable state.
- New desktop command: add it to `src-tauri/src/dev_bridge.rs` too, or `just test-real` can't call it.
- Keys go through `src/lib/keys.ts`. Dialogs and menus call `useLayer("overlay", …)`; page shortcuts check `overlayOpen()`. Never add a bare Escape listener.
- Never open GUI apps on Chris's Mac to test. Use `just test`, `just test-real`, or ask.
