# Pando: AI operating manual

Read `docs/architecture.md` first. The plan and status are the Crunchy board (project Pando, board General, via MCP). Never write a changelog or status here.

## Layout

- `crates/core` — `pando-core`. All git and worktree logic. Typed serde API.
- `crates/cli` — `pando` binary. Thin over core.
- `apps/desktop` — Tauri 2 shell + React 19 UI. Thin over core. `src/screens` (Overview, Detail, Settings), `src/dialogs`, `src/ui`.

## Rules

- Desktop and CLI call `pando-core` only. No git calls outside core.
- Mutations shell out to the git CLI. Reads use gix. No libgit2.
- Every public core type is serde. No raw git output crosses the API.
- Write a backup ref under `refs/pando/backup/` before any mutation.
- Git floor is 2.39. Feature-detect newer flags.
- Keep docs minimal. Plain language. No filler.
- Use git's words in the UI and CLI: "add worktree", "remove worktree", "merge", "branch". Never invent verbs (no land, open, close, workspace).
- One screen per repo: the branch list. Don't add sidebars, filters, or rails without Chris asking.

## Commands

`just setup`, `just dev`, `just cli <args>`, `just test`, `just lint`, `just build`.

## Gotchas

- Worktree listing uses `git worktree list --porcelain -z`, not gix. gix does not report lock or prunable state.
