# Pando: AI operating manual

Read `docs/architecture.md` first. The plan and status are the Crunchy board (project Pando, board General, via MCP). Never write a changelog or status here.

## Layout

- `crates/core` — `pando-core`. All git and worktree logic. Typed serde API.
- `crates/cli` — `pando` binary. Thin over core.
- `apps/desktop` — Tauri 2 shell + React 19 UI. Thin over core. `src/screens` (Repos, RepoScreen with RepoSidebar and CommitLog, Detail, CommitDetail, UncommittedPanel, DiffView, ConflictView), `src/dialogs`, `src/ui`, `src/lib` (api, routes, windows, graph, zoom).

## Rules

- Desktop and CLI call `pando-core` only. No git calls outside core.
- Mutations shell out to the git CLI. Reads use gix. No libgit2.
- Every public core type is serde. No raw git output crosses the API.
- Write a backup ref under `refs/pando/backup/` before any mutation.
- Git floor is 2.39. Feature-detect newer flags.
- Keep docs minimal. Plain language. No filler.
- Use git's words in the UI and CLI: "add worktree", "remove worktree", "merge", "branch". Never invent verbs (no land, open, close, workspace).
- Layout is Chris's call: Repositories table → repo page (sidebar of worktrees/branches/remote branches, commit graph on top, details below) → worktree page (same sidebar, graph scoped to its branch, staging below). Don't add screens, filters, or rails without Chris asking.
- No settings, no config file, no ports, no hooks. Pando adds nothing to a repo. New worktrees go next to the repo as `<repo>-<branch>`. Chris removed all of this on 27 Sep 2026; don't bring it back.

## Commands

`just setup`, `just dev`, `just cli <args>`, `just test`, `just lint`, `just build`.

## Gotchas

- Worktree listing uses `git worktree list --porcelain -z`, not gix. gix does not report lock or prunable state.
